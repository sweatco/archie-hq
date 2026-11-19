// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the Archie process gets from `ARCHIE_INCOMING_EVENTS`: no route when off, the route and
 * the dispatcher when on, and a 503 route when the inbox cannot be opened. Storage is real and
 * lives in a temporary directory.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../system/workdir.js', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = join(tmpdir(), `archie-incoming-runtime-${process.pid}-${Date.now()}`);
  return {
    INCOMING_DIR: join(root, 'workdir', 'incoming'),
    INCOMING_SECRETS_DIR: join(root, 'secrets', 'incoming'),
  };
});
vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../../system/shutdown.js', () => ({ getIsShuttingDown: () => false }));

import { logger } from '../../system/logger.js';
import { INCOMING_DIR, INCOMING_SECRETS_DIR } from '../../system/workdir.js';
import { createInput } from '../inputs.js';
import {
  incomingSecrets,
  mountIncomingEvents,
  openIncomingStore,
  validateIncomingEventsConfig,
  type IncomingEvents,
} from '../runtime.js';
import type { HandoffWork, IncomingConsumer } from '../types.js';

const require = createRequire(import.meta.url);
const express = require('express') as typeof import('express');

const EVENT = JSON.stringify({ type: 'meeting.ended' });
const ROOT = dirname(dirname(INCOMING_DIR));

let server: Server | undefined;
let events: IncomingEvents | null;

