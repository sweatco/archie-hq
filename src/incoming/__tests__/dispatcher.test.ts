// SPDX-License-Identifier: AGPL-3.0-or-later
/** The dispatcher and lease rules over a real SQLite file; the test moves time and reads state through a second connection. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));

import { logger } from '../../system/logger.js';
import { IncomingDispatcher, type DispatchPolicy } from '../dispatcher.js';
import { IncomingStore } from '../store.js';
import type { ConsumerMatch, HandoffWork, IncomingConsumer } from '../types.js';

const DAY = 24 * 60 * 60_000;
const MARKER = 'RAW-BODY-MARKER-91c2';
const BODY = Buffer.from(JSON.stringify({ type: 'meeting.ended', note: MARKER }));
const ROUTINE: ConsumerMatch & { kind: string } = {
  kind: 'routine',
  consumerId: 'trg-1',
  snapshot: '{"prompt":"summarize"}',
};
const PROACTIVITY = { kind: 'proactivity', consumerId: 'proactivity', snapshot: '{}' };
const POLICY: DispatchPolicy = {
  leaseMs: 1000,
  retryDelaysMs: [100, 200],
  pollMs: 5,
  sweepEveryMs: 60_000,
  handoffMaxAgeMs: 7 * DAY,
  receiptRetentionMs: 30 * DAY,
};

/** Runs in a second process: on `go`, claims and finishes every due handoff. */
const CLAIM_LOOP = `
  import { IncomingStore } from ${JSON.stringify(new URL('../store.ts', import.meta.url).href)};
  const store = new IncomingStore(process.env.INBOX);
  const at = Number(process.env.CLAIM_AT);
  process.stdout.write('ready\\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  const claimed = [];
  for (let next = store.claimHandoff(at, 60000); next; next = store.claimHandoff(at, 60000)) {
    claimed.push(next.handoff.id);
    store.finishHandoff(next.handoff.id, next.token, 'accepted');
  }
  store.close();
  process.stdout.write(JSON.stringify(claimed));
`;

type Handle = IncomingConsumer['handle'];

let root: string;
let dbPath: string;
let store: IncomingStore;
let now: number;
const opened: IncomingStore[] = [];
const dispatchers: IncomingDispatcher[] = [];

function openStore(): IncomingStore {
  const another = new IncomingStore(dbPath);
  opened.push(another);
  return another;
}

function dispatcher(
  handlers: Record<string, Handle>,
  options: { store?: IncomingStore; policy?: Partial<DispatchPolicy>; clock?: () => number } = {},
): IncomingDispatcher {
  const consumers = Object.entries(handlers).map(([kind, handle]) => ({
    kind,
    match: () => [],
    handle,
  }));
  const created = new IncomingDispatcher(
    options.store ?? store,
    consumers,
    { ...POLICY, ...options.policy },
    options.clock ?? (() => now),
  );
  dispatchers.push(created);
  return created;
}

function receive(eventKey: string, consumers = [ROUTINE], inputId = 'inp-1'): string {
  const result = store.receive(
    {
      inputId,
      binding: 'generic',
      eventKey,
      digest: createHash('sha256').update(BODY).digest('hex'),
      body: BODY,
      receivedAt: now,
    },
    consumers,
  );
  if (result.status !== 'accepted')
    throw new Error(`Expected an accepted receipt: ${result.status}`);
  return result.receiptId;
}

function inbox() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      receipts: db.prepare('SELECT id, event_key, outcome FROM receipts ORDER BY rowid').all(),
      payloads: db.prepare('SELECT receipt_id FROM payloads ORDER BY rowid').all(),
      handoffs: db
        .prepare(
          'SELECT consumer_kind, state, attempts, token, lease_until, due_at, reservation FROM handoffs ORDER BY rowid',
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function claimingProcess() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', CLAIM_LOOP],
    {
      env: { ...process.env, INBOX: dbPath, CLAIM_AT: String(now) },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  // A process that died early has closed its input; its exit code reports the failure.
  child.stdin.on('error', () => {});
  let output = '';
  const ready = deferred<undefined>();
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes('ready\n')) ready.resolve(undefined);
  });
  const claimed = new Promise<string[]>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      ready.resolve(undefined);
      if (code !== 0) return reject(new Error(`Claiming process exited with code ${code}`));
      resolve(z.array(z.string()).parse(JSON.parse(output.slice('ready\n'.length))));
    });
  });
  return { ready: ready.promise, go: () => child.stdin.end('go\n'), claimed };
}

