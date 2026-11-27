// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertNotRootBesideDaemon, runIncomingCommand } from '../operator.js';
import { vaultInputSecrets, type InputSecrets } from '../secrets.js';
import { IncomingStore } from '../store.js';
import type { Trigger } from '../../types/trigger.js';

const ROUTINE_ID = 'trg-20261121-0900-notes1';

let root: string;
let secretsDir: string;
let store: IncomingStore;
let secrets: InputSecrets;
let printed: string[];
let triggers: Map<string, Trigger>;
let taskStatuses: Map<string, string>;

function run(...args: string[]): Promise<void> {
  const loadTrigger = (id: string) => Promise.resolve(triggers.get(id) ?? null);
  const taskStatus = (id: string) => Promise.resolve(taskStatuses.get(id) ?? null);
  return runIncomingCommand(args, { store, secrets, loadTrigger, taskStatus }, (line) =>
    printed.push(line),
  );
}

/** Stores a trigger record that names the input, as an approved proposal would. */
function routineFor(inputId: string, over: Partial<Trigger> = {}): Trigger {
  const trigger: Trigger = {
    id: ROUTINE_ID,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-21T09:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [{ type: 'incoming_event', input_id: inputId }],
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
  triggers.set(trigger.id, trigger);
  return trigger;
}

/** Creates an input through the command and returns what it printed about it. */
async function created(...args: string[]): Promise<{ id: string; secret: string; output: string }> {
  printed = [];
  await run('create', ...args);
  const output = printed.join('\n');
  const id = /Created input (\S+)/.exec(output)?.[1];
  const secret = /Secret:\s+(\S+)/.exec(output)?.[1];
  if (!id || !secret) throw new Error(`Unexpected create output: ${output}`);
  return { id, secret, output };
}

beforeEach(() => {
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('ARCHIE_PUBLIC_URL', 'https://archie.example.test/');
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-operator-'));
  secretsDir = join(root, 'secrets');
  store = new IncomingStore(join(root, 'state.sqlite'));
  secrets = vaultInputSecrets(secretsDir);
  printed = [];
  triggers = new Map();
  taskStatuses = new Map();
});
afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('creates a signed input and prints its callback URL and its secret', async () => {
  const { id, secret, output } = await created();

  expect(output).toContain(`https://archie.example.test/webhooks/incoming/${id}`);
  expect(secret).toMatch(/^whsec_/);
  expect(output.split(secret)).toHaveLength(2);
  const input = store.input(id);
  expect(input).toMatchObject({ state: 'enabled', auth: 'standard_webhooks', filter: [] });
  expect(await secrets.read(input?.secretRefs[0] ?? '')).toBe(secret);
});

it('creates a bearer input with a filter', async () => {
  const filter = [{ pointer: '/type', op: 'equals', value: 'meeting.ended' }];

  const { id, secret, output } = await created(
    '--auth',
    'bearer',
    '--filter',
    JSON.stringify(filter),
  );

  expect(secret).not.toMatch(/^whsec_/);
  expect(output).toContain('Authorization: Bearer');
  expect(store.input(id)).toMatchObject({ auth: 'bearer', filter });
});

it('prints the path alone when the public URL is not configured', async () => {
  vi.stubEnv('ARCHIE_PUBLIC_URL', '');

  const { id, output } = await created();

  expect(output).toContain(`Callback path: /webhooks/incoming/${id}`);
  expect(output).not.toContain('Callback URL');
});

it.each([
  [['create', '--auth', 'basic'], /signed or bearer/],
  [['create', '--auth', 'constructor'], /signed or bearer/],
  [['create', '--filter', '{'], /not valid JSON/],
  [['create', '--filter', '[{"pointer":"type","op":"present"}]'], /not a valid filter/],
  [['create', '--label', 'x'], /Unknown option/],
  [['create', '--auth'], /needs a value/],
  [['pause'], /Usage/],
  [['pause', 'inp-missing'], /No input inp-missing/],
  [['delete', 'inp-missing'], /No input inp-missing/],
  [['frobnicate'], /Unknown command/],
  [[], /Unknown command/],
])('rejects %j and creates nothing', async (args, message) => {
  await expect(run(...args)).rejects.toThrow(message);

  expect(store.inputSummaries()).toEqual([]);
  expect(existsSync(secretsDir) ? readdirSync(secretsDir) : []).toEqual([]);
});

it('lists inputs with their state and what they have received', async () => {
  const signed = await created();
  const bearer = await created('--auth', 'bearer');
  const delivery = {
    inputId: signed.id,
    binding: 'generic',
    digest: 'unused',
    body: new Uint8Array(),
    receivedAt: Date.now(),
  };
  store.receive({ ...delivery, eventKey: 'msg_ignored' }, []);
  store.receive({ ...delivery, eventKey: 'msg_waiting' }, [
    { kind: 'routine', consumerId: 'trg-1', snapshot: '{}' },
  ]);
  await run('pause', bearer.id);
  printed = [];

  await run('list');

  expect(printed).toHaveLength(3);
  expect(printed[0]).toMatch(/^Input\s+State\s+Auth\s+Created\s+Receipts\s+Ignored\s+Waiting$/);
  expect(printed[0]).toHaveLength(printed[1]?.length ?? 0);
  expect(printed[1]).toMatch(
    new RegExp(`^${signed.id}\\s+enabled\\s+signed\\s+\\S+\\s+2\\s+1\\s+1$`),
  );
  expect(printed[2]).toMatch(
    new RegExp(`^${bearer.id}\\s+paused\\s+bearer\\s+\\S+\\s+0\\s+0\\s+0$`),
  );
  expect(printed.join('\n')).not.toContain(signed.secret);
});

it('says so when there is no input', async () => {
  await run('list');

  expect(printed.join('\n')).toContain('No inputs yet');
});

it('pauses, resumes and deletes an input, and removes its secret on delete', async () => {
  const { id } = await created();

  await run('pause', id);
  expect(store.input(id)?.state).toBe('paused');
  await run('resume', id);
  expect(store.input(id)?.state).toBe('enabled');

  await run('delete', id);
  expect(store.input(id)?.state).toBe('deleted');
  expect(readdirSync(secretsDir)).toEqual([]);
  expect(printed.at(-1)).toBe(`Input ${id} is deleted.`);

  await expect(run('resume', id)).rejects.toThrow(/cannot be resumed/);
  await expect(run('pause', id)).rejects.toThrow(/was deleted/);
  expect(store.input(id)?.state).toBe('deleted');
});

it('rotates a key, prints the new one once and removes the old one', async () => {
  const { id, secret } = await created();
  printed = [];

  await run('rotate', id);

  const [rotated, shown] = printed;
  expect(rotated).toBe(`Rotated the key of input ${id}. The old key no longer works.`);
  const next = shown?.replace('Secret:        ', '');
  expect(next).toMatch(/^whsec_/);
  expect(next).not.toBe(secret);
  expect(readdirSync(secretsDir)).toHaveLength(1);
  expect(await secrets.read(store.input(id)?.secretRefs[0] ?? '')).toBe(next);
});

it('rotates no key of an input that is deleted or unknown', async () => {
  const { id } = await created();
  await run('delete', id);

  await expect(run('rotate', id)).rejects.toThrow(/was deleted/);
  await expect(run('rotate', 'inp-NOSUCHAAAAAAAAAAAAAAAA')).rejects.toThrow(/No input/);
  await expect(run('rotate')).rejects.toThrow(/Usage: incoming rotate/);
});

it('says the input is already deleted when only the secret cleanup failed', async () => {
  const { id } = await created();
  vi.spyOn(secrets, 'remove').mockRejectedValueOnce(new Error('file is busy'));

  await expect(run('delete', id)).rejects.toThrow(/is deleted .* file is busy\. Run delete again/);
  expect(store.input(id)?.state).toBe('deleted');

  await run('delete', id);
  expect(readdirSync(secretsDir)).toEqual([]);
});

it('links a trigger to an input, shows what was allowed, and lists the link', async () => {
  const { id } = await created();
  routineFor(id);
  printed = [];

  await run('link', id, ROUTINE_ID);

  expect(printed).toEqual([
    'Delivers to: channel C0NOTES',
    'Does:        Meeting notes',
    'Status:      enabled',
    `Linked trigger ${ROUTINE_ID} to input ${id}.`,
  ]);
  expect(store.input(id)).toMatchObject({ routines: [ROUTINE_ID], revision: 2 });

  printed = [];
  await run('link', id, ROUTINE_ID);
  expect(printed.at(-1)).toBe(`Trigger ${ROUTINE_ID} is already linked to input ${id}.`);
  expect(store.input(id)).toMatchObject({ routines: [ROUTINE_ID], revision: 2 });

  printed = [];
  await run('list');
  expect(printed).toHaveLength(3);
  expect(printed[2]).toBe(`  linked: ${ROUTINE_ID}`);

  triggers.delete(ROUTINE_ID);
  printed = [];
  await run('list');
  expect(printed[2]).toBe(`  linked: ${ROUTINE_ID} (no longer exists)`);
});

it('prints what the proposer wrote without its control characters or its name for the channel', async () => {
  const { id } = await created();
  routineFor(id, {
    summary: 'Notes\u001b[2K\rLinked trigger trg-other to input inp-other.',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'general (C0GENERAL)' },
  });
  printed = [];

  await run('link', id, ROUTINE_ID);

  expect(printed.slice(0, 2)).toEqual([
    'Delivers to: channel C0NOTES',
    'Does:        Notes [2K Linked trigger trg-other to input inp-other.',
  ]);
});