async function boot(consumers?: IncomingConsumer[]): Promise<string> {
  const app = express();
  events = mountIncomingEvents(app, consumers);
  const listening = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  server = listening;
  const address = listening.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** Creates an input the way the operator CLI does: through its own connection. */
async function newInput(): Promise<{ id: string; secret: string }> {
  const store = openIncomingStore();
  try {
    const { input, secret } = await createInput(
      { store, secrets: incomingSecrets() },
      { auth: 'standard_webhooks' },
    );
    return { id: input.id, secret };
  } finally {
    store.close();
  }
}

/** Commits one delivery for `routine` without HTTP, for tests that control time. */
function addWaitingHandoff(): void {
  const store = openIncomingStore();
  store.insertInput(
    { id: 'inp-1', state: 'enabled', auth: 'bearer', secretRefs: [], filter: [], revision: 1 },
    Date.now(),
  );
  store.receive(
    {
      inputId: 'inp-1',
      binding: 'generic',
      eventKey: null,
      digest: 'unused',
      body: Buffer.from(EVENT),
      receivedAt: Date.now(),
    },
    [{ kind: 'routine', consumerId: 'trg-1', snapshot: '{}' }],
  );
  store.close();
}

function deliver(baseUrl: string, input: { id: string; secret: string }, key: string, sign = true) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = createHmac('sha256', Buffer.from(input.secret.replace(/^whsec_/, ''), 'base64'));
  const signature = mac.update(`${key}.${timestamp}.${EVENT}`).digest('base64');
  return fetch(`${baseUrl}/webhooks/incoming/${input.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      'webhook-id': key,
      'webhook-timestamp': timestamp,
      'webhook-signature': sign ? `v1,${signature}` : 'v1,AAAA',
    },
    body: EVENT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  events = null;
});
afterEach(async () => {
  vi.useRealTimers();
  await events?.close().catch(() => undefined);
  const listening = server;
  server = undefined;
  if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('with the flag off', () => {
  it.each([undefined, 'off', '', ' OFF '])(
    'mounts no route and creates no storage (%j)',
    async (flag) => {
      if (flag !== undefined) vi.stubEnv('ARCHIE_INCOMING_EVENTS', flag);

      const baseUrl = await boot();

      expect(events).toBeNull();
      const response = await fetch(`${baseUrl}/webhooks/incoming/inp-any`, {
        method: 'POST',
        headers: { connection: 'close' },
      });
      expect(response.status).toBe(404);
      expect(existsSync(INCOMING_DIR)).toBe(false);
    },
  );
});

describe('with the flag on', () => {
  beforeEach(() => {
    vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'on');
  });

  it('authenticates deliveries and records them as ignored while no consumer exists', async () => {
    vi.stubEnv('ARCHIE_INCOMING_EVENTS', ' On ');
    const baseUrl = await boot();
    const input = await newInput();

    const forged = await deliver(baseUrl, input, 'msg_a', false);
    const accepted = await deliver(baseUrl, input, 'msg_a');

    expect(forged.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: 'ignored', reason: 'filtered' });
  });

  it('creates the inbox and the secrets directory for their owner only', async () => {
    await boot();

    expect(statSync(INCOMING_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(INCOMING_SECRETS_DIR).mode & 0o777).toBe(0o700);
  });

  it('hands nothing off until it is started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const handle = vi.fn<IncomingConsumer['handle']>().mockResolvedValue('accepted');
    events = mountIncomingEvents(express(), [{ kind: 'routine', match: () => [], handle }]);
    addWaitingHandoff();

    await vi.advanceTimersByTimeAsync(5000);
    expect(handle).not.toHaveBeenCalled();

    events?.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('hands a delivery to a consumer once started, and answers 503 after it is closed', async () => {
    const handled: HandoffWork[] = [];
    const consumer: IncomingConsumer = {
      kind: 'routine',
      match: () => [{ consumerId: 'trg-1', snapshot: '{}' }],
      handle: (work) => {
        handled.push(work);
        return Promise.resolve('accepted');
      },
    };
    const baseUrl = await boot([consumer]);
    const input = await newInput();

    expect((await deliver(baseUrl, input, 'msg_a')).status).toBe(202);

    events?.start();
    await vi.waitFor(() => expect(handled).toHaveLength(1), { timeout: 5000 });
    expect(Buffer.from(handled[0]?.body ?? []).toString()).toBe(EVENT);

    await events?.close();
    events = null;
    const afterClose = await deliver(baseUrl, input, 'msg_b');
    expect(afterClose.status).toBe(503);
  });

  it('closes after five seconds even when a handoff attempt is still running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const started = vi.fn();
    const consumer: IncomingConsumer = {
      kind: 'routine',
      match: () => [],
      handle: () => {
        started();
        return new Promise(() => {});
      },
    };
    const running = mountIncomingEvents(express(), [consumer]);
    addWaitingHandoff();
    running?.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = running?.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
  });

  it('answers 503 instead of 404 when the inbox cannot be opened', async () => {
    mkdirSync(dirname(INCOMING_DIR), { recursive: true });
    writeFileSync(INCOMING_DIR, 'not a directory');

    const baseUrl = await boot();

    expect(events).toBeNull();
    const response = await fetch(`${baseUrl}/webhooks/incoming/inp-any`, {
      method: 'POST',
      headers: { connection: 'close' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('refuses to boot without the vault key', () => {
    vi.stubEnv('ARCHIE_SECRETS_KEY', '');

    expect(() => mountIncomingEvents(express())).toThrow(/ARCHIE_SECRETS_KEY/);
  });
});

it('refuses to boot on a flag value it does not know', () => {
  vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'yes');

  expect(() => mountIncomingEvents(express())).toThrow(/must be "off" or "on"/);
});

describe('the startup configuration check', () => {
  it('passes with the flag off and no vault key', () => {
    vi.stubEnv('ARCHIE_SECRETS_KEY', '');

    expect(() => validateIncomingEventsConfig()).not.toThrow();
  });

  it('names an unknown flag value and a missing vault key', () => {
    vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'true');
    expect(() => validateIncomingEventsConfig()).toThrow(/must be "off" or "on"/);

    vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'on');
    vi.stubEnv('ARCHIE_SECRETS_KEY', '');
    expect(() => validateIncomingEventsConfig()).toThrow(/ARCHIE_SECRETS_KEY/);
  });
});