function loggedText(): string {
  return [logger.system, logger.error, logger.warn]
    .flatMap((log) => vi.mocked(log).mock.calls.flat())
    .map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : String(value)))
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-dispatch-'));
  dbPath = join(root, 'state.sqlite');
  now = 1_800_000_000_000;
  store = openStore();
  for (const id of ['inp-1', 'inp-2'])
    store.insertInput(
      { id, state: 'enabled', auth: 'bearer', secretRefs: [], filter: [], revision: 1 },
      now,
    );
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dispatchers.splice(0).map((running) => running.stop()));
  for (const open of opened.splice(0)) open.close();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('a committed handoff', () => {
  it('is delivered once with the exact body, then the body is deleted and the receipt closed', async () => {
    const receiptId = receive('msg_a');
    const seen: HandoffWork[] = [];
    const routine: Handle = (work) => {
      seen.push(work);
      return Promise.resolve('accepted');
    };

    await dispatcher({ routine }).runOnce();
    await dispatcher({ routine }).runOnce();

    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]?.body ?? []).equals(BODY)).toBe(true);
    expect(seen[0]?.handoff).toMatchObject({
      receiptId,
      consumerKind: 'routine',
      consumerId: 'trg-1',
      snapshot: ROUTINE.snapshot,
      attempts: 1,
      reservation: null,
    });
    expect(inbox()).toEqual({
      receipts: [{ id: receiptId, event_key: 'msg_a', outcome: 'closed' }],
      payloads: [],
      handoffs: [expect.objectContaining({ state: 'accepted', token: null, lease_until: 0 })],
    });
    expect(loggedText()).toContain('Incoming handoff accepted');
    expect(loggedText()).not.toContain(MARKER);
  });

  it('is delivered by a new dispatcher after the store is closed and reopened', async () => {
    receive('msg_a');
    store.close();
    opened.splice(0);
    const reopened = openStore();
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');

    await dispatcher({ routine }, { store: reopened }).runOnce();

    expect(routine).toHaveBeenCalledTimes(1);
    expect(inbox()).toMatchObject({ payloads: [], handoffs: [{ state: 'accepted' }] });
  });

  it('that the consumer skips is settled the same way', async () => {
    receive('msg_a');

    await dispatcher({ routine: () => Promise.resolve('skipped') }).runOnce();

    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'skipped' }],
    });
  });

  it('is delivered in the order it became due', async () => {
    const first = receive('msg_a');
    now += 10;
    const second = receive('msg_b');
    const order: string[] = [];

    await dispatcher({
      routine: ({ handoff }) => {
        order.push(handoff.receiptId);
        return Promise.resolve('accepted');
      },
    }).runOnce();

    expect(order).toEqual([first, second]);
  });
});

describe('a delivery with two consumers', () => {
  it('keeps its body through the first finish and loses it with the second', async () => {
    receive('msg_a', [ROUTINE, PROACTIVITY]);
    let atSecondStart: ReturnType<typeof inbox> | undefined;

    await dispatcher({
      routine: () => Promise.resolve('accepted'),
      proactivity: () => {
        atSecondStart = inbox();
        return Promise.resolve('skipped');
      },
    }).runOnce();

    expect(atSecondStart).toMatchObject({
      receipts: [{ outcome: 'open' }],
      payloads: [expect.anything()],
      handoffs: [{ state: 'accepted' }, { state: 'pending' }],
    });
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'accepted' }, { state: 'skipped' }],
    });
  });

  it('does not record a last finish whose body deletion fails', () => {
    receive('msg_a');
    const writer = new DatabaseSync(dbPath);
    writer.exec(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    writer.close();
    const claimed = store.claimHandoff(now, 1000);

    expect(() =>
      store.finishHandoff(claimed?.handoff.id ?? '', claimed?.token ?? '', 'accepted'),
    ).toThrow(/refused/);

    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'open' }],
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending', token: claimed?.token }],
    });
  });
});

