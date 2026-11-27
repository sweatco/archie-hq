// SPDX-License-Identifier: AGPL-3.0-or-later
/** One handoff becomes one Task: the real inbox file, trigger records and Task folders, with the agent spawn and Slack stubbed. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // The workdir module reads this once, when it is first imported.
  process.env.ARCHIE_WORKDIR = mkdtempSync(join(tmpdir(), 'archie-routine-start-'));
  return {
    spawn: vi.fn<typeof import('../../agents/spawn.js').spawnAgent>(),
    post: vi.fn<typeof import('../../connectors/slack/client.js').postSlackMessage>(),
    files: vi.fn<typeof import('../../connectors/slack/client.js').postSlackFiles>(),
    channel: vi.fn<typeof import('../../connectors/slack/client.js').channelReachability>(),
    channelInfo: vi.fn(),
    /** Runs after the Task is prepared and before it starts. */
    betweenPrepareAndStart: vi.fn(async (): Promise<void> => {}),
  };
});
vi.mock('../plugin-sync.js', () => ({ syncPlugins: vi.fn(async () => {}) }));
vi.mock('../../agents/registry.js', async (original) => ({
  ...(await original<typeof import('../../agents/registry.js')>()),
  scanPmDef: () => ({
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: '',
    pluginName: 'core',
    visibility: 'global',
    isPm: true,
  }),
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: fixture.spawn }));
vi.mock('../../connectors/slack/client.js', async (original) => ({
  ...(await original<typeof import('../../connectors/slack/client.js')>()),
  postSlackMessage: fixture.post,
  postSlackFiles: fixture.files,
  channelReachability: fixture.channel,
  getChannelInfo: fixture.channelInfo,
}));
vi.mock('../../connectors/slack/channel-canvas.js', async (original) => ({
  ...(await original<typeof import('../../connectors/slack/channel-canvas.js')>()),
  ensureChannelCanvas: fixture.betweenPrepareAndStart,
}));
vi.mock('../../connectors/slack/channel-pins.js', async (original) => ({
  ...(await original<typeof import('../../connectors/slack/channel-pins.js')>()),
  ensureChannelPins: vi.fn(async () => {}),
}));

import { MessageQueue } from '../../agents/message-queue.js';
import { setOpenInbox } from '../../incoming/access.js';
import { IncomingDispatcher, type DispatchPolicy } from '../../incoming/dispatcher.js';
import { IncomingStore } from '../../incoming/store.js';
import { loadMetadata, getSharedPath, getTaskPath } from '../../tasks/persistence.js';
import { Task, activeTasks } from '../../tasks/task.js';
import { expectDefined } from '../../test-support/assertions.js';
import type { TaskMetadata } from '../../types/task.js';
import type { Trigger, TriggerBinding } from '../../types/trigger.js';
import { routineConsumer } from '../routine-consumer.js';
import {
  dailyFireCount,
  deindexTrigger,
  fireTrigger,
  getEnabledTrigger,
  indexTrigger,
} from '../trigger-scheduler.js';
import { deleteTrigger, loadTrigger, saveTrigger, updateLiveTrigger } from '../trigger-store.js';
import { SESSIONS_DIR, TRIGGERS_DIR, WORKDIR } from '../workdir.js';

