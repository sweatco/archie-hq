// SPDX-License-Identifier: AGPL-3.0-or-later
/** What a delivery records for event routines: the real callback route and inbox file, with triggers indexed through the scheduler. */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../shutdown.js', () => ({ getIsShuttingDown: () => false }));

import { createInput } from '../../incoming/inputs.js';
import { mountIncomingReceiver } from '../../incoming/receiver.js';
import { vaultInputSecrets, type InputSecrets } from '../../incoming/secrets.js';
import { IncomingStore } from '../../incoming/store.js';
import type { IncomingConsumer, PointerCheck } from '../../incoming/types.js';
import type { Trigger, TriggerCondition } from '../../types/trigger.js';
import { matchRoutines, routineSnapshotSchema } from '../routine-consumer.js';
import { ROUTINE_CONSUMER_KIND } from '../routine-handoff.js';
import { deindexTrigger, indexTrigger } from '../trigger-scheduler.js';

const require = createRequire(import.meta.url);
const express = require('express') as typeof import('express');

const MARKER = 'RAW-BODY-MARKER-402a';
const EVENT = JSON.stringify({ type: 'meeting.ended', note: MARKER });
const ROUTINE_ID = 'trg-20261121-0900-notes1';
const OTHER_ID = 'trg-20261121-0900-ticket';
const NOTES_CHANNEL = { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' } as const;

// The receiver never calls `handle`; Stage 1 records the handoff and stops.
const consumer: IncomingConsumer = {
  kind: ROUTINE_CONSUMER_KIND,
  match: matchRoutines,
  handle: () => Promise.reject(new Error('Routines are not handled yet')),
};

interface Sender {
  inputId: string;
  secret: string;
}

let root: string;
let dbPath: string;
let store: IncomingStore;
let secrets: InputSecrets;
let server: Server;
let baseUrl: string;
let deliveries: number;

async function sender(filter?: PointerCheck[]): Promise<Sender> {
  const { input, secret } = await createInput(
    { store, secrets },
    { auth: 'standard_webhooks', filter },
  );
  return { inputId: input.id, secret };
}

function on(inputId: string, filter?: PointerCheck[]): TriggerCondition {
  return { type: 'incoming_event', input_id: inputId, ...(filter ? { filter } : {}) };
}

function routine(conditions: TriggerCondition[], over: Partial<Trigger> = {}): Trigger {
  return {
    id: ROUTINE_ID,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-21T09:00:00.000Z',
    approved_by: 'U0DANA',
    binding: NOTES_CHANNEL,
    conditions,
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
}

/** Indexes the routine and links it to the input, as approval and the operator would. */
function linked(to: Sender, trigger: Trigger): Trigger {
  indexTrigger(trigger);
  store.linkRoutine(to.inputId, trigger.id);
  return trigger;
}

const replySchema = z.object({ status: z.string(), reason: z.string().optional() });

async function deliver(to: Sender, body = EVENT): Promise<z.infer<typeof replySchema>> {
  const id = `msg_${++deliveries}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const key = Buffer.from(to.secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const response = await fetch(`${baseUrl}/webhooks/incoming/${to.inputId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${mac}`,
    },
    body,
  });
  return replySchema.parse(await response.json());
}

const handoffRowSchema = z.object({
  consumer_kind: z.string(),
  consumer_id: z.string(),
  snapshot: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
});

/** Committed handoffs in receipt order, read through a second connection. */
function handoffs() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT * FROM handoffs ORDER BY rowid')
      .all()
      .map((row) => {
        const handoff = handoffRowSchema.parse(row);
        return { ...handoff, snapshot: routineSnapshotSchema.parse(JSON.parse(handoff.snapshot)) };
      });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  root = mkdtempSync(join(tmpdir(), 'archie-routines-'));
  dbPath = join(root, 'state.sqlite');
  store = new IncomingStore(dbPath);
  secrets = vaultInputSecrets(join(root, 'secrets'));
  deliveries = 0;

  const app = express();
  mountIncomingReceiver(app, { store, secrets, consumers: [consumer] });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  deindexTrigger(ROUTINE_ID);
  deindexTrigger(OTHER_ID);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('records one handoff holding the routine prompt and destination, and nothing of the event', async () => {
  const from = await sender();
  const trigger = linked(from, routine([on(from.inputId)]));

  expect(await deliver(from)).toMatchObject({ status: 'accepted' });

  const recorded = handoffs();
  expect(recorded).toEqual([
    {
      consumer_kind: 'routine',
      consumer_id: ROUTINE_ID,
      state: 'pending',
      reason: null,
      snapshot: {
        v: 1,
        trigger_id: ROUTINE_ID,
        input_id: from.inputId,
        prompt: trigger.action.prompt,
        binding: NOTES_CHANNEL,
      },
    },
  ]);
  expect(JSON.stringify(recorded)).not.toContain(MARKER);
});

it('keeps the first receipt on the prompt it was received under after an edit', async () => {
  const from = await sender();
  const before = linked(from, routine([on(from.inputId)]));

  await deliver(from);
  // Both edit paths save a changed copy and index it in place of the old record.
  indexTrigger({ ...before, action: { prompt: 'File a ticket instead.' } });
  await deliver(from);

  expect(handoffs().map((handoff) => handoff.snapshot.prompt)).toEqual([
    'Summarize the meeting.',
    'File a ticket instead.',
  ]);
});

it('snapshots a DM destination as bound', async () => {
  const from = await sender();
  const dm: Trigger['binding'] = {
    type: 'user',
    user_id: 'U0DANA',
    channel_id: 'D0DANA',
    channel_name: 'DM with Dana',
  };
  linked(from, routine([on(from.inputId)], { binding: dm }));

  await deliver(from);

  expect(handoffs()[0]?.snapshot.binding).toEqual(dm);
});

it('records one handoff when two conditions of one routine match', async () => {
  const from = await sender();
  linked(
    from,
    routine([
      on(from.inputId, [{ pointer: '/type', op: 'equals', value: 'meeting.ended' }]),
      on(from.inputId, [{ pointer: '/note', op: 'present' }]),
    ]),
  );

  expect(await deliver(from)).toMatchObject({ status: 'accepted' });

  expect(handoffs()).toHaveLength(1);
});

it('records one handoff per linked routine, each under its own filter', async () => {
  const from = await sender();
  linked(from, routine([on(from.inputId, [{ pointer: '/type', op: 'in', values: ['a', 'b'] }])]));
  linked(from, routine([on(from.inputId)], { id: OTHER_ID, action: { prompt: 'File a ticket.' } }));

  await deliver(from, JSON.stringify({ type: 'a' }));
  await deliver(from, JSON.stringify({ type: 'c' }));

  expect(handoffs().map((handoff) => handoff.consumer_id)).toEqual([
    ROUTINE_ID,
    OTHER_ID,
    OTHER_ID,
  ]);
});

it('keeps handing events to the other routine of an input while one is paused', async () => {
  const from = await sender();
  const notes = linked(from, routine([on(from.inputId)]));
  linked(from, routine([on(from.inputId)], { id: OTHER_ID, action: { prompt: 'File a ticket.' } }));

  await deliver(from);
  // A pause and a resume both index the changed record, as the trigger tools do.
  indexTrigger({ ...notes, status: 'paused' });
  expect(await deliver(from)).toMatchObject({ status: 'accepted' });
  indexTrigger(notes);
  await deliver(from);

  expect(handoffs().map((handoff) => handoff.consumer_id)).toEqual([
    ROUTINE_ID,
    OTHER_ID,
    OTHER_ID,
    ROUTINE_ID,
    OTHER_ID,
  ]);
});

it.each<[string, (from: Sender, other: Sender) => void]>([
  [
    'is approved but not linked by the operator',
    (from) => indexTrigger(routine([on(from.inputId)])),
  ],
  [
    'is linked but still awaiting approval',
    (from) => linked(from, routine([on(from.inputId)], { status: 'pending' })),
  ],
  [
    'is linked but paused',
    (from) => linked(from, routine([on(from.inputId)], { status: 'paused' })),
  ],
  ['names another input', (from, other) => linked(from, routine([on(other.inputId)]))],
  [
    'was unlinked',
    (from) => {
      linked(from, routine([on(from.inputId)]));
      store.unlinkRoutine(from.inputId, ROUTINE_ID);
    },
  ],
  [
    'has a filter the event fails',
    (from) =>
      linked(
        from,
        routine([on(from.inputId, [{ pointer: '/type', op: 'equals', value: 'incident' }])]),
      ),
  ],
  [
    'runs on a schedule only',
    (from) =>
      linked(
        from,
        routine([{ type: 'schedule', tz: 'UTC', next_run_at: '2099-01-01T09:00:00.000Z' }]),
      ),
  ],
])('ignores the event when the routine %s', async (_name, arrange) => {
  const from = await sender();
  arrange(from, await sender());

  expect(await deliver(from)).toEqual({ status: 'ignored', reason: 'filtered' });

  expect(handoffs()).toEqual([]);
});

it('ignores the event while triggers are switched off', async () => {
  const from = await sender();
  linked(from, routine([on(from.inputId)]));
  vi.stubEnv('ARCHIE_TRIGGERS_ENABLED', 'false');

  expect(await deliver(from)).toEqual({ status: 'ignored', reason: 'filtered' });
});

it('applies the input filter before any routine is asked', async () => {
  const from = await sender([{ pointer: '/type', op: 'equals', value: 'incident' }]);
  linked(from, routine([on(from.inputId)]));

  expect(await deliver(from)).toEqual({ status: 'ignored', reason: 'filtered' });
});