describe('a lease', () => {
  it('lets only its current holder save, release or finish', () => {
    receive('msg_a');
    const other = openStore();

    const first = store.claimHandoff(now, 1000);
    expect(other.claimHandoff(now + 999, 1000)).toBeNull();
    const second = other.claimHandoff(now + 1000, 1000);

    expect(second?.handoff).toMatchObject({ id: first?.handoff.id, attempts: 2 });
    const id = first?.handoff.id ?? '';
    const before = inbox();
    expect(store.saveReservation(id, first?.token ?? '', 'stale')).toBe(false);
    expect(store.releaseHandoff(id, first?.token ?? '', now)).toBe('lost');
    expect(store.finishHandoff(id, first?.token ?? '', 'skipped')).toBe(false);
    expect(inbox()).toEqual(before);

    expect(other.saveReservation(id, second?.token ?? '', 'task-7')).toBe(true);
    expect(other.finishHandoff(id, second?.token ?? '', 'accepted')).toBe(true);
    expect(inbox()).toMatchObject({
      payloads: [],
      handoffs: [{ state: 'accepted', reservation: 'task-7' }],
    });
  });

  it('that a handler outlives records nothing once another dispatcher has taken over', async () => {
    receive('msg_a');
    const started = deferred<undefined>();
    const slow = deferred<'skipped'>();
    const holder = dispatcher({
      routine: () => {
        started.resolve(undefined);
        return slow.promise;
      },
    });
    // The second process reads a clock on which the first holder's lease has just ended.
    const taker = dispatcher(
      { routine: () => Promise.resolve('accepted') },
      { store: openStore(), clock: () => now + POLICY.leaseMs },
    );

    const held = holder.runOnce();
    await started.promise;
    await taker.runOnce();
    slow.resolve('skipped');
    await held;

    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'accepted', attempts: 2 }],
    });
    expect(loggedText()).toContain('lost its lease; nothing recorded');
  });

  it('gives each handoff to exactly one of two competing dispatchers', async () => {
    for (let n = 0; n < 20; n += 1) receive(`msg_${n}`);
    const handled: string[] = [];
    const routine: Handle = async ({ handoff }) => {
      await new Promise((resolve) => setImmediate(resolve));
      handled.push(handoff.id);
      return 'accepted';
    };

    await Promise.all([
      dispatcher({ routine }).runOnce(),
      dispatcher({ routine }, { store: openStore() }).runOnce(),
    ]);

    expect(handled).toHaveLength(20);
    expect(new Set(handled).size).toBe(20);
    expect(inbox().payloads).toEqual([]);
  });

  it('gives each handoff to exactly one of two processes that claim at the same moment', async () => {
    for (let n = 0; n < 150; n += 1) receive(`msg_${n}`);
    const workers = [claimingProcess(), claimingProcess()];
    await Promise.all(workers.map((worker) => worker.ready));

    for (const worker of workers) worker.go();
    const [one = [], two = []] = await Promise.all(workers.map((worker) => worker.claimed));

    // SQLite may let one process do most of the work; each handoff is still claimed exactly once.
    expect(one.length + two.length).toBe(150);
    expect(new Set([...one, ...two]).size).toBe(150);
    expect(inbox().payloads).toEqual([]);
  }, 30_000);
});