const HOUR = 60 * 60_000;
const POLICY: DispatchPolicy = {
  leaseMs: 60_000,
  retryDelaysMs: [1000, 2000],
  pollMs: 5,
  sweepEveryMs: HOUR,
  handoffMaxAgeMs: 7 * 24 * HOUR,
  receiptRetentionMs: 30 * 24 * HOUR,
};
const MARKER = 'RAW-BODY-MARKER-402b';
const EVENT = JSON.stringify({ type: 'meeting.ended', note: MARKER });
const PROMPT = 'Summarize the meeting for the team.';
const ROUTINE_ID = 'trg-20261121-0900-notes1';
const INPUT_ID = 'inp-AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_INPUT_ID = 'inp-BBBBBBBBBBBBBBBBBBBBBB';
const NOTES: TriggerBinding = { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' };
const THREAD_TS = '1792490401.000001';

let dbPath: string;
let store: IncomingStore;
let now: number;
let inboxes = 0;

async function routine(over: Partial<Trigger> = {}): Promise<Trigger> {
  const trigger: Trigger = {
    id: ROUTINE_ID,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-21T09:00:00.000Z',
    binding: NOTES,
    conditions: [{ type: 'incoming_event', input_id: INPUT_ID }],
    action: { prompt: PROMPT },
    summary: 'Meeting notes',
    ...over,
  };
  await saveTrigger(trigger);
  indexTrigger(trigger);
  store.linkRoutine(INPUT_ID, trigger.id);
  return trigger;
}

/** Commits a delivery as the receiver does: the consumer's own match, then the receipt. */
function deliver(eventKey = 'msg_1'): string {
  const input = expectDefined(store.input(INPUT_ID));
  const event = z.record(z.string(), z.unknown()).parse(JSON.parse(EVENT));
  const matches = routineConsumer
    .match(input, event)
    .map((match) => ({ kind: routineConsumer.kind, ...match }));
  return store.receive(
    {
      inputId: INPUT_ID,
      binding: 'generic',
      eventKey,
      digest: createHash('sha256').update(EVENT).digest('hex'),
      body: Buffer.from(EVENT),
      receivedAt: now,
    },
    matches,
  ).status;
}

function dispatch(): Promise<void> {
  return new IncomingDispatcher(store, [routineConsumer], POLICY, () => now).runOnce();
}

const handoffRowSchema = z.object({
  id: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  attempts: z.number(),
  snapshot: z.string(),
  reservation: z.string().nullable(),
});

/** Inbox state read through a second connection. */
function inbox() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const handoffs = db
      .prepare('SELECT * FROM handoffs ORDER BY rowid')
      .all()
      .map((row) => handoffRowSchema.parse(row));
    return { handoffs, bodies: db.prepare('SELECT 1 FROM payloads').all().length };
  } finally {
    db.close();
  }
}

function reservedTaskId(): string | undefined {
  const reservation = inbox().handoffs[0]?.reservation;
  return reservation
    ? z.object({ task_id: z.string() }).parse(JSON.parse(reservation)).task_id
    : undefined;
}

function taskIds(): string[] {
  return existsSync(SESSIONS_DIR)
    ? readdirSync(SESSIONS_DIR).filter((name) => name.startsWith('task-'))
    : [];
}

async function onlyTask(): Promise<TaskMetadata> {
  const ids = taskIds();
  expect(ids).toHaveLength(1);
  return expectDefined(await loadMetadata(expectDefined(ids[0])));
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  fixture.spawn.mockImplementation(async (agent) => {
    agent.handle = { isRunning: true, running: new Promise(() => {}), abort: vi.fn() };
  });
  fixture.post.mockResolvedValue(THREAD_TS);
  fixture.channel.mockResolvedValue('reachable');
  fixture.betweenPrepareAndStart.mockResolvedValue(undefined);

  now = 1_800_000_000_000;
  dbPath = join(WORKDIR, `inbox-${++inboxes}.sqlite`);
  store = new IncomingStore(dbPath);
  setOpenInbox(store);
  for (const id of [INPUT_ID, OTHER_INPUT_ID])
    store.insertInput(
      {
        id,
        state: 'enabled',
        auth: 'bearer',
        secretRefs: [],
        filter: [],
        routines: [],
        revision: 1,
        owner: null,
        purpose: '',
      },
      now,
    );
});

afterEach(async () => {
  activeTasks.clear();
  deindexTrigger(ROUTINE_ID);
  setOpenInbox(null);
  store.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const mock of Object.values(fixture)) mock.mockReset();
  await rm(SESSIONS_DIR, { recursive: true, force: true });
  await rm(TRIGGERS_DIR, { recursive: true, force: true });
});

