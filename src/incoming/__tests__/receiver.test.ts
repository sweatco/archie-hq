// SPDX-License-Identifier: AGPL-3.0-or-later
/** The callback route over a real Express app, SQLite file and sealed secrets; state is read through a second connection. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn() }));

import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { createInput, deleteInput, rotateKey } from '../inputs.js';
import { lastRefusedDelivery } from '../refusals.js';
import { mountIncomingReceiver } from '../receiver.js';
import { vaultInputSecrets, type InputSecrets } from '../secrets.js';
import { IncomingStore } from '../store.js';
import type { ConsumerMatch, IncomingConsumer, Input, PointerCheck } from '../types.js';

const require = createRequire(import.meta.url);
const express = require('express') as typeof import('express');

const MARKER = 'RAW-BODY-MARKER-7f3a91';
const MAX_BODY_BYTES = 8192;
const LIMITS = { inputCapacityBytes: 4096, workspaceCapacityBytes: 6000 };
const ROUTINE: ConsumerMatch = { consumerId: 'trg-1', snapshot: '{"prompt":"summarize"}' };
const EVENT = JSON.stringify({ type: 'meeting.ended', note: MARKER });

interface Sender {
  input: Input;
  secret: string;
}

let root: string;
let dbPath: string;
let secretsDir: string;
let store: IncomingStore;
let secrets: InputSecrets;
let server: Server;
let baseUrl: string;
let matched: { routine: ConsumerMatch[]; proactivity: ConsumerMatch[] };
/** Stands in for an operator action that lands while a request is in flight. */
let whileMatching: () => void;

function consumer(kind: 'routine' | 'proactivity'): IncomingConsumer {
  return {
    kind,
    match: () => {
      whileMatching();
      return matched[kind];
    },
    handle: () => Promise.resolve({ state: 'accepted' }),
  };
}

function signedSender(filter?: PointerCheck[]): Promise<Sender> {
  return createInput({ store, secrets }, { auth: 'standard_webhooks', filter });
}

function bearerSender(): Promise<Sender> {
  return createInput({ store, secrets }, { auth: 'bearer' });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(secret: string, id: string, timestamp: number, body: string | Buffer): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body);
  return `v1,${mac.digest('base64')}`;
}

function post(
  inputId: string,
  body: string | Buffer | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/incoming/${inputId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : body && new Uint8Array(body),
  });
}

function deliverSigned(
  sender: Sender,
  body: string | Buffer,
  id = 'msg_1',
  overrides: Record<string, string> = {},
): Promise<Response> {
  const timestamp = nowSeconds();
  return post(sender.input.id, body, {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': sign(sender.secret, id, timestamp, body),
    ...overrides,
  });
}

function deliverBearer(
  sender: Sender,
  body: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  return post(sender.input.id, body, { authorization: `Bearer ${sender.secret}`, ...headers });
}

/** Sends a hand-written HTTP request, for cases beyond what `fetch` produces. */
function rawRequest(lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
    let response = '';
    // `Connection: close` makes the server answer and close; the socket stays open until then.
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += String(chunk);
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

const replySchema = z.object({
  receipt_id: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

async function replyOf(response: Response) {
  return replySchema.parse(await response.json());
}

function inbox() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      receipts: db.prepare('SELECT * FROM receipts ORDER BY rowid').all(),
      payloads: db.prepare('SELECT receipt_id, hex(body) AS body FROM payloads').all(),
      handoffs: db.prepare('SELECT * FROM handoffs ORDER BY consumer_kind, consumer_id').all(),
    };
  } finally {
    db.close();
  }
}

function hex(body: string): string {
  return Buffer.from(body).toString('hex').toUpperCase();
}