describe('a handler that fails', () => {
  it('is retried after its backoff, and the body is kept meanwhile', async () => {
    receive('msg_a');
    const routine = vi
      .fn<Handle>()
      .mockRejectedValueOnce(new Error('Slack is unavailable'))
      .mockResolvedValue('accepted');
    const running = dispatcher({ routine });

    await running.runOnce();
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'open' }],
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending', attempts: 1, token: null, lease_until: 0, due_at: now + 100 }],
    });

    now += 99;
    await running.runOnce();
    expect(routine).toHaveBeenCalledTimes(1);

    now += 1;
    await running.runOnce();
    expect(routine).toHaveBeenCalledTimes(2);
    expect(inbox()).toMatchObject({ payloads: [], handoffs: [{ state: 'accepted', attempts: 2 }] });
  });

  it('is failed for good after its last attempt, and the body is deleted', async () => {
    receive('msg_a');
    const routine = vi.fn<Handle>().mockRejectedValue(new Error('Slack is unavailable'));
    const running = dispatcher({ routine });

    for (let pass = 0; pass < 5; pass += 1) {
      await running.runOnce();
      now += 1000;
    }

    expect(routine).toHaveBeenCalledTimes(3);
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'failed', attempts: 3, token: null }],
    });
    expect(loggedText()).toContain('failed for good');
    expect(loggedText()).not.toContain(MARKER);
  });

  it('is failed without another run when it was interrupted during its last attempt', async () => {
    receive('msg_a');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.claimHandoff(now, POLICY.leaseMs);
      now += POLICY.leaseMs;
    }
    const routine = vi.fn<Handle>();

    await dispatcher({ routine }).runOnce();

    expect(routine).not.toHaveBeenCalled();
    expect(inbox()).toMatchObject({ payloads: [], handoffs: [{ state: 'failed', attempts: 4 }] });
  });

  it('finds its earlier reservation on the retry', async () => {
    receive('msg_a');
    const reservations: Array<string | null> = [];
    const running = dispatcher({
      routine: ({ handoff, saveReservation }) => {
        reservations.push(handoff.reservation);
        if (handoff.reservation) return Promise.resolve('accepted');
        saveReservation('task-42');
        return Promise.reject(new Error('Stopped after reserving the Task'));
      },
    });

    await running.runOnce();
    now += 100;
    await running.runOnce();

    expect(reservations).toEqual([null, 'task-42']);
    expect(inbox()).toMatchObject({ handoffs: [{ state: 'accepted', reservation: 'task-42' }] });
  });

  it('is retried when no consumer is registered for its kind', async () => {
    receive('msg_a');

    await dispatcher({}).runOnce();

    expect(inbox()).toMatchObject({
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending', attempts: 1, due_at: now + 100 }],
    });
  });

  it('is given up on when its lease ends and no sooner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    receive('msg_a');
    let late: HandoffWork | undefined;
    const pass = dispatcher({
      routine: (work) => {
        late = work;
        return new Promise(() => {});
      },
    }).runOnce();

    await vi.advanceTimersByTimeAsync(POLICY.leaseMs - 1);
    expect(typeof inbox().handoffs[0]?.token).toBe('string');

    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect(inbox()).toMatchObject({
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending', attempts: 1, token: null, due_at: now + 100 }],
    });
    expect(() => late?.saveReservation('too-late')).toThrow(/Lease lost/);
    expect(inbox()).toMatchObject({ handoffs: [{ reservation: null }] });
  });
});