it('says when a linked trigger does not receive events yet', async () => {
  const { id } = await created();
  routineFor(id, {
    status: 'pending',
    binding: { type: 'user', user_id: 'U0DANA', channel_id: 'D0DANA', channel_name: 'Dana' },
  });
  printed = [];

  await run('link', id, ROUTINE_ID);

  expect(printed.slice(0, 3)).toEqual([
    'Delivers to: a DM with U0DANA (D0DANA)',
    'Does:        Meeting notes',
    'Status:      pending — it receives events once it is approved',
  ]);
});

it('unlinks a trigger whose record is gone', async () => {
  const { id } = await created();
  routineFor(id);
  await run('link', id, ROUTINE_ID);
  triggers.clear();

  await run('unlink', id, ROUTINE_ID);

  expect(printed.at(-1)).toBe(`Unlinked trigger ${ROUTINE_ID} from input ${id}.`);
  expect(store.input(id)).toMatchObject({ routines: [], revision: 3 });
  await expect(run('unlink', id, ROUTINE_ID)).rejects.toThrow(/is not linked/);
});

it('refuses a second trigger on an input, which takes one', async () => {
  const { id } = await created();
  routineFor(id);
  routineFor(id, { id: 'trg-20261121-0900-ticket' });
  await run('link', id, ROUTINE_ID);

  await expect(run('link', id, 'trg-20261121-0900-ticket')).rejects.toThrow(
    /already has a trigger/,
  );
  expect(store.input(id)?.routines).toEqual([ROUTINE_ID]);
});