function loggedText(): string {
  return [logger.system, logger.error, logger.warn, logger.plain]
    .flatMap((log) => vi.mocked(log).mock.calls.flat())
    .map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : String(value)))
    .join('\n');
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getIsShuttingDown).mockReturnValue(false);
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));

  root = mkdtempSync(join(tmpdir(), 'archie-incoming-'));
  dbPath = join(root, 'state.sqlite');
  secretsDir = join(root, 'secrets');
  store = new IncomingStore(dbPath, LIMITS);
  secrets = vaultInputSecrets(secretsDir);
  matched = { routine: [ROUTINE], proactivity: [] };
  whileMatching = () => {};

  const app = express();
  mountIncomingReceiver(app, {
    store,
    secrets,
    consumers: [consumer('routine'), consumer('proactivity')],
    maxBodyBytes: MAX_BODY_BYTES,
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('an authenticated delivery', () => {
  it('is answered 202 only after its receipt, payload and handoff are committed', async () => {
    const sender = await signedSender();

    const response = await deliverSigned(sender, EVENT, 'msg_a');

    expect(response.status).toBe(202);
    const reply = await replyOf(response);
    expect(reply.status).toBe('accepted');
    expect(reply.receipt_id).toMatch(/^rcp-/);

    // Closing the writer and reopening the file shows what survives a restart.
    store.close();
    store = new IncomingStore(dbPath, LIMITS);
    expect(store.receipt(reply.receipt_id ?? '')).toMatchObject({
      inputId: sender.input.id,
      inputRevision: 1,
      binding: 'generic',
      eventKey: 'msg_a',
      digest: createHash('sha256').update(EVENT).digest('hex'),
      outcome: 'open',
      ignoredReason: null,
      conflicts: 0,
    });
    const { payloads, handoffs } = inbox();
    expect(payloads).toEqual([{ receipt_id: reply.receipt_id, body: hex(EVENT) }]);
    expect(handoffs).toMatchObject([
      {
        receipt_id: reply.receipt_id,
        consumer_kind: 'routine',
        consumer_id: 'trg-1',
        snapshot: ROUTINE.snapshot,
        state: 'pending',
        attempts: 0,
        token: null,
        reservation: null,
      },
    ]);
  });

  it('is accepted with a bearer token', async () => {
    const sender = await bearerSender();

    const response = await deliverBearer(sender, EVENT);

    expect(response.status).toBe(202);
    expect(inbox().payloads).toHaveLength(1);
  });

  it('is accepted with a leading byte-order mark and stored exactly as received', async () => {
    const sender = await signedSender();
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EVENT)]);

    const response = await deliverSigned(sender, marked);

    expect(response.status).toBe(202);
    expect(inbox().payloads).toMatchObject([{ body: marked.toString('hex').toUpperCase() }]);
  });

  it('is judged exactly as parsed, including a `__proto__` key', async () => {
    const sender = await signedSender([{ pointer: '/__proto__/kind', op: 'equals', value: 'x' }]);

    const response = await deliverSigned(sender, '{"__proto__":{"kind":"x"}}');

    expect(response.status).toBe(202);
  });

  it('needs the new key from the first delivery after a rotation', async () => {
    const sender = await signedSender();
    const rotation = await rotateKey({ store, secrets }, { kind: 'operator' }, sender.input.id);
    if (rotation.status !== 'rotated') throw new Error('expected the rotation to succeed');

    const withOldKey = await deliverSigned(sender, EVENT);
    const withNewKey = await deliverSigned({ ...sender, secret: rotation.secret }, EVENT, 'msg_2');

    expect(withOldKey.status).toBe(401);
    expect(withNewKey.status).toBe(202);
  });

  it('gets one handoff per matching consumer and a single payload', async () => {
    const sender = await signedSender();
    matched = {
      routine: [ROUTINE, { consumerId: 'trg-2', snapshot: '{"prompt":"file a ticket"}' }],
      proactivity: [{ consumerId: 'proactivity', snapshot: '{}' }],
    };

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(202);
    const { payloads, handoffs } = inbox();
    expect(payloads).toHaveLength(1);
    expect(handoffs.map((handoff) => [handoff.consumer_kind, handoff.consumer_id])).toEqual([
      ['proactivity', 'proactivity'],
      ['routine', 'trg-1'],
      ['routine', 'trg-2'],
    ]);
  });
});

