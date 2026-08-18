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
const POSTED_TS = '1787084582.563519';
const postSlackMessage = vi.fn(async (_args: { channel: string; threadTs?: string }) => POSTED_TS as string | undefined);

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  postSlackMessage: (args: { channel: string; threadTs?: string }) => postSlackMessage(args),
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

    const key = await task.postToUser('the scheduled result', 'pm-agent');

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
    await task.postToUser('the scheduled result', 'pm-agent');
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

    await task.postToUser('first', 'pm-agent');
    expect(task.metadata.delivery_target).toBeUndefined();

    const second = await task.postToUser('second', 'pm-agent');
    expect(second).toBeNull();
    expect(Object.keys(task.metadata.channels)).toHaveLength(1);
    expect(postSlackMessage.mock.calls[1][0].threadTs).toBe(POSTED_TS);
  });

  it('leaves the message sent but unlinked when no ts comes back, rather than inventing one', async () => {
    // Dry-run mode returns undefined. A fabricated thread id would strand every later post
    // on a key Slack does not know.
    postSlackMessage.mockClear();
    postSlackMessage.mockResolvedValueOnce(undefined);
    const task = await taskWithDeliveryTarget();

    expect(await task.postToUser('the scheduled result', 'pm-agent')).toBeNull();
    expect(task.metadata.channels).toEqual({});
    expect(task.metadata.default_channel).toBeNull();
  });

  it('is not consulted once a default channel exists', async () => {
    postSlackMessage.mockClear();
    const task = await taskWithDeliveryTarget();
    await task.postToUser('first', 'pm-agent');
    const key = task.metadata.default_channel;

    task.metadata.delivery_target = { channel_id: 'COTHER', channel_name: 'elsewhere' };
    await task.postToUser('second', 'pm-agent');

    expect(task.metadata.default_channel).toBe(key);
    expect(postSlackMessage.mock.calls[1][0].channel).toBe('C0BL');
    expect(task.metadata.delivery_target).toEqual({ channel_id: 'COTHER', channel_name: 'elsewhere' });
  });
});
