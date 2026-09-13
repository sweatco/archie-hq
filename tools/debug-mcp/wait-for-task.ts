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

/** Every approval type the engine raises and the API accepts on resolution. */
export const APPROVAL_TYPES = [
  'edit_mode',
  'research_budget',
  'merge',
  'trigger',
  'tool_call',
  'max_mode',
] as const;

export type ApprovalType = (typeof APPROVAL_TYPES)[number];

function isApprovalType(value: unknown): value is ApprovalType {
  return typeof value === 'string' && (APPROVAL_TYPES as readonly string[]).includes(value);
}

export interface WaitResult {
  task_id: string | null;
  state: WaitState;
  attribution: string | null;
  pm_replies: string[];
  cursor?: number;
  approval_type?: ApprovalType;
  /** Opaque id of the pending item (trigger id, tool-call digest), when the event carries one. */
  approval_ref?: string;
}

export interface WaitForTaskArgs {
  taskId?: string;
  nonce?: string;
  timeoutSeconds?: number;
  cursor?: number;
}

/**
 * The slice of ArchieClient the wait logic needs (satisfied structurally).
 *
 * Everything is read from the event log. The knowledge log used to answer the
 * "which task carries my nonce" and "what was this task asked to do" questions,
 * but it is no longer served over the API — the inbound message that carries a
 * nonce is emitted as a `message` event and persisted to `events.jsonl`, so one
 * source answers both.
 */
export interface TaskClient {
  listTasks(): Promise<Array<{ task_id: string }>>;
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

type RawEvent = { type: string; data: Record<string, unknown> };

/**
 * The first thing said TO the task — the request it was created for, which is
 * what the first knowledge-log line used to be. Inbound only (`to: 'pm-agent'`):
 * the PM's own replies are in the same stream, and attributing a task to its
 * first answer instead of its first question would be worse than nothing.
 */
function firstInboundLine(events: readonly RawEvent[]): string | null {
  for (const e of events) {
    if (e.type !== 'message' || e.data['to'] !== 'pm-agent') continue;
    const text = String(e.data['message'] ?? '').trim();
    if (!text) continue;
    return `${String(e.data['from'] ?? 'unknown')}: ${text}`.slice(0, ATTRIBUTION_MAX);
  }
  return null;
}

async function findTaskByNonce(
  client: TaskClient,
  nonce: string,
  recentWindow: number,
): Promise<string | undefined> {
  const tasks = await client.listTasks();
  for (const t of tasks.slice(0, recentWindow)) {
    try {
      const { events } = await client.getEvents(t.task_id);
      if (events.some((e) => JSON.stringify(e.data).includes(nonce))) return t.task_id;
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
          // Read from the start (no cursor) — attribution is the task's FIRST
          // inbound message, which the polling read below has usually gone past.
          const { events } = await client.getEvents(taskId);
          attribution = firstInboundLine(events);
        } catch {
          // attribution is best-effort
        }
      }

      const res = await client.getEvents(taskId, cursor);
      cursor = res.total;

      let lifecycle: 'running' | 'stopped' | 'completed' | undefined;
      let awaitingApproval = false;
      let approvalType: ApprovalType | undefined;
      let approvalRef: string | undefined;

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
            // The engine emits { text, approvalType, ref? } (src/tasks/task.ts).
            // `ref` names the exact pending item (a trigger id, a tool-call
            // digest) and must be echoed back on resolution for tool_call.
            if (isApprovalType(e.data['approvalType'])) approvalType = e.data['approvalType'];
            const ref = e.data['ref'];
            approvalRef = typeof ref === 'string' && ref ? ref : undefined;
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
      if (awaitingApproval) {
        return settle('approval_requested', {
          ...(approvalType ? { approval_type: approvalType } : {}),
          ...(approvalRef ? { approval_ref: approvalRef } : {}),
        });
      }
      if (lifecycle === 'stopped') return settle('stopped');
    }

    if (now() >= deadline) {
      return settle(taskId ? 'pending' : 'not_found');
    }

    await sleep(pollIntervalMs);
  }
}