describe('a rejected delivery starts no work', () => {
  const stale = () => nowSeconds() - 6 * 60;
  const early = () => nowSeconds() + 6 * 60;
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"note":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const oversized = JSON.stringify({ note: 'x'.repeat(MAX_BODY_BYTES) });

  const cases: Array<{
    name: string;
    status: number;
    error: string;
    send: (signed: Sender, bearer: Sender) => Promise<Response>;
  }> = [
    {
      name: 'a body altered after signing',
      status: 401,
      error: 'unauthorized',
      send: (signed) => {
        const timestamp = nowSeconds();
        return post(signed.input.id, JSON.stringify({ type: 'altered', note: MARKER }), {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(timestamp),
          'webhook-signature': sign(signed.secret, 'msg_1', timestamp, EVENT),
        });
      },
    },
    {
      name: 'a signature made with another secret',
      status: 401,
      error: 'unauthorized',
      send: (signed) =>
        deliverSigned({ ...signed, secret: `whsec_${randomBytes(32).toString('base64')}` }, EVENT),
    },
    {
      name: 'a signed timestamp older than the tolerance',
      status: 401,
      error: 'unauthorized',
      send: (signed) =>
        deliverSigned(signed, EVENT, 'msg_1', {
          'webhook-timestamp': String(stale()),
          'webhook-signature': sign(signed.secret, 'msg_1', stale(), EVENT),
        }),
    },
    {
      name: 'a signed timestamp from the future',
      status: 401,
      error: 'unauthorized',
      send: (signed) =>
        deliverSigned(signed, EVENT, 'msg_1', {
          'webhook-timestamp': String(early()),
          'webhook-signature': sign(signed.secret, 'msg_1', early(), EVENT),
        }),
    },
    {
      name: 'a signed input called without signature headers',
      status: 401,
      error: 'unauthorized',
      send: (signed) => post(signed.input.id, EVENT, {}),
    },
    {
      name: 'a wrong bearer token',
      status: 401,
      error: 'unauthorized',
      send: (_signed, bearer) => deliverBearer({ ...bearer, secret: 'not-the-token' }, EVENT),
    },
    {
      name: 'a bearer input called without Authorization',
      status: 401,
      error: 'unauthorized',
      send: (_signed, bearer) => post(bearer.input.id, EVENT, {}),
    },
    {
      name: 'correctly signed malformed JSON',
      status: 400,
      error: 'invalid_json',
      send: (signed) => deliverSigned(signed, `${MARKER} {"type":`),
    },
    {
      name: 'a correctly signed JSON array',
      status: 400,
      error: 'invalid_json',
      send: (signed) => deliverSigned(signed, JSON.stringify([{ note: MARKER }])),
    },
    {
      name: 'a body that is not valid UTF-8, signed over its bytes',
      status: 400,
      error: 'invalid_encoding',
      send: (signed) => deliverSigned(signed, invalidUtf8),
    },
    {
      name: 'a body over the size limit',
      status: 413,
      error: 'body_too_large',
      send: (signed) => deliverSigned(signed, oversized),
    },
    {
      name: 'a compressed body',
      status: 415,
      error: 'unsupported_encoding',
      send: (signed) => {
        const body = gzipSync(EVENT);
        return deliverSigned(signed, body, 'msg_1', { 'content-encoding': 'gzip' });
      },
    },
    {
      name: 'a media type other than JSON',
      status: 415,
      error: 'unsupported_media_type',
      send: (_signed, bearer) => deliverBearer(bearer, EVENT, { 'content-type': 'text/plain' }),
    },
    {
      name: 'a zero-length body',
      status: 400,
      error: 'invalid_json',
      send: (_signed, bearer) => deliverBearer(bearer, undefined),
    },
    {
      name: 'an event key longer than 255 characters',
      status: 400,
      error: 'invalid_event_key',
      send: (_signed, bearer) =>
        deliverBearer(bearer, EVENT, { 'idempotency-key': 'k'.repeat(256) }),
    },
    {
      // The token is judged before the body is read, whatever its size.
      name: 'a wrong bearer token on an oversized body',
      status: 401,
      error: 'unauthorized',
      send: (_signed, bearer) => deliverBearer({ ...bearer, secret: 'not-the-token' }, oversized),
    },
    {
      name: 'an unknown input',
      status: 404,
      error: 'unknown_input',
      send: (_signed, bearer) =>
        deliverBearer({ ...bearer, input: { ...bearer.input, id: 'inp-unknown' } }, EVENT),
    },
  ];

  it.each(cases)('$name → $status $error', async ({ status, error, send }) => {
    const signed = await signedSender();
    const bearer = await bearerSender();
    const before = inbox();

    const response = await send(signed, bearer);

    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain(MARKER);
    const reply: unknown = JSON.parse(text);
    expect(reply).toEqual({ error });
    expect(inbox()).toEqual(before);
  });

  it('answers 410 for a deleted input and removes its secret', async () => {
    const sender = await signedSender();
    await deleteInput({ store, secrets }, sender.input.id);

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(410);
    expect(readdirSync(secretsDir)).toEqual([]);
    expect(inbox().receipts).toEqual([]);
  });

  it('answers 410 when the input is deleted while the request is in flight', async () => {
    const sender = await signedSender();
    whileMatching = () => {
      store.markInputDeleted(sender.input.id);
    };

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(410);
    expect(await replyOf(response)).toEqual({ error: 'input_deleted' });
    expect(inbox()).toEqual({ receipts: [], payloads: [], handoffs: [] });
  });

  it('answers 503 when an enabled input has no readable secret', async () => {
    const sender = await signedSender();
    for (const file of readdirSync(secretsDir)) rmSync(join(secretsDir, file));

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(503);
    expect(await replyOf(response)).toEqual({ error: 'unavailable' });
    expect(inbox().receipts).toEqual([]);
  });

  it('answers 503 while shutting down', async () => {
    const sender = await signedSender();
    vi.mocked(getIsShuttingDown).mockReturnValue(true);

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(503);
    expect(inbox().receipts).toEqual([]);
  });

  it('answers 503 when shutdown begins while the body is arriving', async () => {
    const sender = await signedSender();
    vi.mocked(getIsShuttingDown).mockReturnValueOnce(false).mockReturnValue(true);

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(503);
    expect(inbox().receipts).toEqual([]);
  });

  it('answers 503 and rolls back every row when the receipt cannot be committed', async () => {
    const sender = await signedSender();
    // The duplicate handoff fails a constraint after the receipt, payload and first handoff are written.
    matched = { routine: [ROUTINE, ROUTINE], proactivity: [] };

    const failed = await deliverSigned(sender, EVENT, 'msg_a');

    expect(failed.status).toBe(503);
    expect(await replyOf(failed)).toEqual({ error: 'unavailable' });
    expect(inbox()).toEqual({ receipts: [], payloads: [], handoffs: [] });

    matched = { routine: [ROUTINE], proactivity: [] };
    const retried = await deliverSigned(sender, EVENT, 'msg_a');
    expect(retried.status).toBe(202);
  });

  it('answers 400 when a request carries no body at all', async () => {
    const bearer = await bearerSender();

    const response = await rawRequest([
      `POST /webhooks/incoming/${bearer.input.id} HTTP/1.1`,
      'Host: localhost',
      `Authorization: Bearer ${bearer.secret}`,
      'Content-Type: application/json',
      'Connection: close',
    ]);

    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain('{"error":"empty_body"}');
  });
});

