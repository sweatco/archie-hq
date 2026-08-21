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
  private bufferedBytes = 0;

  constructor(
    private readonly maxBufferedBytes: number,
    private readonly measure: (value: T) => number,
  ) {}

  push(value: T): boolean {
    if (this.ended || this.failure) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      const bytes = this.measure(value);
      if (this.bufferedBytes + bytes > this.maxBufferedBytes) {
        this.fail(new Error(`Orchard exec buffered more than ${this.maxBufferedBytes} bytes`));
        return false;
      }
      this.values.push(value);
      this.bufferedBytes += bytes;
    }
    return true;
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    this.values = [];
    this.bufferedBytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.bufferedBytes -= this.measure(value);
      return Promise.resolve({ value, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

const MAX_EXEC_QUEUE_BYTES = 8 * 1024 * 1024;
const ORCHARD_STDIN_CHUNK_BYTES = 16 * 1024;

function eventBytes(event: ExecEvent): number {
  if (event.type === 'stdout' || event.type === 'stderr') return event.data.byteLength;
  if (event.type === 'error') return Buffer.byteLength(event.error);
  return 64;
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

function withPrivateEnvironment(request: ExecRequest): ExecRequest {
  const entries = Object.entries(request.env ?? {});
  if (entries.length === 0) return request;
  if (!request.argv) throw new Error('Environment variables require a command');
  if (request.stdin) throw new Error('Environment variables and streaming stdin cannot be combined');
  const script = `${entries.map(([key, value]) => `export ${key}=${serializeArgv([value])}`).join('\n')}\nexec ${serializeArgv(request.argv)}\n`;
  return {
    ...request,
    argv: ['/bin/sh', '-s'],
    env: undefined,
    stdin: (async function* () { yield Buffer.from(script); })(),
  };
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
        ...(spec.networkMode === 'softnet' ? {
          netSoftnet: true,
          netSoftnetAllow: spec.softnetAllow,
          netSoftnetBlock: ['0.0.0.0/0'],
        } : {}),
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
    return url;
  }

  async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
    if (!request.argv && request.reconnectFrom === undefined) throw new Error('A command or reconnect watermark is required');
    const hasPrivateEnvironment = Object.keys(request.env ?? {}).length > 0;
    const wireRequest = withPrivateEnvironment(request);
    const queue = new AsyncEventQueue<ExecEvent>(MAX_EXEC_QUEUE_BYTES, eventBytes);
    const ws = new WebSocket(this.execUrl(id, wireRequest), { headers: { authorization: this.authorization }, maxPayload: 4 * 1024 * 1024 });
    let terminal = false;
    let opened = false;
    let bootstrapComplete = false;
    let detachRequested = false;
    let receivedWatermark = wireRequest.reconnectFrom ?? 0;
    const handshakeTimer = setTimeout(() => {
      queue.fail(new Error(`Timed out opening Orchard exec session ${request.sessionId}`));
      ws.terminate();
    }, this.requestTimeoutMs);

    const send = (frame: object) => new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
    });
    const detach = () => {
      detachRequested = true;
      if (ws.readyState === WebSocket.CONNECTING || (opened && !bootstrapComplete)) return;
      if (ws.readyState === WebSocket.OPEN && !terminal) {
        ws.send(JSON.stringify({ type: 'detach' }), () => ws.close());
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
    const onAbort = () => detach();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    ws.once('open', () => {
      clearTimeout(handshakeTimer);
      opened = true;
      void (async () => {
        if (wireRequest.reconnectFrom !== undefined) {
          await send({ type: 'history', watermark: wireRequest.reconnectFrom });
        }
        if (wireRequest.stdin) {
          for await (const chunk of wireRequest.stdin) {
            if (ws.readyState !== WebSocket.OPEN || (request.signal?.aborted && !hasPrivateEnvironment)) return;
            const data = Buffer.from(chunk);
            for (let offset = 0; offset < data.length; offset += ORCHARD_STDIN_CHUNK_BYTES) {
              if (ws.readyState !== WebSocket.OPEN || (request.signal?.aborted && !hasPrivateEnvironment)) return;
              await send({ type: 'stdin', data: data.subarray(offset, offset + ORCHARD_STDIN_CHUNK_BYTES).toString('base64') });
            }
          }
          if (ws.readyState !== WebSocket.OPEN) return;
          await send({ type: 'stdin', data: '' });
          if (!queue.push({ type: 'bootstrap_complete' })) ws.terminate();
        }
      })().catch((error) => queue.fail(error)).finally(() => {
        bootstrapComplete = true;
        if (detachRequested) detach();
      });
    });
    if (request.signal?.aborted) detach();

    ws.on('message', (raw: RawData) => {
      try {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        const watermark = frame.watermark === undefined
          ? undefined
          : typeof frame.watermark === 'number' && Number.isSafeInteger(frame.watermark) && frame.watermark >= 0
            ? frame.watermark
            : (() => { throw new Error('Invalid Orchard exec watermark'); })();
        if (frame.type === 'stdout' || frame.type === 'stderr') {
          if (watermark === undefined) throw new Error(`Missing Orchard exec watermark for ${frame.type}`);
          if (watermark !== receivedWatermark + 1) {
            throw new Error(`Orchard exec history gap: expected watermark ${receivedWatermark + 1}, received ${watermark}`);
          }
          receivedWatermark = watermark;
          if (!queue.push({ type: frame.type, data: Buffer.from(String(frame.data ?? ''), 'base64'), watermark })) ws.terminate();
        } else if (frame.type === 'exit') {
          if (watermark === undefined) throw new Error('Missing Orchard exec watermark for exit');
          if (watermark !== receivedWatermark + 1) {
            throw new Error(`Orchard exec history gap: expected watermark ${receivedWatermark + 1}, received ${watermark}`);
          }
          receivedWatermark = watermark;
          terminal = true;
          const exit = frame.exit as { code?: unknown } | undefined;
          if (typeof exit?.code !== 'number' || !Number.isSafeInteger(exit.code)) throw new Error('Invalid Orchard exec exit code');
          if (!queue.push({ type: 'exit', code: exit.code, watermark })) ws.terminate();
        } else if (frame.type === 'error') {
          if (watermark === undefined) throw new Error('Missing Orchard exec watermark for error');
          if (watermark !== receivedWatermark + 1) {
            throw new Error(`Orchard exec history gap: expected watermark ${receivedWatermark + 1}, received ${watermark}`);
          }
          receivedWatermark = watermark;
          terminal = true;
          if (!queue.push({ type: 'error', error: String(frame.error ?? 'Unknown Orchard exec error'), watermark })) ws.terminate();
        } else if (frame.type === 'no_more_history') {
          const historyWatermark = watermark ?? 0;
          if (historyWatermark !== receivedWatermark) {
            throw new Error(`Orchard exec history gap: expected watermark ${receivedWatermark}, history ended at ${historyWatermark}`);
          }
          if (!queue.push({ type: 'history_end', watermark: historyWatermark })) ws.terminate();
        }
      } catch (error) {
        queue.fail(error);
        ws.terminate();
      }
    });
    ws.once('error', (error) => {
      clearTimeout(handshakeTimer);
      queue.fail(error);
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(handshakeTimer);
      response.resume();
      queue.fail(new OrchardRequestError(`Orchard WebSocket exec failed (${response.statusCode ?? 0})`, response.statusCode ?? 0));
    });
    ws.once('close', () => {
      clearTimeout(handshakeTimer);
      queue.end();
    });

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
      clearTimeout(handshakeTimer);
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
        if (response.statusCode === 404) {
          ws.terminate();
          resolve();
          return;
        }
        reject(new OrchardRequestError(`Orchard WebSocket close failed (${response.statusCode ?? 0})`, response.statusCode ?? 0));
      });
    });
  }
}