it('links a trigger to an input whose earlier trigger was deleted', async () => {
  const { id } = await created();
  routineFor(id);
  routineFor(id, { id: 'trg-20261121-0900-ticket' });
  await run('link', id, ROUTINE_ID);
  triggers.delete(ROUTINE_ID);

  await run('link', id, 'trg-20261121-0900-ticket');

  expect(store.input(id)?.routines).toEqual(['trg-20261121-0900-ticket']);
});

it('refuses a link that would deliver nothing, and changes no input', async () => {
  const { id } = await created();
  const other = await created();
  const deleted = await created();
  await run('delete', deleted.id);
  routineFor(other.id);
  routineFor(deleted.id, { id: 'trg-20261121-0900-gone00' });
  routineFor(id, {
    id: 'trg-20261121-0900-sched0',
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2099-01-01T09:00:00.000Z' }],
  });

  await expect(run('link', id, ROUTINE_ID)).rejects.toThrow(/has no condition for input/);
  await expect(run('link', id, 'trg-20261121-0900-sched0')).rejects.toThrow(/has no condition/);
  await expect(run('link', id, 'trg-20261121-0900-absent')).rejects.toThrow(/No trigger/);
  await expect(run('link', 'inp-missing', ROUTINE_ID)).rejects.toThrow(/No input inp-missing/);
  await expect(run('link', deleted.id, 'trg-20261121-0900-gone00')).rejects.toThrow(/was deleted/);
  await expect(run('link', id)).rejects.toThrow(/Usage/);
  await expect(run('unlink', id)).rejects.toThrow(/Usage/);

  for (const input of [id, other.id, deleted.id])
    expect(store.input(input)).toMatchObject({ routines: [], revision: 1 });
});