describe('a retry with the same event key', () => {
  it('returns the original receipt and writes nothing', async () => {
    const sender = await signedSender();
    const first = await replyOf(await deliverSigned(sender, EVENT, 'msg_a'));
    const before = inbox();

    const retry = await deliverSigned(sender, EVENT, 'msg_a');

    expect(retry.status).toBe(200);
    expect(await replyOf(retry)).toEqual({ receipt_id: first.receipt_id, status: 'duplicate' });
    expect(inbox()).toEqual(before);
  });

  it('returns the original receipt even when the inbox is full', async () => {
    const sender = await signedSender();
    const large = JSON.stringify({ type: 'meeting.ended', pad: 'x'.repeat(3000) });
    const first = await replyOf(await deliverSigned(sender, large, 'msg_a'));

    const refused = await deliverSigned(sender, large, 'msg_b');
    expect(refused.status).toBe(429);
    expect(await replyOf(refused)).toEqual({ error: 'inbox_full' });

    const retry = await deliverSigned(sender, large, 'msg_a');
    expect(retry.status).toBe(200);
    expect(await replyOf(retry)).toEqual({ receipt_id: first.receipt_id, status: 'duplicate' });
    const { receipts, payloads } = inbox();
    expect(receipts).toHaveLength(1);
    expect(payloads).toHaveLength(1);
  });

  it('counts waiting bodies across the workspace, not only per input', async () => {
    const large = JSON.stringify({ type: 'meeting.ended', pad: 'x'.repeat(2900) });
    expect((await deliverSigned(await signedSender(), large)).status).toBe(202);
    expect((await deliverSigned(await signedSender(), large)).status).toBe(202);

    const refused = await deliverSigned(await signedSender(), large);

    expect(refused.status).toBe(429);
    expect(inbox().receipts).toHaveLength(2);
  });

  it('reports changed content as a conflict that stays visible on the receipt', async () => {
    const sender = await signedSender();
    const first = await replyOf(await deliverSigned(sender, EVENT, 'msg_a'));

    const changed = await deliverSigned(sender, JSON.stringify({ type: 'other' }), 'msg_a');

    expect(changed.status).toBe(409);
    expect(await replyOf(changed)).toEqual({
      error: 'event_key_conflict',
      receipt_id: first.receipt_id,
    });
    const { receipts, payloads, handoffs } = inbox();
    expect(receipts).toMatchObject([{ id: first.receipt_id, conflicts: 1 }]);
    expect(receipts[0]?.last_conflict_at).toEqual(expect.any(Number));
    expect(payloads).toEqual([{ receipt_id: first.receipt_id, body: hex(EVENT) }]);
    expect(handoffs).toHaveLength(1);

    const original = await deliverSigned(sender, EVENT, 'msg_a');
    expect(original.status).toBe(200);
  });

  it('deduplicates bearer deliveries that carry an Idempotency-Key', async () => {
    const sender = await bearerSender();
    const first = await replyOf(await deliverBearer(sender, EVENT, { 'idempotency-key': 'k-1' }));

    const retry = await deliverBearer(sender, EVENT, { 'idempotency-key': 'k-1' });

    expect(retry.status).toBe(200);
    expect(await replyOf(retry)).toEqual({ receipt_id: first.receipt_id, status: 'duplicate' });
    expect(inbox().receipts).toMatchObject([{ event_key: 'k-1' }]);
  });

  it('treats bearer deliveries without a key as separate events', async () => {
    const sender = await bearerSender();

    const first = await deliverBearer(sender, EVENT);
    const second = await deliverBearer(sender, EVENT);

    expect([first.status, second.status]).toEqual([202, 202]);
    const { receipts, payloads } = inbox();
    expect(receipts).toMatchObject([{ event_key: null }, { event_key: null }]);
    expect(payloads).toHaveLength(2);
  });

  it('never matches a sender-supplied key against an unkeyed receipt', async () => {
    const sender = await bearerSender();
    const unkeyed = await replyOf(await deliverBearer(sender, EVENT));

    const keyed = await deliverBearer(sender, JSON.stringify({ type: 'other' }), {
      'idempotency-key': unkeyed.receipt_id ?? '',
    });

    expect(keyed.status).toBe(202);
    expect(inbox().receipts).toMatchObject([{ conflicts: 0 }, { conflicts: 0 }]);
  });
});

