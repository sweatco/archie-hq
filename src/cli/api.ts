/**
 * CLI API Client — HTTP + SSE connection to the Archie server
 */

export function getBaseUrl(): string {
  if (process.env.ARCHIE_URL) return process.env.ARCHIE_URL.replace(/\/+$/, '');
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

// ---- REST helpers ----

export async function fetchTasks(
  opts?: { limit?: number; offset?: number },
): Promise<{ tasks: any[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  const res = await fetch(`${getBaseUrl()}/api/tasks${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  const data = (await res.json()) as { tasks: any[]; total: number };
  return { tasks: data.tasks, total: data.total };
}

export async function fetchTaskDetail(taskId: string): Promise<any> {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Failed to fetch task: ${res.status}`);
  return res.json();
}

export async function createTask(message: string): Promise<string> {
  const res = await fetch(`${getBaseUrl()}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
  const data = (await res.json()) as { task_id: string };
  return data.task_id;
}

export async function sendMessage(taskId: string, message: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Failed to send message: ${res.status}`);
}

export async function fetchTaskEvents(
  taskId: string,
  after?: number,
): Promise<{ events: any[]; total: number }> {
  const url = after !== undefined
    ? `${getBaseUrl()}/api/tasks/${taskId}/events?after=${after}`
    : `${getBaseUrl()}/api/tasks/${taskId}/events`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  return res.json() as Promise<{ events: any[]; total: number }>;
}

export async function fetchTriggers(): Promise<{ triggers: any[]; total: number }> {
  const res = await fetch(`${getBaseUrl()}/api/triggers`);
  if (!res.ok) throw new Error(`Failed to fetch triggers: ${res.status}`);
  return res.json() as Promise<{ triggers: any[]; total: number }>;
}

export async function updateTrigger(
  id: string,
  patch: { status?: 'paused' | 'enabled'; action_prompt?: string },
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/triggers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update trigger: ${res.status}`);
}

export async function deleteTrigger(id: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/triggers/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete trigger: ${res.status}`);
}

export async function sendApproval(
  taskId: string,
  type: 'edit_mode' | 'research_budget' | 'merge' | 'trigger',
  approve: boolean,
  identity?: { github: string; pr_number: number },
  ref?: string,
): Promise<void> {
  // merge-type resolutions must carry the PR identity or the API 400s — this
  // was the CLI approval bug (blank screen on a merge prompt). Other types omit
  // it (backward compatible).
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      approve,
      ...(identity ? { github: identity.github, pr_number: identity.pr_number } : {}),
      ...(ref ? { ref } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Failed to send approval: ${res.status}`);
}

// ---- SSE ----

export interface SSEOptions {
  taskId?: string;
  onEvent: (event: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * Connect to SSE stream. Returns abort function.
 * Auto-reconnects on disconnect (3s delay).
 */
export function connectSSE(opts: SSEOptions): () => void {
  let aborted = false;
  let controller: AbortController | null = null;

  const connect = async () => {
    if (aborted) return;

    controller = new AbortController();
    const url = opts.taskId
      ? `${getBaseUrl()}/api/events/stream?taskId=${opts.taskId}`
      : `${getBaseUrl()}/api/events/stream`;

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }

      opts.onConnect?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              opts.onEvent(event);
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
    }

    // If aborted, this was an intentional teardown — don't fire onDisconnect
    // or attempt to reconnect (the new connection handles its own state)
    if (aborted) return;

    opts.onDisconnect?.();

    // Reconnect after delay
    setTimeout(connect, 3000);
  };

  connect();

  return () => {
    aborted = true;
    controller?.abort();
  };
}
