/**
 * Tests for `delivery_target` — the first user-facing message on a task that has no thread
 * yet opens one and links it.
 *
 * This is the whole point of the field, and it is not a pure decision: the thread id comes
 * back from the post, so the link can only be asserted by driving `postToUser` with the
 * Slack call stubbed. Only `postSlackMessage` is replaced; everything else in the client
 * stays real, so the channel key and url are built the way production builds them.
 *
 * `WORKDIR` is read at module-import time, so the env var is set before the dynamic
 * imports and the modules are pulled in inside the tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let root: string;
// A unique ts per post, as Slack gives: several tests link a thread in the same temp
// workdir, and a shared constant would make the on-disk `findTaskByThread` scan ambiguous.
let seq = 0;
let POSTED_TS = '';
const postSlackMessage = vi.fn(async (_args: { channel: string; threadTs?: string }) => {
  POSTED_TS = `1787084582.${String(++seq).padStart(6, '0')}`;
  return POSTED_TS as string | undefined;
});

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  postSlackMessage: (args: { channel: string; threadTs?: string }) => postSlackMessage(args),
  // Real one calls conversations.info, so it needs an initialised Slack client. The DM /
  // group-DM rejection it performs is asserted where it belongs, in the client's own tests.
  assertPostableChannel: async () => {},
}));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-delivery-'));
  process.env.ARCHIE_WORKDIR = root;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ARCHIE_WORKDIR;
});

async function taskWithDeliveryTarget() {
  const { Task } = await import('../task.js');
  const task = await Task.create();
  task.metadata.delivery_target = { channel_id: 'C0BL', channel_name: 'bot-test' };
  return task;
}

describe('postToUser with a pending delivery target', () => {
  it('posts top-level, links the thread it created, and makes it the default channel', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();

    const key = await task.postToUser('the scheduled result', 'pm-agent', undefined, { mayOpenThread: true });

    // Top-level: no threadTs, or it would reply into a thread that does not exist yet.
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const arg = postSlackMessage.mock.calls[0][0];
    expect(arg.channel).toBe('C0BL');
    expect(arg.threadTs).toBeUndefined();

    expect(key).toBe(`slack:C0BL:${POSTED_TS}`);
    expect(task.metadata.default_channel).toBe(key);
    expect(task.metadata.channels[key!]).toMatchObject({
      type: 'slack',
      channel_id: 'C0BL',
      channel_name: 'bot-test',
      thread_id: POSTED_TS,
      last_processed_ts: POSTED_TS,
    });
  });

  // The link is what makes a reply come back to this task: findTaskByThread matches on
  // thread_id, so the ts of the message just posted has to be stored as one.
  it('stores the posted ts as thread_id, which is what findTaskByThread matches', async () => {
    const task = await taskWithDeliveryTarget();
    await task.postToUser('the scheduled result', 'pm-agent', undefined, { mayOpenThread: true });
    // The link is persisted through the debounce; flush it so the on-disk scan can see it.
    // In production the fired task is active, so the in-memory branch of the lookup hits
    // first and this timing does not arise.
    await task.save(true);
    const { findTaskByThread } = await import('../persistence.js');
    expect(await findTaskByThread(POSTED_TS)).toBe(task.taskId);
  });

  it('clears the target, so the next message threads instead of opening another', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();

    await task.postToUser('first', 'pm-agent', undefined, { mayOpenThread: true });
    const rootTs = POSTED_TS; // the ts the second post must thread under
    expect(task.metadata.delivery_target).toBeUndefined();

    const second = await task.postToUser('second', 'pm-agent', undefined, { mayOpenThread: true });
    expect(second).toBeNull();
    expect(Object.keys(task.metadata.channels)).toHaveLength(1);
    expect(postSlackMessage.mock.calls[1][0].threadTs).toBe(rootTs);
  });

  it('leaves the message sent but unlinked when no ts comes back, rather than inventing one', async () => {
    // Dry-run mode returns undefined. A fabricated thread id would strand every later post
    // on a key Slack does not know.
    postSlackMessage.mockClear();
    postSlackMessage.mockResolvedValueOnce(undefined);
    const task = await taskWithDeliveryTarget();

    expect(await task.postToUser('the scheduled result', 'pm-agent', undefined, { mayOpenThread: true })).toBeNull();
    expect(task.metadata.channels).toEqual({});
    expect(task.metadata.default_channel).toBeNull();
  });

  it('is not consulted once a default channel exists', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();
    await task.postToUser('first', 'pm-agent', undefined, { mayOpenThread: true });
    const key = task.metadata.default_channel;

    task.metadata.delivery_target = { channel_id: 'COTHER', channel_name: 'elsewhere' };
    await task.postToUser('second', 'pm-agent', undefined, { mayOpenThread: true });

    expect(task.metadata.default_channel).toBe(key);
    expect(postSlackMessage.mock.calls[1][0].channel).toBe('C0BL');
    expect(task.metadata.delivery_target).toEqual({ channel_id: 'COTHER', channel_name: 'elsewhere' });
  });

  // Opening the task's thread is opt-in per caller. The inter-agent budget warning and the
  // wall-clock pause notice also call postToUser, and neither may become the first thing a
  // bound channel hears from Archie — nor the thread the task then links.
  it('does not open a thread for a caller that did not ask to', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();

    expect(await task.postToUser('an incidental system notice', 'system')).toBeNull();

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(task.metadata.channels).toEqual({});
    expect(task.metadata.delivery_target).toEqual({ channel_id: 'C0BL', channel_name: 'bot-test' });
  });

  // The claim happens before the await, so two concurrent first posts cannot both pass the
  // guard and open two roots.
  it('claims the target before posting, so concurrent first posts open one thread', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();

    const keys = await Promise.all([
      task.postToUser('a', 'pm-agent', undefined, { mayOpenThread: true }),
      task.postToUser('b', 'pm-agent', undefined, { mayOpenThread: true }),
    ]);

    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(keys.filter(Boolean)).toHaveLength(1);
    expect(Object.keys(task.metadata.channels)).toHaveLength(1);
  });

  it('restores the target when the post throws, so a transient failure costs nothing', async () => {
    postSlackMessage.mockClear();
    postSlackMessage.mockRejectedValueOnce(new Error('slack exploded'));
    const task = await taskWithDeliveryTarget();

    await expect(task.postToUser('x', 'pm-agent', undefined, { mayOpenThread: true })).rejects.toThrow('slack exploded');
    expect(task.metadata.delivery_target).toEqual({ channel_id: 'C0BL', channel_name: 'bot-test' });
    expect(task.metadata.channels).toEqual({});
  });

  // The target is consumed even when no ts comes back, so a malformed Slack response cannot
  // turn every later message into another top-level post.
  it('does not re-open a root after a post that returned no ts', async () => {
    postSlackMessage.mockClear();
    postSlackMessage.mockResolvedValueOnce(undefined);
    const task = await taskWithDeliveryTarget();

    await task.postToUser('first', 'pm-agent', undefined, { mayOpenThread: true });
    expect(task.metadata.delivery_target).toBeUndefined();

    await task.postToUser('second', 'pm-agent', undefined, { mayOpenThread: true });
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });
});

describe('postToUser with an unlinked target key', () => {
  // It used to post nothing and return null, which post_to_user reported as
  // 'Message posted.' — and on a task whose channels are still empty, EVERY key is
  // unlinked, so the most likely wrong argument lost the message silently.
  it('throws instead of silently reporting success', async () => {
    const task = await taskWithDeliveryTarget();
    await expect(
      task.postToUser('x', 'pm-agent', { channel: 'slack:C0BL:9999.0000' }),
    ).rejects.toThrow('is not linked to this task');
  });
});

describe('complete() with an unconsumed delivery target', () => {
  // A fire that recorded a destination and never posted used to complete green with the
  // channel hearing nothing and no line in the log.
  it('warns and drops the target', async () => {
    const task = await taskWithDeliveryTarget();
    // `activate()` is private and `sendMessage` would spawn a real agent; complete() only
    // needs the task to look active, and this task has no agents or timers to tear down.
    (task as unknown as { isActive: boolean }).isActive = true;
    await task.complete();
    expect(task.metadata.delivery_target).toBeUndefined();
  });
});
