/**
 * `fireTrigger` — what a fired trigger's task owns before its first agent turn.
 *
 * A trigger fire spawns a brand-new task, and the only thing that task knows about the world is what this function wires into it. Two properties are pinned here.
 *
 * On a MESSAGE fire the triggering message has to be ingested, not announced: it goes through `Task.append`, the same path every other Slack task uses, so the message lands in knowledge.log under the single renderer with its `msg:<ts>` id and its redaction verdict, and the thread it was posted in becomes the task's default channel. That matters because a delegated repo or plugin agent sees ONLY knowledge.log — before this, the rendered body was passed to `fireTrigger` and dropped on the floor, so such an agent could not know what was said. The ingestion floor covers the case `fetchSlackThread` cannot: it drops a raw message with neither a `user` nor a `botId`, so the triggering message is sometimes absent from the thread it was fetched from, and the rendered body is written directly instead.
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
  postSlackMessageMock,
  saveTriggerMock,
  ensureChannelCanvasMock,
  ensureChannelPinsMock,
} = vi.hoisted(() => ({
  taskCreateMock: vi.fn(),
  appendSlackMessageMock: vi.fn(),
  downloadMessageFilesMock: vi.fn(),
  isChannelReachableMock: vi.fn(),
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
    postSlackMessage: postSlackMessageMock,
    // Without this the redaction case is a dead branch: `isExternalUser` fails open to false when the
    // Slack client was never initialised, so `shouldRedact` would say no and the case would assert the
    // ordinary path under a redacted-looking fixture.
    isExternalUser: (user: { teamId?: string }) => user.teamId === 'T_OTHER',
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
  postSlackMessageMock.mockResolvedValue(undefined);
  saveTriggerMock.mockResolvedValue(undefined);
  ensureChannelCanvasMock.mockResolvedValue(undefined);
  ensureChannelPinsMock.mockResolvedValue(undefined);
});

describe('a message fire ingests its thread', () => {
  it('appends the fetched thread and never links it a second time', async () => {
    const thread = messageThread();

    await fireTrigger(makeTrigger(), {
      kind: 'message', thread, body: BODY, triggerTs: TRIGGER_TS, authorId: 'U_DEV', channelName: CHANNEL_NAME,
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
      kind: 'message', thread: messageThread(), body: BODY, triggerTs: TRIGGER_TS, authorId: 'U_DEV', channelName: CHANNEL_NAME,
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
      kind: 'message', thread: messageThread(), body: BODY, triggerTs: TRIGGER_TS, authorId: 'U_DEV', channelName: CHANNEL_NAME,
    });

    // The first thing the channel sees is the agent's actual answer, in the thread it already owns.
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it('spawns an independent task per fire — N matching messages, N tasks', async () => {
    const trigger = makeTrigger();
    const ctx = { kind: 'message' as const, body: BODY, authorId: 'U_DEV', channelName: CHANNEL_NAME };

    await fireTrigger(trigger, { ...ctx, thread: messageThread(), triggerTs: TRIGGER_TS });
    await fireTrigger(trigger, {
      ...ctx,
      thread: messageThread({ threadId: '1700000000.000200', currentMessageTs: '1700000000.000200', messages: [] }),
      triggerTs: '1700000000.000200',
    });

    expect(taskCreateMock).toHaveBeenCalledTimes(2);
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).not.toBe(createdTasks[1]);
    // Each task got its own single wake — no fire ever reused another's task.
    expect(createdTasks[0]!.sendMessage).toHaveBeenCalledTimes(1);
    expect(createdTasks[1]!.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('writes the rendered body itself when the fetched thread does not contain the triggering message', async () => {
    // The shape `fetchSlackThread` returns for a payload with neither a `user` nor a `bot_id`: the thread
    // exists, but the message that fired the trigger was dropped from it.
    const thread = messageThread({ messages: [] });

    await fireTrigger(makeTrigger(), {
      kind: 'message', thread, body: BODY, triggerTs: TRIGGER_TS, authorId: 'unknown', channelName: CHANNEL_NAME,
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
    expect(call[4]).toBe(BODY);
    // The `msg:<ts>` id the log entry is keyed by — without it the entry cannot be reacted to or cited.
    expect(call[5]).toEqual({ ts: TRIGGER_TS });
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
      kind: 'message', thread, body: BODY, triggerTs: TRIGGER_TS, authorId: 'U_EXT', channelName: CHANNEL_NAME,
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
