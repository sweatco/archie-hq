/**
 * `fireTrigger` — what a fired trigger's task owns before its first agent turn.
 *
 * A trigger fire spawns a brand-new task, and the only thing that task knows about the world is what this function wires into it. Two properties are pinned here.
 *
 * On a MESSAGE fire the triggering message has to be ingested, not announced: it goes through `Task.append`, the same path every other Slack task uses, so the message lands in knowledge.log under the single renderer with its `msg:<ts>` id and its redaction verdict, and the thread it was posted in becomes the task's default channel. That matters because a delegated repo or plugin agent sees ONLY knowledge.log — before this, the rendered body was passed to `fireTrigger` and dropped on the floor, so such an agent could not know what was said. The ingestion floor covers the case `fetchSlackThread` cannot: it drops a raw message with neither a `user` nor a `botId`, so the triggering message is sometimes absent from the thread it was fetched from, and the rendered body is written directly instead.
 *
 * On a SCHEDULE fire there is no thread at all, so the task is homed in the bound channel instead: `home_channel` is what lets its first `post_to_user` open the task's own thread there, which is what makes a human reply to the result land back on the task that produced it rather than on a stranger. That channel's standing context — its canvas brief and its pin index — is refreshed as part of the fire, before `sendMessage` assembles the first agent's system prompt, because inbound Slack events are the only other thing that refreshes those stores and a scheduled run is not one.
 *
 * The seams are mocked at module level, but `Task` deliberately is not fully replaced — only its static factory is. One describe below drives the REAL `Task.append` through `fireTrigger`, because "the redaction policy applies to a triggered task too" is a claim about the real ingestion path and a fake `append` spy cannot support it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackThread, TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';
import type { Trigger } from '../../types/trigger.js';

const CHANNEL = 'C0WATCHED';
const CHANNEL_NAME = 'watched';
const TRIGGER_TS = '1700000000.000100';
const BODY = 'deploy failed on prod (build 4711)';

const {
  taskCreateMock,
  appendSlackMessageMock,
  downloadMessageFilesMock,
  isChannelReachableMock,
  fetchChannelIsPrivateMock,
  postSlackMessageMock,
  saveTriggerMock,
  ensureChannelCanvasMock,
  ensureChannelPinsMock,
} = vi.hoisted(() => ({
  taskCreateMock: vi.fn(),
  appendSlackMessageMock: vi.fn(),
  downloadMessageFilesMock: vi.fn(),
  isChannelReachableMock: vi.fn(),
  fetchChannelIsPrivateMock: vi.fn(),
  postSlackMessageMock: vi.fn(),
  saveTriggerMock: vi.fn(),
  ensureChannelCanvasMock: vi.fn(),
  ensureChannelPinsMock: vi.fn(),
}));

// Partial mocks throughout (`importOriginal` + override) rather than bare factories: `Task` pulls in the
// slack client, persistence and the canvas/pins modules for its own reasons, and a factory listing only
// the handful of exports this file cares about would break those imports instead of the test.
vi.mock('../../tasks/task.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tasks/task.js')>();
  // The real class is kept — the last describe constructs one and lets `append` run for real — and only
  // the static factory `fireTrigger` calls is replaced.
  return { ...actual, Task: Object.assign(actual.Task, { create: taskCreateMock }) };
});

vi.mock('../../tasks/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tasks/persistence.js')>();
  return { ...actual, appendSlackMessage: appendSlackMessageMock, downloadMessageFiles: downloadMessageFilesMock };
});

vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    isChannelReachable: isChannelReachableMock,
    fetchChannelIsPrivate: fetchChannelIsPrivateMock,
    postSlackMessage: postSlackMessageMock,
    // The Slack client is never initialised here, so the real predicate has no home team and would
    // redact every author, making the ordinary path a dead branch. Stand in for a verified one.
    isTrustedIngestAuthor: (user: { teamId?: string }) => user.teamId !== 'T_OTHER',
  };
});

vi.mock('../../connectors/slack/channel-canvas.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/channel-canvas.js')>();
  return { ...actual, ensureChannelCanvas: ensureChannelCanvasMock };
});

vi.mock('../../connectors/slack/channel-pins.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/channel-pins.js')>();
  return { ...actual, ensureChannelPins: ensureChannelPinsMock };
});

vi.mock('../trigger-store.js', () => ({
  saveTrigger: saveTriggerMock,
  deleteTrigger: vi.fn(),
  listTriggers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

vi.mock('../logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(), agent: vi.fn(),
  },
}));

import { fireTrigger } from '../trigger-scheduler.js';
import { Task } from '../../tasks/task.js';

// The constructor is private, and the real `Task.create` touches disk — the redaction case needs a real
// instance without either, so it is built through the same cast `append-render-ordering.test.ts` uses.
const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;

interface FakeTask {
  taskId: string;
  metadata: Record<string, unknown>;
  append: ReturnType<typeof vi.fn>;
  linkSlackThread: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  debouncedSave: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

let createdTasks: FakeTask[] = [];

function fakeTask(n: number): FakeTask {
  return {
    taskId: `task-${n}`,
    metadata: { task_id: `task-${n}`, channels: {}, default_channel: null },
    append: vi.fn().mockResolvedValue({ linkedNewThread: true }),
    linkSlackThread: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg-20260819-1200-abc123',
    status: 'enabled',
    created_by: 'U_DEV',
    created_at: '2026-08-19T12:00:00.000Z',
    binding: { type: 'channel', channel_id: CHANNEL, channel_name: CHANNEL_NAME },
    conditions: [{ type: 'channel_message', channel_id: CHANNEL }],
    action: { prompt: 'look into the failure' },
    summary: 'watch the deploy bot',
    ...over,
  };
}

function messageThread(over: Partial<SlackThread> = {}): SlackThread {
  return {
    threadId: TRIGGER_TS,
    channel: { id: CHANNEL, name: CHANNEL_NAME },
    shared: false,
    taskVisibility: 'public',
    currentMessageTs: TRIGGER_TS,
    rootAuthorWasBot: false,
    messages: [{
      user: { id: 'U_DEV', username: 'dev', realName: 'A Dev' },
      ownText: BODY,
      ts: TRIGGER_TS,
    }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createdTasks = [];
  taskCreateMock.mockImplementation(async () => {
    const task = fakeTask(createdTasks.length + 1);
    createdTasks.push(task);
    return task as unknown as Task;
  });
  appendSlackMessageMock.mockResolvedValue(undefined);
  downloadMessageFilesMock.mockImplementation(async (_taskId: string, files: Array<Record<string, unknown>>) =>
    files.map((f) => ({ ...f, localPath: '/sessions/t1/attachments/f.pdf' })));
  isChannelReachableMock.mockResolvedValue(true);
  fetchChannelIsPrivateMock.mockResolvedValue(false);
  postSlackMessageMock.mockResolvedValue(undefined);
  saveTriggerMock.mockResolvedValue(undefined);
  ensureChannelCanvasMock.mockResolvedValue(undefined);
  ensureChannelPinsMock.mockResolvedValue(undefined);
});

describe('a message fire ingests its thread', () => {
  it('appends the fetched thread and never links it a second time', async () => {
    const thread = messageThread();

    await fireTrigger(makeTrigger(), {
      kind: 'message', thread, body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    const task = createdTasks[0]!;
    expect(task.append).toHaveBeenCalledTimes(1);
    // The exact object dispatch fetched, not a reconstruction of it.
    expect(task.append.mock.calls[0]![0]).toBe(thread);
    // `append` links `slack:<channel>:<threadId>` and promotes it to `default_channel` itself, so a
    // `linkSlackThread` alongside it would write the same record twice.
    expect(task.linkSlackThread).not.toHaveBeenCalled();
    // The thread carried the triggering message, so the ingestion floor stays out of the way.
    expect(appendSlackMessageMock).not.toHaveBeenCalled();
  });

  it('seeds the agent with where to reply, not with the message text', async () => {
    await fireTrigger(makeTrigger(), {
      kind: 'message', thread: messageThread(), body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    const task = createdTasks[0]!;
    expect(task.sendMessage).toHaveBeenCalledTimes(1);
    const seed = task.sendMessage.mock.calls[0]![0] as string;
    // The body belongs in the log, where every agent on the task can read it — duplicating it into the
    // PM's seed would hand the PM a copy no delegated agent has.
    expect(seed).not.toContain(BODY);
    expect(seed).toContain('default channel');
    expect(seed).toContain('knowledge.log');
  });

  it('posts no preamble to Slack', async () => {
    await fireTrigger(makeTrigger(), {
      kind: 'message', thread: messageThread(), body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    // The first thing the channel sees is the agent's actual answer, in the thread it already owns.
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it('spawns an independent task per fire — N matching messages, N tasks', async () => {
    const trigger = makeTrigger();
    const ctx = { kind: 'message' as const, body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME };

    await fireTrigger(trigger, { ...ctx, thread: messageThread() });
    await fireTrigger(trigger, {
      ...ctx,
      thread: messageThread({ threadId: '1700000000.000200', currentMessageTs: '1700000000.000200', messages: [] }),
    });

    expect(taskCreateMock).toHaveBeenCalledTimes(2);
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).not.toBe(createdTasks[1]);
    // Each task got its own single wake — no fire ever reused another's task.
    expect(createdTasks[0]!.sendMessage).toHaveBeenCalledTimes(1);
    expect(createdTasks[1]!.sendMessage).toHaveBeenCalledTimes(1);
  });

  // The recurring shape of the same rule, and the one that matters for a schedule: a trigger that fires every
  // morning must not reopen yesterday's task or speak in yesterday's thread. Each fire gets its own task with
  // its own home channel and nothing linked yet, so each opens its own thread when it posts. The message case
  // above cannot stand in for this one — `Task.create()` sits above the kind branch, but "above" is exactly the
  // kind of thing an edit moves, and a schedule fire is the shape where reuse would be tempting to add.
  it('spawns an independent task per fire — a recurring schedule firing twice', async () => {
    const trigger = makeTrigger();

    await fireTrigger(trigger, { kind: 'schedule' });
    await fireTrigger(trigger, { kind: 'schedule' });

    expect(taskCreateMock).toHaveBeenCalledTimes(2);
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).not.toBe(createdTasks[1]);
    for (const task of createdTasks) {
      expect(task!.metadata.home_channel).toEqual({ channel_id: CHANNEL, channel_name: CHANNEL_NAME });
      // Nothing carried over from the other fire: no linked thread, no default channel, one wake each.
      expect(task!.metadata.channels).toEqual({});
      expect(task!.metadata.default_channel).toBeNull();
      expect(task!.sendMessage).toHaveBeenCalledTimes(1);
      expect(task!.linkSlackThread).not.toHaveBeenCalled();
    }
  });

  it('records the missing triggering message redacted, since nothing can verify its author', async () => {
    // The shape `fetchSlackThread` returns for a payload with neither a `user` nor a `bot_id`: the thread
    // exists, but the message that fired the trigger was dropped from it. `authorId` is absent for the same
    // reason the fetch dropped the message — the dispatch reads `event.user || raw?.bot_id`, and neither was
    // there — which is precisely what the floor keys on, so it must be absent here too.
    const thread = messageThread({ messages: [] });

    await fireTrigger(makeTrigger(), {
      kind: 'message', thread, body: BODY, channelName: CHANNEL_NAME,
    });

    const task = createdTasks[0]!;
    // `append` still runs — it is what registers the channel and promotes `default_channel`; only its
    // per-message loop had nothing to walk.
    expect(task.append).toHaveBeenCalledTimes(1);
    expect(task.linkSlackThread).not.toHaveBeenCalled();

    expect(appendSlackMessageMock).toHaveBeenCalledTimes(1);
    const call = appendSlackMessageMock.mock.calls[0]!;
    expect(call[0]).toBe('task-1');
    expect(call[1]).toEqual({ id: CHANNEL, name: CHANNEL_NAME });
    expect(call[2]).toBe(TRIGGER_TS);
    // The floor fires only for a payload that carried no identity at all, and an author nothing can
    // verify is not eligible to have its text stand in the transcript. The entry still records that a
    // message fired here.
    expect(call[4]).toBe('[redacted: external participant in shared channel]');
    // The `msg:<ts>` id the log entry is keyed by — without it the entry cannot be reacted to or cited.
    expect(call[5]).toEqual({ redacted: true, ts: TRIGGER_TS });
  });
});

// The floor is a direct write to knowledge.log that bypasses `Task.append`, and therefore bypasses the redaction policy every other write to that log goes through. It exists for exactly one shape, and the four conditions below are what keep it to that shape.
//
// `fetchSlackThread` drops a raw message with neither a `user` nor a `botId`, which is the ONLY reason the triggering message can legitimately be missing from the thread it was fetched from — and the dispatch derives `authorId` from the same two fields (`event.user || raw?.bot_id`), so that shape is exactly "no authorId". The fetch filter also drops a bot post from a foreign workspace, and the dispatch-side gate meant to catch those first reads different fields (`bot_profile.team_id || team`), so a payload carrying no team at all can clear dispatch and still be dropped by the fetch. Firing the floor on ANY absence from the thread would therefore re-admit that content — an external bot's message, unredacted, written straight into the log. The remaining condition refuses a write that would misrepresent the log: no body means an entry claiming a message with no text. The message's ts is read off `thread.threadId`, because dispatch fires only on top-level messages — so the thread's root IS the firing message, and the check asks whether the fetched thread contained its own root.
describe('the ingestion floor fires only for the shape the fetch filter drops', () => {
  const floorCtx = {
    kind: 'message' as const,
    body: BODY,
    channelName: CHANNEL_NAME,
  };

  /** The absent-message shape: the thread came back without the message that fired the trigger. */
  const emptyThread = () => messageThread({ messages: [] });

  it('writes an entry when there is no author, a body, a ts, and the thread lacks the message', async () => {
    await fireTrigger(makeTrigger(), { ...floorCtx, thread: emptyThread() });

    expect(appendSlackMessageMock).toHaveBeenCalledTimes(1);
    const call = appendSlackMessageMock.mock.calls[0]!;
    expect(call[4]).toBe('[redacted: external participant in shared channel]');
    expect(call[5]).toEqual({ redacted: true, ts: TRIGGER_TS });
  });

  // The one that matters: an identified author means the fetch dropped the message for some OTHER reason —
  // a foreign-workspace bot post is the known one — and that content must go through the redaction policy
  // or not be written at all. Writing it here would make the floor a hole in that policy.
  it('writes nothing when the message HAD an author id', async () => {
    await fireTrigger(makeTrigger(), { ...floorCtx, thread: emptyThread(), authorId: 'B_FOREIGN_BOT' });

    expect(appendSlackMessageMock).not.toHaveBeenCalled();
  });

  it('writes nothing when the rendered body is empty', async () => {
    await fireTrigger(makeTrigger(), { ...floorCtx, thread: emptyThread(), body: '' });

    expect(appendSlackMessageMock).not.toHaveBeenCalled();
  });

  // `append` already wrote this message through the real renderer, with its redaction verdict and its
  // `msg:<ts>` id. A second write would duplicate it in the log the delegated agents read.
  it('writes nothing when the fetched thread does contain the triggering message', async () => {
    await fireTrigger(makeTrigger(), { ...floorCtx, thread: messageThread() });

    expect(appendSlackMessageMock).not.toHaveBeenCalled();
  });
});