describe('an ignored delivery retains no body', () => {
  it('records an event the input filter excludes', async () => {
    const sender = await signedSender([
      { pointer: '/type', op: 'equals', value: 'incident.opened' },
    ]);

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(200);
    expect(await replyOf(response)).toMatchObject({ status: 'ignored', reason: 'filtered' });
    const { receipts, payloads, handoffs } = inbox();
    expect(receipts).toMatchObject([{ outcome: 'ignored', ignored_reason: 'filtered' }]);
    expect(payloads).toEqual([]);
    expect(handoffs).toEqual([]);
  });

  it('records an event no consumer matches', async () => {
    const sender = await signedSender();
    matched = { routine: [], proactivity: [] };

    const response = await deliverSigned(sender, EVENT);

    expect(response.status).toBe(200);
    expect(await replyOf(response)).toMatchObject({ status: 'ignored', reason: 'filtered' });
    expect(inbox().payloads).toEqual([]);
  });

  it('records a delivery to a paused input, still authenticates it, and resumes with the next event', async () => {
    const sender = await signedSender();
    store.pauseInput(sender.input.id);

    const forged = await deliverSigned(sender, EVENT, 'msg_a', { 'webhook-signature': 'v1,AAAA' });
    expect(forged.status).toBe(401);

    const paused = await deliverSigned(sender, EVENT, 'msg_a');
    expect(paused.status).toBe(200);
    const ignored = await replyOf(paused);
    expect(ignored).toMatchObject({ status: 'ignored', reason: 'paused' });
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'ignored' }],
      payloads: [],
      handoffs: [],
    });

    const whilePaused = await deliverSigned(sender, EVENT, 'msg_a');
    expect(await replyOf(whilePaused)).toEqual({
      receipt_id: ignored.receipt_id,
      status: 'duplicate',
    });

    store.resumeInput(sender.input.id);

    const next = await deliverSigned(sender, EVENT, 'msg_b');
    expect(next.status).toBe(202);
    expect(inbox().payloads).toHaveLength(1);
  });
});

