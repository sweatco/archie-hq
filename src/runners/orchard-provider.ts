import WebSocket, { type RawData } from 'ws';
import type { ExecEvent, ExecRequest, RunnerInstance, RunnerProvider, RunnerSpec } from './types.js';

interface OrchardVM {
  name: string;
  status: 'pending' | 'running' | 'failed';
  status_message?: string;
  worker?: string;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private failure?: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

export class OrchardRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OrchardRequestError';
  }
}

function toInstance(vm: OrchardVM): RunnerInstance {
  return { id: vm.name, status: vm.status, statusMessage: vm.status_message, worker: vm.worker };
}

export function serializeArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('argv must not be empty');
  return argv.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
}

export class OrchardRunnerProvider implements RunnerProvider {
  private readonly authorization: string;

  constructor(
    private readonly baseUrl: string,
    serviceAccountName: string,
    serviceAccountToken: string,
    private readonly requestTimeoutMs = 30000,
  ) {
    this.authorization = `Basic ${Buffer.from(`${serviceAccountName}:${serviceAccountToken}`).toString('base64')}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: this.authorization,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new OrchardRequestError(`Orchard ${init.method ?? 'GET'} ${path} failed (${response.status})`, response.status);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
    const text = await response.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }

  async provision(spec: RunnerSpec): Promise<RunnerInstance> {
    const vm = await this.request<OrchardVM>('/vms', {
      method: 'POST',
      body: JSON.stringify({
        name: spec.id,
        os: spec.os,
        arch: 'arm64',
        runtime: 'tart',
        image: spec.image,
        imagePullPolicy: 'IfNotPresent',
        cpu: spec.cpu,
        memory: spec.memoryMiB,
        diskSize: spec.diskGiB,
        username: spec.username,
        password: spec.password,
        headless: false,
        restart_policy: 'Never',
        resources: spec.resources,
        labels: spec.labels,
        netSoftnet: true,
        netSoftnetAllow: spec.softnetAllow,
        netSoftnetBlock: ['0.0.0.0/0'],
      }),
    });
    return toInstance(vm);
  }

  async inspect(id: string): Promise<RunnerInstance | null> {
    try {
      return toInstance(await this.request<OrchardVM>(`/vms/${encodeURIComponent(id)}`));
    } catch (error) {
      if (error instanceof OrchardRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async list(): Promise<RunnerInstance[]> {
    return (await this.request<OrchardVM[]>('/vms')).map(toInstance);
  }

  async release(id: string): Promise<void> {
    try {
      await this.request(`/vms/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof OrchardRequestError && error.status === 404)) throw error;
    }
  }

  private execUrl(id: string, request: ExecRequest): URL {
    const url = new URL(`${this.baseUrl}/vms/${encodeURIComponent(id)}/exec`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', request.sessionId);
    url.searchParams.set('wait', '30');
    if (request.argv) url.searchParams.set('command', serializeArgv(request.argv));
    if (request.stdin) url.searchParams.set('interactive', 'true');
    if (request.cwd) url.searchParams.set('workdir', request.cwd);
    for (const [key, value] of Object.entries(request.env ?? {})) {
      url.searchParams.set(`env[${key}]`, value);
    }
    return url;
  }

  async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
    if (!request.argv && request.reconnectFrom === undefined) throw new Error('A command or reconnect watermark is required');
    const queue = new AsyncEventQueue<ExecEvent>();
    const ws = new WebSocket(this.execUrl(id, request), { headers: { authorization: this.authorization }, maxPayload: 4 * 1024 * 1024 });
    let terminal = false;
    let opened = false;

    const send = (frame: object) => new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
    });
    const detach = () => {
      if (opened && ws.readyState === WebSocket.OPEN && !terminal) {
        ws.send(JSON.stringify({ type: 'detach' }), () => ws.close());
      } else if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
    const onAbort = () => detach();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    ws.once('open', () => {
      opened = true;
      void (async () => {
        if (request.reconnectFrom !== undefined) {
          await send({ type: 'history', watermark: request.reconnectFrom });
        }
        if (request.stdin) {
          for await (const chunk of request.stdin) {
            if (request.signal?.aborted || ws.readyState !== WebSocket.OPEN) return;
            await send({ type: 'stdin', data: Buffer.from(chunk).toString('base64') });
          }
          if (ws.readyState === WebSocket.OPEN) await send({ type: 'stdin', data: '' });
        }
      })().catch((error) => queue.fail(error));
    });

    ws.on('message', (raw: RawData) => {
      try {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        const watermark = typeof frame.watermark === 'number' ? frame.watermark : undefined;
        if (frame.type === 'stdout' || frame.type === 'stderr') {
          queue.push({ type: frame.type, data: Buffer.from(String(frame.data ?? ''), 'base64'), watermark });
        } else if (frame.type === 'exit') {
          terminal = true;
          const exit = frame.exit as { code?: unknown } | undefined;
          queue.push({ type: 'exit', code: Number(exit?.code ?? -1), watermark });
        } else if (frame.type === 'error') {
          terminal = true;
          queue.push({ type: 'error', error: String(frame.error ?? 'Unknown Orchard exec error'), watermark });
        } else if (frame.type === 'no_more_history' && watermark !== undefined) {
          queue.push({ type: 'history_end', watermark });
        }
      } catch (error) {
        queue.fail(error);
      }
    });
    ws.once('error', (error) => queue.fail(error));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      queue.fail(new OrchardRequestError(`Orchard WebSocket exec failed (${response.statusCode ?? 0})`, response.statusCode ?? 0));
    });
    ws.once('close', () => queue.end());

    try {
      while (true) {
        const result = await queue.next();
        if (result.done) break;
        yield result.value;
        const watermark = 'watermark' in result.value ? result.value.watermark : undefined;
        if (watermark !== undefined && ws.readyState === WebSocket.OPEN) {
          await send({ type: 'ack', watermark });
        }
        if (result.value.type === 'exit' || result.value.type === 'error') {
          if (ws.readyState === WebSocket.OPEN) ws.close();
          break;
        }
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      detach();
    }
  }

  async closeExec(id: string, sessionId: string): Promise<void> {
    const url = this.execUrl(id, { sessionId, reconnectFrom: 0 });
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: this.authorization }, maxPayload: 4 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out closing Orchard exec session ${sessionId}`));
      }, this.requestTimeoutMs);
      ws.once('open', () => ws.send(JSON.stringify({ type: 'close' })));
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        reject(new OrchardRequestError(`Orchard WebSocket close failed (${response.statusCode ?? 0})`, response.statusCode ?? 0));
      });
    });
  }
}
