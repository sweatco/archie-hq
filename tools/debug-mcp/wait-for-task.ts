/**
 * wait_for_task core — bounded, resumable waiting for an Archie task to reach a
 * terminal/actionable state. Pure logic over a minimal TaskClient surface so it can
 * be unit-tested with a fake; the real ArchieClient satisfies TaskClient structurally.
 */

export type WaitState =
  | 'completed'
  | 'stopped'
  | 'approval_requested'
  | 'pending'
  | 'not_found';

export type ApprovalType = 'edit_mode' | 'research_budget';

export interface WaitResult {
  task_id: string | null;
  state: WaitState;
  attribution: string | null;
  pm_replies: string[];
  cursor?: number;
  approval_type?: ApprovalType;
}

export interface WaitForTaskArgs {
  taskId?: string;
  nonce?: string;
  timeoutSeconds?: number;
  cursor?: number;
}

/** The slice of ArchieClient the wait logic needs (satisfied structurally). */
export interface TaskClient {
  listTasks(): Promise<Array<{ task_id: string }>>;
  getTaskDetail(taskId: string): Promise<{ knowledgeLog: string }>;
  getEvents(
    taskId: string,
    after?: number,
  ): Promise<{ events: Array<{ type: string; data: Record<string, unknown> }>; total: number }>;
}

export interface WaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on a single call's wait, kept below the MCP client tool-call timeout. */
  capSeconds?: number;
  pollIntervalMs?: number;
  /** How many most-recent tasks to scan when correlating by nonce. */
  recentWindow?: number;
}

const DEFAULT_CAP_SECONDS = 45;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_RECENT_WINDOW = 25;
const ATTRIBUTION_MAX = 512;

function firstNonEmptyLine(log: string): string | null {
  const line = log.split('\n').find((s) => s.trim().length > 0);
  return line ? line.slice(0, ATTRIBUTION_MAX) : null;
}

async function findTaskByNonce(
  client: TaskClient,
  nonce: string,
  recentWindow: number,
): Promise<string | undefined> {
  const tasks = await client.listTasks();
  for (const t of tasks.slice(0, recentWindow)) {
    try {
      const { knowledgeLog } = await client.getTaskDetail(t.task_id);
      if (knowledgeLog.includes(nonce)) return t.task_id;
    } catch {
      // task vanished or unreadable mid-scan — skip it
    }
  }
  return undefined;
}

/** Resolve a task (by id or nonce) and block until it settles or the wait cap is hit. */
export async function waitForTask(
  client: TaskClient,
  args: WaitForTaskArgs,
  deps: WaitDeps = {},
): Promise<WaitResult> {
  if (!args.taskId && !args.nonce) {
    throw new Error('wait_for_task requires either "task_id" or "nonce"');
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const capSeconds = deps.capSeconds ?? DEFAULT_CAP_SECONDS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const recentWindow = deps.recentWindow ?? DEFAULT_RECENT_WINDOW;

  const budgetSeconds = Math.min(args.timeoutSeconds ?? capSeconds, capSeconds);
  const deadline = now() + budgetSeconds * 1000;

  let taskId = args.taskId;
  let cursor = args.cursor;
  let attribution: string | null = null;
  let attributionTried = false;
  const pmReplies: string[] = [];

  const settle = (state: WaitState, extra?: Partial<WaitResult>): WaitResult => ({
    task_id: taskId ?? null,
    state,
    attribution,
    pm_replies: pmReplies,
    cursor,
    ...extra,
  });

  for (;;) {
    if (!taskId && args.nonce) {
      taskId = await findTaskByNonce(client, args.nonce, recentWindow);
    }

    if (taskId) {
      if (!attributionTried) {
        attributionTried = true;
        try {
          const { knowledgeLog } = await client.getTaskDetail(taskId);
          attribution = firstNonEmptyLine(knowledgeLog);
        } catch {
          // attribution is best-effort
        }
      }

      const res = await client.getEvents(taskId, cursor);
      cursor = res.total;

      let lifecycle: 'running' | 'stopped' | 'completed' | undefined;
      let awaitingApproval = false;
      let approvalType: ApprovalType | undefined;

      for (const e of res.events) {
        switch (e.type) {
          case 'task:created':
          case 'task:resumed':
            lifecycle = 'running';
            awaitingApproval = false;
            break;
          case 'task:stopped':
            lifecycle = 'stopped';
            break;
          case 'task:completed':
            lifecycle = 'completed';
            awaitingApproval = false;
            break;
          case 'approval:requested': {
            awaitingApproval = true;
            // The engine emits { text, approvalType } (src/tasks/task.ts).
            const ty = e.data['approvalType'];
            if (ty === 'edit_mode' || ty === 'research_budget') approvalType = ty;
            break;
          }
          case 'approval:resolved':
            awaitingApproval = false;
            break;
          case 'message':
            if (e.data['from'] === 'pm-agent') pmReplies.push(String(e.data['message'] ?? ''));
            break;
        }
      }

      if (lifecycle === 'completed') return settle('completed');
      if (awaitingApproval) return settle('approval_requested', approvalType && { approval_type: approvalType });
      if (lifecycle === 'stopped') return settle('stopped');
    }

    if (now() >= deadline) {
      return settle(taskId ? 'pending' : 'not_found');
    }

    await sleep(pollIntervalMs);
  }
}
