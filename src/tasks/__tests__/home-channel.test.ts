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
import { appendMessageToUser } from '../persistence.js';
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
    vi.mocked(appendMessageToUser).mockClear();
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
    // Unlinked is not the same as unsaid. Dry-run never reaches Slack, so there is no ts to key a thread
    // by — but the agent did produce this message, and knowledge.log is the only place any other agent on
    // the task can read it. Dropping it here would make a dry-run fire look like a fire that said nothing,
    // and the destination is still recorded as the home channel it was meant for.
    expect(vi.mocked(appendMessageToUser)).toHaveBeenCalledWith(
      't1', 'pm-agent', 'the nightly report', `#${HOME.channel_name}`,
    );
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

  // Reply routing does not read this metadata as an object. `findTaskByThread` (src/tasks/persistence.ts)
  // checks in-memory tasks first, and for everything else it greps the serialized metadata files on disk
  // for the exact substring `"thread_id": "<ts>"` — two spaces of JSON.stringify(…, 2) indentation
  // notwithstanding, that literal is the whole match. So the SHAPE is load-bearing and not just the value:
  // renaming the field, nesting the thread id one level deeper under a different key, or writing the
  // metadata with different `JSON.stringify` spacing would each leave a thread that resolves to no task,
  // and every human reply to the report Archie just posted would silently open a stranger task instead —
  // exactly the bug the home-channel thread exists to fix, reintroduced with all the unit tests still green.
  it('serializes the opened thread id in the exact form the reply-routing scan greps for', async () => {
    const meta = metadata({ home_channel: HOME });
    await newTask(meta).postToUser('the nightly report', 'pm-agent');

    // The same string `findTaskByThread` builds: `"thread_id": ${JSON.stringify(threadId)}`.
    const needle = `"thread_id": ${JSON.stringify(TS)}`;
    expect(JSON.stringify(meta, null, 2)).toContain(needle);
  });
});

// A task has exactly one thread, and an agent can emit two `post_to_user` calls in a single turn without
// awaiting the first. Before the single-flight guard both would find no default channel, both would root a
// top-level message in the home channel, and only one of the two would end up linked — so the channel would
// show two competing roots for one task and a human replying under the unlinked one would open a stranger
// task. That is the failure these cases pin: not "two posts happened" (two posts are correct) but "two
// THREADS were rooted".
describe('opening the home thread is single-flight', () => {
  beforeEach(() => {
    postMock.mockReset();
    vi.mocked(logger.warn).mockClear();
  });

  it('two concurrent posts root one thread, and the second lands inside it', async () => {
    // The first post is held open so both `postToUser` calls are genuinely in flight when the second one
    // looks for a thread — resolving immediately would let the first finish and reduce this to the ordinary
    // sequential case, which the block above already covers.
    let releaseFirst: (ts: string) => void = () => {};
    const firstPost = new Promise<string>((resolve) => { releaseFirst = resolve; });
    postMock.mockImplementationOnce(() => firstPost);
    postMock.mockResolvedValue(TS);

    const meta = metadata({ home_channel: HOME, default_channel: null });
    const task = newTask(meta);

    const both = Promise.all([
      task.postToUser('the nightly report', 'pm-agent'),
      task.postToUser('and the follow-up', 'pm-agent'),
    ]);
    releaseFirst(TS);
    await both;

    expect(postMock).toHaveBeenCalledTimes(2);
    const rootPosts = postMock.mock.calls.filter((c) => (c[0] as { threadTs?: string }).threadTs === undefined);
    // The assertion that matters: exactly one of the two posts rooted a thread.
    expect(rootPosts).toHaveLength(1);
    expect(Object.keys(meta.channels)).toEqual([`slack:${HOME.channel_id}:${TS}`]);
    expect(meta.default_channel).toBe(`slack:${HOME.channel_id}:${TS}`);
    // And the waiter posted into the thread the opener rooted, rather than being dropped for having
    // nowhere to go.
    expect(lastPostArgs().threadTs).toBe(TS);
  });

  // The guard must not wedge the task: a failed open leaves no thread, so the next message is entitled to
  // try again. Latching it would mean one transient Slack error costs the task its voice for good.
  it('lets a later post open the thread after the first attempt failed', async () => {
    postMock.mockRejectedValueOnce(new Error('slack down'));
    postMock.mockResolvedValue(TS);

    const meta = metadata({ home_channel: HOME });
    const task = newTask(meta);

    await expect(task.postToUser('the first try', 'pm-agent')).rejects.toThrow('slack down');
    expect(meta.channels).toEqual({});

    const key = await task.postToUser('the second try', 'pm-agent');

    expect(key).toBe(`slack:${HOME.channel_id}:${TS}`);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(lastPostArgs().threadTs).toBeUndefined();
    expect(Object.keys(meta.channels)).toEqual([key]);
  });
});