describe('a handoff for a linked routine', () => {
  it('starts one Task homed in the routine conversation, with the event in a file of its own', async () => {
    await routine();
    const wakes = vi.spyOn(MessageQueue.prototype, 'addMessage');
    const slotsBefore = dailyFireCount();

    expect(deliver()).toBe('accepted');
    await dispatch();

    const { handoffs, bodies } = inbox();
    expect(handoffs).toMatchObject([{ state: 'accepted', reason: null, attempts: 1 }]);
    expect(bodies).toBe(0);
    const task = await onlyTask();
    expect(task).toMatchObject({
      task_id: reservedTaskId(),
      status: 'in_progress',
      channels: {},
      default_channel: null,
      home_channel: { channel_id: 'C0NOTES', channel_name: 'notes' },
      memory_destination: { channel_id: 'C0NOTES' },
      triggered_by: ROUTINE_ID,
      triggered_start: { origin: handoffs[0]?.id, input_id: INPUT_ID, phase: 'ready' },
    });

    const eventPath = join(getSharedPath(task.task_id), 'incoming-event.json');
    expect(readFileSync(eventPath, 'utf8')).toBe(EVENT);
    const brief = expectDefined(task.triggered_start).brief;
    expect(brief).toContain(PROMPT);
    expect(brief).toContain(eventPath);
    expect(brief).toContain('untrusted data');
    expect(brief).toContain('#notes');
    expect(wakes.mock.calls.map((call) => call[0])).toEqual([brief]);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);

    expect(dailyFireCount() - slotsBefore).toBe(1);
    expect((await loadTrigger(ROUTINE_ID))?.last_fired_at).toEqual(expect.any(String));
  });

  it('keeps the event body in its file only', async () => {
    await routine();
    deliver();
    await dispatch();

    const task = await onlyTask();
    const eventPath = join(getSharedPath(task.task_id), 'incoming-event.json');
    const elsewhere = filesUnder(getTaskPath(task.task_id)).filter((path) => path !== eventPath);
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const path of elsewhere) expect(readFileSync(path, 'utf8')).not.toContain(MARKER);
    expect(JSON.stringify(inbox().handoffs)).not.toContain(MARKER);
  });

  it('starts no second Task for a repeated delivery', async () => {
    await routine();
    deliver('msg_a');
    await dispatch();

    expect(deliver('msg_a')).toBe('duplicate');
    await dispatch();

    expect(taskIds()).toHaveLength(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
  });

  it('opens its own thread with its first post', async () => {
    await routine();
    deliver();
    await dispatch();
    const task = await Task.get((await onlyTask()).task_id);

    await task.postToUser('Here is the summary.', 'pm-agent');
    await task.postToUser('One more thing.', 'pm-agent');

    expect(fixture.post.mock.calls.map(([post]) => [post.channel, post.threadTs])).toEqual([
      ['C0NOTES', undefined],
      ['C0NOTES', THREAD_TS],
    ]);
    expect(task.metadata.default_channel).toBe(`slack:C0NOTES:${THREAD_TS}`);
  });

  it('runs on the prompt it was received under while a later edit and the fire both reach the record', async () => {
    await routine();
    deliver();

    await Promise.all([
      dispatch(),
      updateLiveTrigger(ROUTINE_ID, (stored) => {
        stored.action.prompt = 'File a ticket instead.';
      }),
    ]);

    const brief = expectDefined((await onlyTask()).triggered_start).brief;
    expect(brief).toContain(PROMPT);
    expect(brief).not.toContain('File a ticket instead.');
    const stored = expectDefined(await loadTrigger(ROUTINE_ID));
    expect(stored.action.prompt).toBe('File a ticket instead.');
    expect(stored.last_fired_at).toBeDefined();
  });

  it('starts a Task homed in a DM for a DM routine', async () => {
    const dm: TriggerBinding = {
      type: 'user',
      user_id: 'U0DANA',
      channel_id: 'D0DANA',
      channel_name: 'DM with Dana',
    };
    fixture.channelInfo.mockResolvedValue({ id: 'D0DANA', isIm: true, imUserId: 'U0DANA' });
    await routine({ binding: dm });
    deliver();

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'accepted' }]);
    expect(await onlyTask()).toMatchObject({
      status: 'in_progress',
      home_channel: { channel_id: 'D0DANA' },
      memory_destination: { channel_id: 'D0DANA' },
    });
    expect(fixture.channel).not.toHaveBeenCalled();
  });
});

