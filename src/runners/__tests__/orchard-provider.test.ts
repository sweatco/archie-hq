import http from 'node:http';
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
});

describe('serializeArgv', () => {
  it('quotes every POSIX argument', () => {
    expect(serializeArgv(['a b', "c'd", '$HOME'])).toBe("'a b' 'c'\\''d' '$HOME'");
  });
});