describe('a schedule fire homes its task in the bound channel', () => {
  it('records the bound channel as the task home', async () => {
    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    expect(createdTasks[0]!.metadata.home_channel).toEqual({
      channel_id: CHANNEL,
      channel_name: CHANNEL_NAME,
    });
  });

  it('refreshes that channel\'s canvas and pin index before the first agent spawns', async () => {
    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    // The scan is called exactly as any other caller calls it, announcements included. A canvas adoption notice
    // reports a real change to what Archie reads in this channel and carries no task footer, so it cannot be
    // mistaken for the automation's own result — "firing posts no preamble" is about the fire not announcing
    // ITSELF, which is asserted separately below.
    expect(ensureChannelCanvasMock).toHaveBeenCalledWith(CHANNEL);
    expect(ensureChannelPinsMock).toHaveBeenCalledWith(CHANNEL);
    // Ordering is the point, not the calls: `sendMessage` assembles the first agent's system prompt inside
    // its own await (deliver → ensureAgentSpawned → agent.spawn), so a scan that lands afterwards reaches
    // nothing the agent doing the work can read.
    const sendMessage = createdTasks[0]!.sendMessage;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendOrder = sendMessage.mock.invocationCallOrder[0]!;
    expect(ensureChannelCanvasMock.mock.invocationCallOrder[0]!).toBeLessThan(sendOrder);
    expect(ensureChannelPinsMock.mock.invocationCallOrder[0]!).toBeLessThan(sendOrder);
  });

  it('posts no preamble — the thread root is the result itself', async () => {
    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it('seeds the agent with the thread-opening rule rather than a channel to post at', async () => {
    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    const seed = createdTasks[0]!.sendMessage.mock.calls[0]![0] as string;
    expect(seed).toContain('post_to_user');
    expect(seed).toContain(`#${CHANNEL_NAME}`);
    // The old seed handed the agent a detached "post it to this channel id" instruction, which is exactly
    // what made a human reply to the result start a stranger task.
    expect(seed).not.toContain(CHANNEL);
    expect(seed).not.toMatch(/posting it to the channel/);
  });

  it('leaves a message fire unhomed and costs it no scan', async () => {
    await fireTrigger(makeTrigger(), {
      kind: 'message', thread: messageThread(), body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    // A message fire already owns a thread, and the event path that dispatched it already scanned the
    // channel on the way in.
    expect(createdTasks[0]!.metadata.home_channel).toBeUndefined();
    expect(ensureChannelCanvasMock).not.toHaveBeenCalled();
    expect(ensureChannelPinsMock).not.toHaveBeenCalled();
  });

  it('homes nothing and scans nothing when the bound channel is gone', async () => {
    isChannelReachableMock.mockResolvedValue(false);

    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    // The pre-flight pauses the trigger and returns before a task exists at all, so there is nothing to
    // home and no channel worth scanning.
    expect(taskCreateMock).not.toHaveBeenCalled();
    expect(ensureChannelCanvasMock).not.toHaveBeenCalled();
    expect(ensureChannelPinsMock).not.toHaveBeenCalled();
  });
});

describe('a message fire ingests through the real Task.append', () => {
  // The claims above ride on a spy. This one cannot: "a triggered task obeys the same redaction policy as
  // every other Slack task" is a statement about the real ingestion path, so the fire below runs against a
  // real `Task` whose only stubs are the two persistence-adjacent seams (`debouncedSave`, `sendMessage`).
  function realTask(): Task {
    const metadata = {
      task_id: 'task-real', task_owner: null, participants: [], channels: {}, default_channel: null,
      agent_sessions: {},
    } as unknown as TaskMetadata;
    const task = new TaskCtor('task-real', metadata, []);
    const stubbed = task as unknown as { debouncedSave: () => void; sendMessage: unknown; save: () => Promise<void> };
    stubbed.debouncedSave = () => {};
    stubbed.sendMessage = vi.fn().mockResolvedValue(undefined);
    stubbed.save = async () => {};
    return task;
  }

  it('writes the redaction placeholder and downloads nothing for an external author in a shared channel', async () => {
    const task = realTask();
    taskCreateMock.mockResolvedValue(task);

    const thread = messageThread({
      shared: true,
      messages: [{
        user: { id: 'U_EXT', username: 'ext', realName: 'Ext Contractor', teamId: 'T_OTHER' },
        ownText: BODY,
        ts: TRIGGER_TS,
        files: [{ id: 'F1', name: 'runbook.pdf', mimetype: 'application/pdf', url_private: 'https://x/y' }],
      }],
    });

    await fireTrigger(makeTrigger(), {
      kind: 'message', thread, body: BODY, authorId: 'U_EXT', channelName: CHANNEL_NAME,
    });

    expect(appendSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(appendSlackMessageMock.mock.calls[0]![4]).toBe('[redacted: external participant in shared channel]');
    // A redacted message's files must never reach the task's attachments folder — the body that would
    // reference them is a placeholder.
    expect(downloadMessageFilesMock).not.toHaveBeenCalled();
    // And the real append took ownership of the thread, so a human reply routes back to this task.
    expect(task.metadata.default_channel).toBe(`slack:${CHANNEL}:${TRIGGER_TS}`);
  });
});

describe('a fire assigns the task its destination visibility', () => {
  it('a message fire inherits the triggering thread visibility', async () => {
    await fireTrigger(makeTrigger(), {
      kind: 'message', thread: messageThread({ taskVisibility: 'private' }), body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    expect(taskCreateMock).toHaveBeenCalledWith('private');
  });

  it('a channel-bound schedule fire resolves the channel privacy live', async () => {
    fetchChannelIsPrivateMock.mockResolvedValue(false);

    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    expect(fetchChannelIsPrivateMock).toHaveBeenCalledWith(CHANNEL);
    expect(taskCreateMock).toHaveBeenCalledWith('public');
  });

  it('a schedule fire fails closed when the privacy lookup fails', async () => {
    fetchChannelIsPrivateMock.mockRejectedValue(new Error('channel_not_found'));

    await fireTrigger(makeTrigger(), { kind: 'schedule' });

    expect(taskCreateMock).toHaveBeenCalledWith('private');
  });

  it('a DM-bound schedule fire is always private', async () => {
    await fireTrigger(
      makeTrigger({ binding: { type: 'user', user_id: 'U_DEV' } }),
      { kind: 'schedule' },
    );

    expect(fetchChannelIsPrivateMock).not.toHaveBeenCalled();
    expect(taskCreateMock).toHaveBeenCalledWith('private');
  });
});