describe('an interrupted start is continued by the retry', () => {
  const crash = new Error('process stopped');
  const cases: Array<[string, TaskMetadata['status'] | 'absent', () => void]> = [
    [
      'before preparation',
      'absent',
      () => vi.spyOn(Task, 'prepareTriggered').mockRejectedValueOnce(crash),
    ],
    [
      'after preparation',
      'preparing',
      () => vi.spyOn(Task.prototype, 'startTriggered').mockRejectedValueOnce(crash),
    ],
    [
      'after activation',
      'in_progress',
      () => {
        const start = Task.prototype.startTriggered;
        vi.spyOn(Task.prototype, 'startTriggered').mockImplementationOnce(async function (
          this: Task,
        ) {
          await start.call(this);
          throw crash;
        });
      },
    ],
  ];

  it.each(cases)('%s', async (_name, leftBehind, interrupt) => {
    await routine();
    deliver();
    const wakes = vi.spyOn(MessageQueue.prototype, 'addMessage');
    const slotsBefore = dailyFireCount();
    interrupt();

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'pending', attempts: 1 }]);
    const reserved = expectDefined(reservedTaskId());
    expect((await loadMetadata(reserved))?.status ?? 'absent').toBe(leftBehind);

    now += 1000;
    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'accepted', attempts: 2 }]);
    expect(await onlyTask()).toMatchObject({
      task_id: reserved,
      status: 'in_progress',
      triggered_start: { phase: 'ready' },
    });
    expect(dailyFireCount() - slotsBefore).toBe(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(wakes).toHaveBeenCalledTimes(1);
  });

  it('puts a Task whose first wake failed back to prepared, and starts it on the retry', async () => {
    await routine();
    deliver();
    const wakes = vi.spyOn(MessageQueue.prototype, 'addMessage');
    fixture.spawn.mockRejectedValueOnce(new Error('spawn failed'));

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'pending', attempts: 1 }]);
    expect(await onlyTask()).toMatchObject({
      status: 'preparing',
      triggered_start: { phase: 'prepared' },
    });
    expect(activeTasks.size).toBe(0);
    expect(wakes).not.toHaveBeenCalled();

    now += 1000;
    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'accepted', attempts: 2 }]);
    expect(await onlyTask()).toMatchObject({
      status: 'in_progress',
      triggered_start: { phase: 'ready' },
    });
    expect(wakes).toHaveBeenCalledTimes(1);
  });

  it('does not call a Task started while its first wake can still fail', async () => {
    await routine();
    deliver();
    let failWake: (error: Error) => void = () => undefined;
    fixture.spawn.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (failWake = reject)),
    );
    const attempt = dispatch();
    for (let turn = 0; turn < 200 && fixture.spawn.mock.calls.length === 0; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(await onlyTask()).toMatchObject({ triggered_start: { phase: 'ready' } });

    const started = Task.startedFor(
      expectDefined(reservedTaskId()),
      expectDefined(inbox().handoffs[0]).id,
    );
    failWake(new Error('spawn failed'));
    await attempt;

    await expect(started).resolves.toBe(false);
  });

  it('gives up after the last attempt with the reason and no Task', async () => {
    await routine();
    deliver();
    vi.spyOn(Task, 'prepareTriggered').mockRejectedValue(crash);
    const slotsBefore = dailyFireCount();

    for (const wait of [0, 1000, 2000]) {
      now += wait;
      await dispatch();
    }

    expect(inbox()).toMatchObject({
      handoffs: [{ state: 'failed', reason: 'attempts_exhausted', attempts: 3 }],
      bodies: 0,
    });
    expect(reservedTaskId()).toEqual(expect.any(String));
    expect(taskIds()).toEqual([]);
    expect(dailyFireCount() - slotsBefore).toBe(1);
  });

  it('retries a DM routine whose conversation belongs to someone else, and starts nothing', async () => {
    fixture.channelInfo.mockResolvedValue({ id: 'D0DANA', isIm: true, imUserId: 'U0OTHER' });
    await routine({
      binding: { type: 'user', user_id: 'U0DANA', channel_id: 'D0DANA', channel_name: 'Dana' },
    });
    deliver();

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'pending', attempts: 1 }]);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});