describe('a retry of an ignored event', () => {
  it('is accepted under the same receipt once the input is resumed', async () => {
    const sender = await signedSender();
    store.pauseInput(sender.input.id);
    const ignored = await replyOf(await deliverSigned(sender, EVENT, 'msg_a'));
    const ignoredAt = inbox().receipts[0]?.received_at;
    store.resumeInput(sender.input.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const replay = await deliverSigned(sender, EVENT, 'msg_a');

    expect(replay.status).toBe(202);
    expect(await replyOf(replay)).toEqual({ receipt_id: ignored.receipt_id, status: 'accepted' });
    const { receipts, payloads, handoffs } = inbox();
    expect(receipts).toMatchObject([
      { id: ignored.receipt_id, outcome: 'open', ignored_reason: null },
    ]);
    expect(Number(receipts[0]?.received_at)).toBeGreaterThan(Number(ignoredAt));
    expect(payloads).toEqual([{ receipt_id: ignored.receipt_id, body: hex(EVENT) }]);
    expect(handoffs).toMatchObject([{ receipt_id: ignored.receipt_id, state: 'pending' }]);

    const again = await deliverSigned(sender, EVENT, 'msg_a');
    expect(await replyOf(again)).toEqual({ receipt_id: ignored.receipt_id, status: 'duplicate' });
    expect(inbox().handoffs).toHaveLength(1);
  });

  it('is accepted once a consumer wants it', async () => {
    const sender = await signedSender();
    matched = { routine: [], proactivity: [] };
    const ignored = await replyOf(await deliverSigned(sender, EVENT, 'msg_a'));
    matched = { routine: [ROUTINE], proactivity: [] };

    const replay = await deliverSigned(sender, EVENT, 'msg_a');

    expect(replay.status).toBe(202);
    expect(await replyOf(replay)).toMatchObject({ receipt_id: ignored.receipt_id });
    expect(inbox().handoffs).toHaveLength(1);
  });

  it('stays a conflict when its content changed', async () => {
    const sender = await signedSender();
    store.pauseInput(sender.input.id);
    await deliverSigned(sender, EVENT, 'msg_a');
    store.resumeInput(sender.input.id);

    const changed = await deliverSigned(sender, JSON.stringify({ type: 'other' }), 'msg_a');

    expect(changed.status).toBe(409);
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'ignored', conflicts: 1 }],
      payloads: [],
      handoffs: [],
    });
  });

  it('is refused while the inbox is full and stays ignored', async () => {
    const sender = await signedSender();
    const large = JSON.stringify({ type: 'meeting.ended', pad: 'x'.repeat(3000) });
    store.pauseInput(sender.input.id);
    await deliverSigned(sender, large, 'msg_a');
    store.resumeInput(sender.input.id);
    expect((await deliverSigned(sender, large, 'msg_b')).status).toBe(202);

    const replay = await deliverSigned(sender, large, 'msg_a');

    expect(replay.status).toBe(429);
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'ignored' }, { outcome: 'open' }],
      payloads: [expect.anything()],
    });
  });
});

it('keeps secrets and bodies out of the log on accepted, rejected and conflicting deliveries', async () => {
  const signed = await signedSender();
  const bearer = await bearerSender();

  await deliverSigned(signed, EVENT, 'msg_a');
  await deliverSigned(signed, JSON.stringify({ type: 'other', note: MARKER }), 'msg_a');
  await deliverSigned(signed, `${MARKER} {"type":`, 'msg_b');
  await deliverSigned(signed, EVENT, 'msg_c', { 'webhook-signature': 'v1,AAAA' });
  await deliverBearer(bearer, EVENT);
  await deliverBearer({ ...bearer, secret: `${bearer.secret}x` }, EVENT);

  const logged = loggedText();
  expect(logged).toContain(signed.input.id);
  expect(logged).not.toContain(MARKER);
  expect(logged).not.toContain(signed.secret);
  expect(logged).not.toContain(signed.secret.replace(/^whsec_/, ''));
  expect(logged).not.toContain(bearer.secret);
});

it('notes when it refused a delivery, for the connection check', async () => {
  const sender = await signedSender();
  expect(lastRefusedDelivery(sender.input.id)).toBeNull();
  const before = Date.now();

  const response = await deliverSigned(
    { ...sender, secret: `whsec_${randomBytes(32).toString('base64')}` },
    EVENT,
  );

  expect(response.status).toBe(401);
  expect(lastRefusedDelivery(sender.input.id)).toBeGreaterThanOrEqual(before);
});
