import http from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { OrchardRunnerProvider, serializeArgv } from '../orchard-provider.js';

describe('OrchardRunnerProvider', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let baseUrl: string;
  const requests: Array<{ method?: string; url?: string; authorization?: string; body?: unknown }> = [];

  beforeEach(async () => {
    requests.length = 0;
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
        });
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST') response.end(JSON.stringify({ name: 'vm-1', status: 'pending' }));
        else if (request.method === 'DELETE') response.end('{}');
        else if (request.url === '/vms') response.end(JSON.stringify([{ name: 'vm-1', status: 'running' }]));
        else response.end(JSON.stringify({ name: 'vm-1', status: 'running', worker: 'mac-1' }));
      });
    });
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      if (new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1').searchParams.get('session') === 'missing') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('creates, inspects, lists, and deletes Tart VMs with Basic authentication', async () => {
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    const created = await provider.provision({
      id: 'vm-1', image: `ghcr.io/example/xcode@sha256:${'a'.repeat(64)}`, os: 'darwin',
      cpu: 4, memoryMiB: 8192, diskGiB: 100, username: 'admin', password: 'guest',
      labels: { pool: 'ios' }, resources: {}, softnetAllow: ['10.0.0.0/8'],
    });
    expect(created.status).toBe('pending');
    expect(await provider.inspect('vm-1')).toMatchObject({ id: 'vm-1', status: 'running', worker: 'mac-1' });
    expect(await provider.list()).toHaveLength(1);
    await provider.release('vm-1');
    expect(requests.every((request) => request.authorization === `Basic ${Buffer.from('archie:token').toString('base64')}`)).toBe(true);
    expect(requests[0].body).toMatchObject({ runtime: 'tart', headless: false, netSoftnet: true, netSoftnetBlock: ['0.0.0.0/0'] });
  });

  it('streams reconnectable exec frames and acknowledges durable watermarks', async () => {
    const messages: string[] = [];
    wss.once('connection', (ws) => {
      ws.on('message', (data) => messages.push(data.toString()));
      ws.send(JSON.stringify({ type: 'stdout', data: Buffer.from('hello').toString('base64'), watermark: 1 }));
      ws.send(JSON.stringify({ type: 'exit', exit: { code: 0 }, watermark: 2 }));
    });
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    const events = [];
    for await (const event of provider.exec('vm-1', { argv: ['printf', "it's safe"], sessionId: 'session-1' })) events.push(event);
    expect(events).toMatchObject([
      { type: 'stdout', watermark: 1 },
      { type: 'exit', code: 0, watermark: 2 },
    ]);
    expect(Buffer.from((events[0] as { data: Uint8Array }).data).toString()).toBe('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.map((message) => JSON.parse(message))).toContainEqual({ type: 'ack', watermark: 1 });
    expect(requests[0].url).toContain('session=session-1');
    expect(new URL(requests[0].url ?? '', baseUrl).searchParams.get('command')).toBe("'printf' 'it'\\''s safe'");
  });

  it('sends command environment over stdin without exposing it in the WebSocket URL', async () => {
    const messages: Array<{ type: string; data?: string }> = [];
    wss.once('connection', (ws) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string; data?: string };
        messages.push(message);
        if (message.type === 'stdin' && message.data === '') {
          ws.send(JSON.stringify({ type: 'exit', exit: { code: 0 }, watermark: 1 }));
        }
      });
    });
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    for await (const _event of provider.exec('vm-1', {
      argv: ['/usr/bin/printenv', 'RUNNER_SECRET'],
      env: { RUNNER_SECRET: "it's hidden" },
      sessionId: 'session-env',
    })) {}

    const url = requests[0].url ?? '';
    expect(url).not.toContain('RUNNER_SECRET');
    expect(url).not.toContain('hidden');
    expect(new URL(url, baseUrl).searchParams.get('command')).toBe("'/bin/sh' '-s'");
    const scriptFrame = messages.find((message) => message.type === 'stdin' && message.data);
    expect(Buffer.from(scriptFrame?.data ?? '', 'base64').toString()).toContain("export RUNNER_SECRET='it'\\''s hidden'");
  });

  it('finishes the private environment bootstrap before an immediate detach', async () => {
    const messageTypes: string[] = [];
    wss.once('connection', (ws) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string; data?: string };
        messageTypes.push(message.type === 'stdin' && message.data === '' ? 'stdin-eof' : message.type);
        if (message.type === 'detach') ws.close();
      });
    });
    const controller = new AbortController();
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    const consume = async () => {
      for await (const _event of provider.exec('vm-1', {
        argv: ['/usr/bin/printenv', 'RUNNER_SECRET'],
        env: { RUNNER_SECRET: 'hidden' },
        sessionId: 'session-detach',
        signal: controller.signal,
      })) {}
    };

    const pending = consume();
    controller.abort();
    await pending;
    expect(messageTypes).toEqual(['stdin', 'stdin-eof', 'detach']);
  });

  it('does not stream ordinary stdin after an immediate detach', async () => {
    const messageTypes: string[] = [];
    wss.once('connection', (ws) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string; data?: string };
        messageTypes.push(message.type === 'stdin' && message.data === '' ? 'stdin-eof' : message.type);
        if (message.type === 'detach') ws.close();
      });
    });
    const controller = new AbortController();
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    const consume = async () => {
      for await (const _event of provider.exec('vm-1', {
        argv: ['/bin/sh', '-s'],
        env: {},
        stdin: (async function* () { yield Buffer.from('echo should-not-run\n'); })(),
        sessionId: 'session-stdin-detach',
        signal: controller.signal,
      })) {}
    };

    const pending = consume();
    controller.abort();
    await pending;
    expect(messageTypes).toEqual(['detach']);
  });

  it('bounds a stalled WebSocket handshake', async () => {
    let stalledSocket: Duplex | undefined;
    server.removeAllListeners('upgrade');
    server.on('upgrade', (_request, socket) => { stalledSocket = socket; });
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token', 20);
    const consume = async () => {
      for await (const _event of provider.exec('vm-1', { argv: ['/usr/bin/true'], sessionId: 'stalled' })) {}
    };

    try {
      await expect(consume()).rejects.toThrow(/Timed out opening Orchard exec session/);
    } finally {
      stalledSocket?.destroy();
    }
  });

  it('treats closing an absent exec session as idempotent', async () => {
    const provider = new OrchardRunnerProvider(baseUrl, 'archie', 'token');
    await expect(provider.closeExec('vm-1', 'missing')).resolves.toBeUndefined();
  });
});

describe('serializeArgv', () => {
  it('quotes every POSIX argument', () => {
    expect(serializeArgv(['a b', "c'd", '$HOME'])).toBe("'a b' 'c'\\''d' '$HOME'");
  });
});