describe('work that may no longer run is skipped with its reason', () => {
  const pause = async () => {
    await updateLiveTrigger(ROUTINE_ID, (stored) => {
      stored.status = 'paused';
    });
    deindexTrigger(ROUTINE_ID);
  };
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['routine_paused', pause],
    [
      'routine_deleted',
      async () => {
        await deleteTrigger(ROUTINE_ID);
        deindexTrigger(ROUTINE_ID);
      },
    ],
    [
      'routine_changed',
      async () => {
        const changed = await updateLiveTrigger(ROUTINE_ID, (stored) => {
          stored.conditions = [{ type: 'incoming_event', input_id: OTHER_INPUT_ID }];
        });
        indexTrigger(expectDefined(changed));
      },
    ],
    ['routine_unlinked', () => void store.unlinkRoutine(INPUT_ID, ROUTINE_ID)],
    ['triggers_disabled', () => void vi.stubEnv('ARCHIE_TRIGGERS_ENABLED', 'false')],
    ['destination_unreachable', () => void fixture.channel.mockResolvedValue('gone')],
    // The input stops while the attempt holds the lease, so the inbox leaves the handoff to the consumer.
    [
      'input_paused',
      () =>
        void fixture.betweenPrepareAndStart.mockImplementationOnce(async () => {
          store.pauseInput(INPUT_ID, now);
        }),
    ],
    [
      'input_deleted',
      () =>
        void fixture.betweenPrepareAndStart.mockImplementationOnce(async () => {
          store.markInputDeleted(INPUT_ID, now);
        }),
    ],
  ];

  it('retries, and skips nothing, when an enabled routine is not in the index yet', async () => {
    await routine();
    deliver();
    deindexTrigger(ROUTINE_ID);

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'pending', attempts: 1 }]);
  });

  it.each(cases)('%s', async (reason, change) => {
    await routine();
    deliver();
    await change();

    await dispatch();

    expect(inbox()).toMatchObject({ handoffs: [{ state: 'skipped', reason }], bodies: 0 });
    expect(taskIds()).toEqual([]);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('discards the Task an earlier attempt prepared', async () => {
    await routine();
    deliver();
    const slotsBefore = dailyFireCount();
    vi.spyOn(Task.prototype, 'startTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    expect((await onlyTask()).status).toBe('preparing');
    expect(dailyFireCount()).toBe(slotsBefore + 1);

    await pause();
    now += 1000;
    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'skipped', reason: 'routine_paused' }]);
    expect(taskIds()).toEqual([]);
    expect(dailyFireCount()).toBe(slotsBefore);
  });

  it('pauses the routine under the store lock when its channel is gone', async () => {
    await routine();
    deliver();
    fixture.channel.mockResolvedValue('gone');

    await dispatch();

    expect((await loadTrigger(ROUTINE_ID))?.status).toBe('paused');
    expect(getEnabledTrigger(ROUTINE_ID)).toBeUndefined();
    expect(fixture.post.mock.calls.map(([post]) => post.channel)).toEqual(['U0DANA']);
  });

  it('retries, with the routine left on, when Slack cannot say whether its channel is there', async () => {
    await routine();
    deliver();
    fixture.channel.mockResolvedValueOnce('unknown');

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'pending', attempts: 1 }]);
    expect((await loadTrigger(ROUTINE_ID))?.status).toBe('enabled');
    expect(getEnabledTrigger(ROUTINE_ID)).toBeDefined();
    expect(fixture.post).not.toHaveBeenCalled();

    now += 1000;
    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'accepted', attempts: 2 }]);
  });

  it('skips at the daily allowance, which other triggers share, without a message per event', async () => {
    // Another day, so the allowance this test uses up is free again for the tests after it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T12:00:00Z'));
    await routine();
    deliver();
    const scheduled: Trigger = {
      ...(await routine()),
      id: 'trg-20261121-0900-daily0',
      binding: { type: 'user', user_id: 'U0DANA', channel_id: 'D0DANA', channel_name: 'Dana' },
      conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2099-01-01T09:00:00.000Z' }],
    };
    const stubTask = {
      taskId: 'task-stub',
      metadata: {},
      setMemoryDestination: vi.fn(),
      save: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
    };
    while (dailyFireCount() < 200)
      await fireTrigger(scheduled, { kind: 'schedule' }, () => Promise.resolve(stubTask as never));

    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'skipped', reason: 'daily_cap' }]);
    expect(reservedTaskId()).toBeUndefined();
    expect(taskIds()).toEqual([]);
    expect(fixture.post).not.toHaveBeenCalled();
  });
});