it('shows how each handed-off event ended, why, and the Task it reserved', async () => {
  const { id } = await created();
  const other = await created();
  const at = Date.UTC(2026, 10, 21, 9, 30);
  const receive = (inputId: string, eventKey: string, receivedAt: number) =>
    store.receive(
      {
        inputId,
        binding: 'generic',
        eventKey,
        digest: 'unused',
        body: new Uint8Array(),
        receivedAt,
      },
      [{ kind: 'routine', consumerId: ROUTINE_ID, snapshot: '{}' }],
    );
  const end = (
    state: 'accepted' | 'skipped' | 'failed',
    reason: string | null,
    taskId?: string,
  ) => {
    const claimed = store.claimHandoff(at + 60_000, 1000);
    if (!claimed) throw new Error('Expected a waiting handoff');
    if (taskId)
      store.saveReservation(claimed.handoff.id, claimed.token, JSON.stringify({ task_id: taskId }));
    store.finishHandoff(claimed.handoff.id, claimed.token, state, reason);
  };
  receive(id, 'msg_1', at);
  end('accepted', null, 'task-started');
  receive(id, 'msg_2', at + 1);
  end('skipped', 'routine_paused');
  receive(id, 'msg_3', at + 2);
  end('failed', 'attempts_exhausted', 'task-ran-anyway');
  receive(id, 'msg_4', at + 3);
  end('failed', 'interrupted', 'task-discarded');
  receive(id, 'msg_5', at + 4);
  end('failed', 'interrupted', 'task-prepared');
  receive(other.id, 'msg_6', at + 5);
  taskStatuses.set('task-started', 'completed');
  taskStatuses.set('task-ran-anyway', 'in_progress');
  taskStatuses.set('task-prepared', 'preparing');
  printed = [];

  await run('history', id);

  const cells = printed.map((line) => line.trim().split(/\s{2,}/));
  expect(cells).toEqual([
    ['Received (UTC)', 'Input', 'Trigger', 'State', 'Reason', 'Task'],
    ['2026-11-21 09:30', id, ROUTINE_ID, 'failed', 'interrupted', 'task-prepared preparing'],
    ['2026-11-21 09:30', id, ROUTINE_ID, 'failed', 'interrupted', '-'],
    [
      '2026-11-21 09:30',
      id,
      ROUTINE_ID,
      'failed',
      'attempts_exhausted',
      'task-ran-anyway in_progress (uncertain)',
    ],
    ['2026-11-21 09:30', id, ROUTINE_ID, 'skipped', 'routine_paused', '-'],
    ['2026-11-21 09:30', id, ROUTINE_ID, 'accepted', '-', 'task-started completed'],
  ]);

  printed = [];
  await run('history');
  expect(printed).toHaveLength(7);
  expect(printed[1]).toMatch(new RegExp(`${other.id}\\s+${ROUTINE_ID}\\s+pending`));
  await expect(run('history', 'inp-missing')).rejects.toThrow(/No input inp-missing/);
});

it('shows a handoff whose reservation cannot be read', async () => {
  const { id } = await created();
  const at = Date.UTC(2026, 10, 21, 9, 30);
  store.receive(
    {
      inputId: id,
      binding: 'generic',
      eventKey: 'msg_1',
      digest: 'unused',
      body: new Uint8Array(),
      receivedAt: at,
    },
    [{ kind: 'routine', consumerId: ROUTINE_ID, snapshot: '{}' }],
  );
  const claimed = store.claimHandoff(at + 60_000, 1000);
  if (!claimed) throw new Error('Expected a waiting handoff');
  store.saveReservation(claimed.handoff.id, claimed.token, 'not json');
  store.finishHandoff(claimed.handoff.id, claimed.token, 'failed', 'attempts_exhausted');
  printed = [];

  await run('history', id);

  expect(printed[1]).toMatch(/failed\s+attempts_exhausted\s+-$/);
});

it('says so when no event has been handed off', async () => {
  await run('history');

  expect(printed).toEqual(['No event has been handed to a trigger yet.']);
});

it.each([
  ['root beside a workdir that another user owns', 0, 1001, true],
  ['root beside directories root owns', 0, 0, false],
  ['root where the directory does not exist yet', 0, undefined, false],
  ['the daemon user', 1001, 1001, false],
  ['a platform without user ids', undefined, 1001, false],
])('the root check: %s', (_name, uid, owner, refused) => {
  const check = () => assertNotRootBesideDaemon(uid, ['/workdir'], () => owner);

  if (refused) expect(check).toThrow(/not as root: \/workdir belongs to uid 1001/);
  else expect(check).not.toThrow();
});

it('lists the owner and the purpose of an input made in Slack', async () => {
  const { createInput } = await import('../inputs.js');
  const { input } = await createInput(
    { store, secrets },
    { auth: 'standard_webhooks', owner: 'U0DANA', purpose: 'Meeting recordings' },
  );
  await created();
  printed = [];

  await run('list');

  const lines = printed.join('\n').split('\n');
  const row = lines.findIndex((line) => line.startsWith(input.id));
  expect(lines[row + 1]).toBe('  owner: U0DANA  purpose: Meeting recordings');
  expect(lines.filter((line) => line.includes('owner:'))).toHaveLength(1);
});