describe('pausing or deleting an input', () => {
  it.each(['pauseInput', 'markInputDeleted'] as const)(
    '%s cancels handoffs nobody is working on and deletes their bodies',
    async (stop) => {
      receive('msg_a');
      receive('msg_b', [ROUTINE, PROACTIVITY]);
      const kept = receive('msg_c', [ROUTINE], 'inp-2');
      const routine = vi.fn<Handle>().mockResolvedValue('accepted');

      store[stop]('inp-1', now);

      expect(inbox()).toMatchObject({
        receipts: [{ outcome: 'closed' }, { outcome: 'closed' }, { id: kept, outcome: 'open' }],
        payloads: [{ receipt_id: kept }],
        handoffs: [
          { state: 'cancelled' },
          { state: 'cancelled' },
          { state: 'cancelled' },
          { state: 'pending' },
        ],
      });

      store.resumeInput('inp-1', now);
      await dispatcher({ routine }).runOnce();
      expect(routine).toHaveBeenCalledTimes(1);
    },
  );

  it('lets a handoff that is being worked on finish', async () => {
    receive('msg_a');
    const started = deferred<undefined>();
    const slow = deferred<'accepted'>();
    const running = dispatcher({
      routine: () => {
        started.resolve(undefined);
        return slow.promise;
      },
    }).runOnce();
    await started.promise;

    store.pauseInput('inp-1', now);
    expect(inbox()).toMatchObject({
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending' }],
    });

    slow.resolve('accepted');
    await running;
    expect(inbox()).toMatchObject({ payloads: [], handoffs: [{ state: 'accepted' }] });
  });

  it.each(['pauseInput', 'markInputDeleted'] as const)(
    '%s cancels a handoff being worked on as soon as its attempt fails, and a resume does not revive it',
    async (stop) => {
      receive('msg_a');
      const started = deferred<undefined>();
      const slow = deferred<'accepted'>();
      const routine = vi.fn<Handle>(() => {
        started.resolve(undefined);
        return slow.promise;
      });
      const running = dispatcher({ routine });

      const first = running.runOnce();
      await started.promise;
      store[stop]('inp-1', now);
      slow.reject(new Error('Slack is unavailable'));
      await first;

      expect(inbox()).toMatchObject({
        receipts: [{ outcome: 'closed' }],
        payloads: [],
        handoffs: [{ state: 'cancelled', token: null }],
      });
      expect(loggedText()).toContain('cancelled with its input paused or deleted');

      store.resumeInput('inp-1', now);
      now += 100;
      await running.runOnce();
      expect(routine).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels every handoff whose holder died, once its lease ends, without running it', async () => {
    receive('msg_a');
    receive('msg_b');
    store.claimHandoff(now, POLICY.leaseMs);
    store.claimHandoff(now, POLICY.leaseMs);
    store.pauseInput('inp-1', now);
    expect(inbox()).toMatchObject({ handoffs: [{ state: 'pending' }, { state: 'pending' }] });
    const routine = vi.fn<Handle>();

    now += POLICY.leaseMs;
    await dispatcher({ routine }).runOnce();

    expect(routine).not.toHaveBeenCalled();
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }, { outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'cancelled' }, { state: 'cancelled' }],
    });
  });

  it('cancels at once a handoff whose lease has already ended', () => {
    receive('msg_a');
    store.claimHandoff(now, POLICY.leaseMs);

    store.pauseInput('inp-1', now + POLICY.leaseMs);

    expect(inbox()).toMatchObject({
      payloads: [],
      handoffs: [{ state: 'cancelled', token: null }],
    });
  });
});