describe('a handoff the inbox ends by itself', () => {
  it('has its prepared Task removed with the next sweep', async () => {
    await routine();
    deliver();
    vi.spyOn(Task.prototype, 'startTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    expect((await onlyTask()).status).toBe('preparing');

    store.pauseInput(INPUT_ID, now);
    expect(inbox().handoffs).toMatchObject([{ state: 'cancelled', reason: 'input_paused' }]);
    now += HOUR;
    await dispatch();

    expect(taskIds()).toEqual([]);
  });

  it('gives the run slot of a discarded Task back once', async () => {
    await routine();
    deliver('msg_1');
    await dispatch();
    const used = dailyFireCount();
    deliver('msg_2');
    vi.spyOn(Task.prototype, 'startTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    expect(dailyFireCount()).toBe(used + 1);

    store.pauseInput(INPUT_ID, now);
    now += HOUR;
    await dispatch();
    now += HOUR;
    await dispatch();

    expect(dailyFireCount()).toBe(used);
    expect(taskIds()).toHaveLength(1);
  });

  it('removes a prepared Task listed after a reservation it cannot read', async () => {
    await routine();
    deliver('msg_1');
    vi.spyOn(Task, 'prepareTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE handoffs SET reservation='not json'").run();
    db.close();
    deliver('msg_2');
    vi.spyOn(Task.prototype, 'startTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    expect((await onlyTask()).status).toBe('preparing');

    store.pauseInput(INPUT_ID, now);
    now += HOUR;
    await dispatch();

    expect(taskIds()).toEqual([]);
  });

  it('keeps a Task that had already started', async () => {
    await routine();
    deliver();
    const start = Task.prototype.startTriggered;
    vi.spyOn(Task.prototype, 'startTriggered').mockImplementationOnce(async function (this: Task) {
      await start.call(this);
      throw new Error('process stopped');
    });
    await dispatch();

    store.pauseInput(INPUT_ID, now);
    now += HOUR;
    await dispatch();

    expect(inbox().handoffs).toMatchObject([{ state: 'cancelled', reason: 'input_paused' }]);
    expect((await onlyTask()).status).toBe('in_progress');
  });

  it('has the event of a preparation that never wrote its metadata removed', async () => {
    await routine();
    deliver();
    vi.spyOn(Task, 'prepareTriggered').mockRejectedValueOnce(new Error('process stopped'));
    await dispatch();
    const shared = getSharedPath(expectDefined(reservedTaskId()));
    const orphan = join(shared, 'incoming-event.json');
    await mkdir(shared, { recursive: true });
    await writeFile(orphan, EVENT);

    store.pauseInput(INPUT_ID, now);
    now += HOUR;
    await dispatch();

    expect(existsSync(orphan)).toBe(false);
  });
});

describe('a Task an event started, once it runs', () => {
  const UNLINKED = /may no longer use the incoming events input/;
  const INBOX_CLOSED = /incoming events inbox is not open/;

  /** Starts the Task and opens its thread, so a later post and file share have somewhere to go. */
  async function started(): Promise<Task> {
    await routine();
    deliver();
    await dispatch();
    const task = await Task.get((await onlyTask()).task_id);
    await task.postToUser('Here is the summary.', 'pm-agent');
    return task;
  }

  it.each<[string, () => void, RegExp]>([
    [
      'the operator unlinks its routine',
      () => void store.unlinkRoutine(INPUT_ID, ROUTINE_ID),
      UNLINKED,
    ],
    ['its input is deleted', () => void store.markInputDeleted(INPUT_ID, now), UNLINKED],
    ['the inbox closes', () => setOpenInbox(null), INBOX_CLOSED],
  ])('has its next post and file share refused after %s', async (_name, revoke, refusal) => {
    const task = await started();

    revoke();

    await expect(task.postToUser('One more thing.', 'pm-agent')).rejects.toThrow(refusal);
    await expect(task.postFilesToUser(['/tmp/notes.md'], 'pm-agent')).rejects.toThrow(refusal);
    await expect(task.prepareMemoryDelivery('C0NOTES')).rejects.toThrow(refusal);
    expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(fixture.files).not.toHaveBeenCalled();
  });

  it.each<[string, () => void | Promise<void>]>([
    ['its input is paused', () => void store.pauseInput(INPUT_ID, now)],
    [
      'its routine is paused',
      async () => {
        await updateLiveTrigger(ROUTINE_ID, (stored) => {
          stored.status = 'paused';
        });
        deindexTrigger(ROUTINE_ID);
      },
    ],
    [
      'another routine is unlinked',
      () => {
        store.linkRoutine(INPUT_ID, 'trg-20261121-0900-ticket');
        store.unlinkRoutine(INPUT_ID, 'trg-20261121-0900-ticket');
      },
    ],
  ])('keeps posting and sharing files after %s', async (_name, change) => {
    const task = await started();

    await change();

    await task.postToUser('One more thing.', 'pm-agent');
    await task.postFilesToUser(['/tmp/notes.md'], 'pm-agent');
    expect(fixture.post).toHaveBeenCalledTimes(2);
    expect(fixture.files).toHaveBeenCalledTimes(1);
  });
});
