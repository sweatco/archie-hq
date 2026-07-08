/**
 * Archie HTTP Client — self-contained, no imports from src/
 *
 * Talks to the Archie REST API at /api/*. Ejectable: copy this file
 * and server.ts anywhere, install deps, point ARCHIE_URL at your server.
 */

// ---- Local types (not imported from src/types/) ----

export interface TaskSummary {
  task_id: string;
  status: string;
  task_owner: string | null;
  participants: string[];
  created_at: string;
  updated_at: string;
  agents: AgentStatus[];
}

export interface AgentStatus {
  id: string;
  active: boolean;
  session_id?: string;
}

export interface TaskDetail {
  metadata: {
    task_id: string;
    status: string;
    task_owner: string | null;
    participants: string[];
    channels: Record<string, unknown>;
    agent_sessions: Record<string, { active: boolean; session_id?: string }>;
    edit_allowed?: boolean;
    created_at: string;
    updated_at: string;
  };
  knowledgeLog: string;
  agents: AgentStatus[];
}

export interface EventsResult {
  events: Array<{
    type: string;
    taskId: string;
    timestamp: string;
    agentName?: string;
    data: Record<string, unknown>;
  }>;
  total: number;
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