describe('the sweep', () => {
  it('fails a handoff past the age limit, without running it, and deletes its body', async () => {
    receive('msg_old');
    now += 7 * DAY;
    receive('msg_new');
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');

    await dispatcher({ routine }).runOnce();

    expect(routine).toHaveBeenCalledTimes(1);
    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'closed' }, { outcome: 'closed' }],
      payloads: [],
      handoffs: [{ state: 'failed' }, { state: 'accepted' }],
    });
    expect(loggedText()).toContain('failed 1 stale handoffs');
  });

  it('removes settled receipts past retention, after which their keys are new again', async () => {
    const running = dispatcher({ routine: () => Promise.resolve('accepted') });
    receive('msg_old');
    store.receive(
      {
        inputId: 'inp-1',
        binding: 'generic',
        eventKey: 'msg_ignored',
        digest: 'd',
        body: BODY,
        receivedAt: now,
      },
      [],
    );
    await running.runOnce();
    now += 29 * DAY;
    const recent = receive('msg_recent');
    await running.runOnce();

    now += DAY;
    await running.runOnce();

    expect(inbox()).toMatchObject({
      receipts: [{ id: recent, event_key: 'msg_recent' }],
      handoffs: [{ state: 'accepted' }],
    });
    expect(inbox().handoffs).toHaveLength(1);
    expect(receive('msg_old')).toMatch(/^rcp-/);
  });

  it('leaves a handoff that is being worked on, however old its delivery', () => {
    receive('msg_a');
    now += 31 * DAY;
    store.claimHandoff(now, 1000);

    expect(store.sweep(now, now - 7 * DAY, now - 30 * DAY)).toEqual({ failed: 0, purged: 0 });

    expect(inbox()).toMatchObject({
      receipts: [{ outcome: 'open' }],
      payloads: [expect.anything()],
      handoffs: [{ state: 'pending' }],
    });
  });

  it('fails a handoff whose holder died, once its lease has ended', () => {
    receive('msg_a');
    store.claimHandoff(now, POLICY.leaseMs);
    now += 7 * DAY;

    expect(store.sweep(now, now - 7 * DAY, now - 30 * DAY)).toEqual({ failed: 1, purged: 0 });

    expect(inbox()).toMatchObject({ payloads: [], handoffs: [{ state: 'failed', token: null }] });
  });

  it('is checked again between the handoffs of one long pass', async () => {
    receive('msg_a');
    receive('msg_b');
    const sweep = vi.spyOn(store, 'sweep');

    await dispatcher({
      routine: () => {
        now += POLICY.sweepEveryMs;
        return Promise.resolve('accepted');
      },
    }).runOnce();

    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('that fails is reported and does not hold up deliveries', async () => {
    receive('msg_a');
    vi.spyOn(store, 'sweep').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');

    await dispatcher({ routine }).runOnce();

    expect(routine).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('Incoming sweep failed');
  });

  it('runs once per sweep interval', async () => {
    const sweep = vi.spyOn(store, 'sweep');
    const running = dispatcher({});

    await running.runOnce();
    now += POLICY.sweepEveryMs - 1;
    await running.runOnce();
    expect(sweep).toHaveBeenCalledTimes(1);

    now += 1;
    await running.runOnce();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

describe('a pass', () => {
  it('is shared by everyone who asks while it runs', async () => {
    receive('msg_a');
    receive('msg_b');
    const started = deferred<undefined>();
    const slow = deferred<'accepted'>();
    const routine = vi.fn<Handle>(() => {
      started.resolve(undefined);
      return slow.promise;
    });
    const running = dispatcher({ routine });

    const passes = [running.runOnce(), running.runOnce()];
    await started.promise;
    expect(routine).toHaveBeenCalledTimes(1);

    slow.resolve('accepted');
    await Promise.all(passes);
    expect(routine).toHaveBeenCalledTimes(2);
  });

  it('lets other work run between handoffs even when handlers finish at once', async () => {
    for (let n = 0; n < 5; n += 1) receive(`msg_${n}`);
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');
    let handledWhenOtherWorkRan = -1;
    setImmediate(() => {
      handledWhenOtherWorkRan = routine.mock.calls.length;
    });

    await dispatcher({ routine }).runOnce();

    expect(handledWhenOtherWorkRan).toBe(1);
    expect(routine).toHaveBeenCalledTimes(5);
  });

  it('does nothing once the dispatcher was stopped', async () => {
    receive('msg_a');
    const routine = vi.fn<Handle>();
    const running = dispatcher({ routine });
    await running.stop();
    const sweep = vi.spyOn(store, 'sweep');

    await running.runOnce();

    expect(sweep).not.toHaveBeenCalled();
    expect(routine).not.toHaveBeenCalled();
  });
});

describe('the polling loop, using real timers', () => {
  it('delivers without being asked, and not after it is stopped', async () => {
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');
    const running = dispatcher({ routine });
    receive('msg_a');

    running.start();
    await vi.waitFor(() => expect(routine).toHaveBeenCalledTimes(1));

    await running.stop();
    receive('msg_b');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(routine).toHaveBeenCalledTimes(1);
  });

  it('reports a pass that fails and delivers on the next one', async () => {
    const routine = vi.fn<Handle>().mockResolvedValue('accepted');
    vi.spyOn(store, 'claimHandoff').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    receive('msg_a');

    dispatcher({ routine }).start();

    await vi.waitFor(() => expect(routine).toHaveBeenCalledTimes(1));
    expect(loggedText()).toContain('Incoming dispatcher pass failed');
  });

  it('reports a failed pass once, however many ticks it spanned', async () => {
    receive('msg_a');
    vi.spyOn(store, 'finishHandoff').mockImplementationOnce(() => {
      throw new Error('disk is full');
    });
    const routine: Handle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 'accepted';
    };

    dispatcher({ routine }).start();

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('waits on stop for the attempt in flight and starts no other', async () => {
    receive('msg_a');
    receive('msg_b');
    const started = deferred<undefined>();
    const slow = deferred<'accepted'>();
    const routine = vi.fn<Handle>(() => {
      started.resolve(undefined);
      return slow.promise;
    });
    const running = dispatcher({ routine });
    const pass = running.runOnce();
    await started.promise;

    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    slow.resolve('accepted');
    await stopping;
    await pass;
    expect(routine).toHaveBeenCalledTimes(1);
    expect(inbox()).toMatchObject({ handoffs: [{ state: 'accepted' }, { state: 'pending' }] });
  });
});
