/**
 * Archie HTTP Client — self-contained, no imports from src/
 *
 * Talks to the Archie REST API at /api/*. Ejectable: copy this file
 * and server.ts anywhere, install deps, point ARCHIE_URL at your server.
 */

// ---- Local types (not imported from src/types/) ----

/**
 * A row of `GET /api/tasks`. One PM runs a task, so there is no owner and no
 * agent roster to report; the list carries identity and where the task lives.
 */
export interface TaskSummary {
  task_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  channel_name: string | null;
  reminder?: unknown;
}

/**
 * `GET /api/tasks/:id`. Returns the metadata only — the knowledge log is not
 * served (it is a write-only record now), so transcript-shaped questions are
 * answered from the event log instead.
 *
 * `agent_sessions` holds one entry, keyed by the PM's agent key; a legacy
 * on-disk value can still be a bare session-id string.
 */
export interface TaskDetail {
  metadata: {
    task_id: string;
    status: string;
    channels: Record<string, unknown>;
    agent_sessions: Record<string, { active?: boolean; session_id?: string } | string>;
    edit_allowed?: boolean;
    title?: string | null;
    created_at: string;
    updated_at: string;
  };
}

export interface TaskEvent {
  type: string;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

export interface EventsResult {
  events: TaskEvent[];
  total: number;
}

/**
 * Render one event as a transcript line, or null for events that carry no prose
 * (lifecycle, approvals, activity).
 *
 * This is the replacement for reading knowledge.log over the API: the log is no
 * longer served, but every line that mattered to an observer — inbound
 * messages, the PM's replies, system findings — is also emitted as an event and
 * persisted to `events.jsonl`. Same content, one source.
 */
export function renderEventLine(e: TaskEvent): string | null {
  if (e.type === 'message') {
    const from = String(e.data['from'] ?? 'unknown');
    const to = String(e.data['destination'] ?? e.data['to'] ?? '');
    const where = to ? ` in ${to}` : '';
    return `[${e.timestamp}] [${from}${where}] ${String(e.data['message'] ?? '')}`;
  }
  if (e.type === 'agent:log') {
    const type = e.data['type'] ? ` [${String(e.data['type'])}]` : '';
    return `[${e.timestamp}] [${e.agentName ?? 'system'}]${type} ${String(e.data['finding'] ?? '')}`;
  }
  return null;
}

// ---- Client ----

export class ArchieClient {
  constructor(private baseUrl: string) {}

  async createTask(message: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Failed to create task: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { task_id: string };
    return data.task_id;
  }

  async listTasks(): Promise<TaskSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/tasks`);
    if (!res.ok) throw new Error(`Failed to list tasks: ${res.status}`);
    const data = (await res.json()) as { tasks: TaskSummary[] };
    return data.tasks;
  }

  async getTaskDetail(taskId: string): Promise<TaskDetail> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error(`Failed to get task: ${res.status}`);
    return (await res.json()) as TaskDetail;
  }

  async sendMessage(taskId: string, message: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Failed to send message: ${res.status} ${await res.text()}`);
  }

  async getEvents(taskId: string, after?: number): Promise<EventsResult> {
    const url = after !== undefined
      ? `${this.baseUrl}/api/tasks/${taskId}/events?after=${after}`
      : `${this.baseUrl}/api/tasks/${taskId}/events`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to get events: ${res.status}`);
    return (await res.json()) as EventsResult;
  }

  async approve(
    taskId: string,
    type: string,
    approve: boolean,
    // PR identity for merge-type approvals, forwarded verbatim in the request
    // body (the API requires github + pr_number when type is "merge").
    pr?: { github?: string; pr_number?: number },
  ): Promise<{ stale: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, approve, github: pr?.github, pr_number: pr?.pr_number }),
    });
    if (res.ok) return { stale: false };
    const text = await res.text();
    // A 409 {stale: true} is a semantic outcome, not a transport failure: the
    // merge resolution missed the pending request (empty/mismatched slot) and
    // nothing was resolved. Surface it as data so the tool can report it.
    if (res.status === 409) {
      try {
        const body = JSON.parse(text) as { stale?: boolean };
        if (body.stale) return { stale: true };
      } catch {
        // Not our stale shape — fall through to the generic error.
      }
    }
    throw new Error(`Failed to send approval: ${res.status} ${text}`);
  }
}
