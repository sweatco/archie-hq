/**
 * `home_channel` open-and-link tests for `postToUser`.
 *
 * A trigger-fired task has no Slack thread: its first user-facing agent message is posted as a new top-level message in the channel the trigger was bound to, and that message's ts becomes the task's thread — so every human reply routes back to this task instead of starting a new one. The message is the thread root, which is why nothing may be posted ahead of it (no preamble) and why an operational notice sent with no `agentName` must never be the one to open the thread.
 *
 * These cases pin the parts that are invisible from the outside: the opening post carries no `thread_ts`, the second post does, and a channel this task already has a thread in is never rooted twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

// The seam under test: without stubbing `postSlackMessage` these cases would try to reach Slack.
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage: postMock };
});

// `logOutgoingMessage` appends to the knowledge log without awaiting it, so a real write would surface
// as an unhandled rejection rather than a failure. These cases are about the metadata, not the log.
vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendMessageToUser: vi.fn().mockResolvedValue(undefined) };
});

import { Task } from '../task.js';
import { logger } from '../../system/logger.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

const HOME = { channel_id: 'C9', channel_name: 'ops' };
const TS = '1750000000.000100';

function metadata(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    task_id: 't1',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    ...over,
  } as unknown as TaskMetadata;
}

/** Builds a Task over `meta`, with both persistence seams neutered — see the harness note above. */
function newTask(meta: TaskMetadata): Task {
  const task = new TaskCtor('t1', meta, []);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = async () => {};
  return task;
}

function linkedChannel(threadTs: string) {
  return {
    type: 'slack' as const,
    thread_id: threadTs,
    channel_id: HOME.channel_id,
    channel_name: HOME.channel_name,
    last_processed_ts: threadTs,
  };
}

function lastPostArgs(): { channel: string; text: string; threadTs?: string } {
  return postMock.mock.calls[postMock.mock.calls.length - 1]![0];
}

describe('postToUser opens the task thread in home_channel', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue(TS);
    vi.mocked(logger.warn).mockClear();
  });

  it('posts the agent message top-level and adopts it as the task thread', async () => {
    const meta = metadata({ home_channel: HOME });
    const key = await newTask(meta).postToUser('the nightly report', 'pm-agent');

    expect(postMock).toHaveBeenCalledTimes(1);
    // The whole point: no thread_ts, so the message roots its own thread rather than replying in one.
    expect(lastPostArgs().threadTs).toBeUndefined();
    expect(lastPostArgs().channel).toBe(HOME.channel_id);

    expect(key).toBe(`slack:${HOME.channel_id}:${TS}`);
    expect(meta.channels[key!]).toMatchObject({ type: 'slack', channel_id: HOME.channel_id, thread_id: TS });
    expect(meta.default_channel).toBe(key);
  });

  it('replies in that thread on the next message instead of rooting a second one', async () => {
    const meta = metadata({ home_channel: HOME });
    const task = newTask(meta);
    const key = await task.postToUser('the nightly report', 'pm-agent');

    await task.postToUser('and a follow-up', 'pm-agent');

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(lastPostArgs().threadTs).toBe(TS);
    expect(Object.keys(meta.channels)).toEqual([key]);
  });

  it('reuses a thread already linked in the home channel rather than opening another', async () => {
    const existingTs = '1740000000.000200';
    const key = `slack:${HOME.channel_id}:${existingTs}`;
    const meta = metadata({
      home_channel: HOME,
      channels: { [key]: linkedChannel(existingTs) },
      default_channel: null,
    });

    const returned = await newTask(meta).postToUser('the nightly report', 'pm-agent');

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(lastPostArgs().threadTs).toBe(existingTs);
    expect(returned).toBe(key);
    expect(Object.keys(meta.channels)).toEqual([key]);
    expect(meta.default_channel).toBe(key);
  });

  it('links nothing when Slack returns no ts (dry-run)', async () => {
    postMock.mockResolvedValue(undefined);
    const meta = metadata({ home_channel: HOME });

    const key = await newTask(meta).postToUser('the nightly report', 'pm-agent');

    expect(key).toBeNull();
    expect(meta.channels).toEqual({});
    expect(meta.default_channel).toBeNull();
  });

  it('links nothing when the post fails, and lets the error propagate', async () => {
    postMock.mockRejectedValue(new Error('slack down'));
    const meta = metadata({ home_channel: HOME });

    await expect(newTask(meta).postToUser('the nightly report', 'pm-agent')).rejects.toThrow('slack down');

    expect(meta.channels).toEqual({});
    expect(meta.default_channel).toBeNull();
  });

  it('still drops the message when there is no home_channel and no default channel', async () => {
    const meta = metadata();

    const key = await newTask(meta).postToUser('the nightly report', 'pm-agent');

    expect(key).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
    expect(meta.channels).toEqual({});
    expect(vi.mocked(logger.warn).mock.calls.some(
      (c) => typeof c[1] === 'string' && c[1].includes('no default channel — message dropped'),
    )).toBe(true);
  });

  it('posts in-thread and opens nothing once the thread is on metadata (the post-restart shape)', async () => {
    const existingTs = '1740000000.000200';
    const key = `slack:${HOME.channel_id}:${existingTs}`;
    const meta = metadata({
      home_channel: HOME,
      channels: { [key]: linkedChannel(existingTs) },
      default_channel: key,
    });

    await newTask(meta).postToUser('the nightly report', 'pm-agent');

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(lastPostArgs().threadTs).toBe(existingTs);
    expect(Object.keys(meta.channels)).toEqual([key]);
  });

  it('does not let a system notice (no agentName) open the thread', async () => {
    const meta = metadata({ home_channel: HOME });

    const key = await newTask(meta).postToUser('⚠️ wall-clock limit reached.');

    expect(key).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
    expect(meta.channels).toEqual({});
    expect(meta.default_channel).toBeNull();
    expect(vi.mocked(logger.warn).mock.calls.some(
      (c) => typeof c[1] === 'string' && c[1].includes('no default channel — message dropped'),
    )).toBe(true);
  });

  it('survives a metadata round-trip through disk, and the reloaded task posts in-thread', async () => {
    const meta = metadata({ home_channel: HOME });
    const key = await newTask(meta).postToUser('the nightly report', 'pm-agent');

    const reloaded = JSON.parse(JSON.stringify(meta)) as TaskMetadata;
    expect(reloaded.home_channel).toEqual(HOME);
    expect(reloaded.channels[key!]).toMatchObject({ channel_id: HOME.channel_id, thread_id: TS });
    expect(reloaded.default_channel).toBe(key);

    postMock.mockClear();
    await newTask(reloaded).postToUser('after the restart', 'pm-agent');

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(lastPostArgs().threadTs).toBe(TS);
    expect(Object.keys(reloaded.channels)).toEqual([key]);
  });
});
