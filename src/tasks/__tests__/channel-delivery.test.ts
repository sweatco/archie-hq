import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage: postMock };
});

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendMessageToUser: vi.fn().mockResolvedValue(undefined) };
});

import { Task } from '../task.js';
import { appendMessageToUser } from '../persistence.js';
import {
  registerChannelDeliverer, getChannelDeliverer, getChannelRenderer,
  type ChannelDeliverer, type ChannelRenderer,
} from '../channel-delivery.js';
import type { Channel, ChannelType, TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

function madeUpChannel(type: string = MADE_UP): Channel {
  return { type } as unknown as Channel;
}

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

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

function newTask(meta: TaskMetadata): Task {
  const task = new TaskCtor('t1', meta, []);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = async () => {};
  return task;
}

// A kind `task.ts` never heard of — proves the seam is generic, not special-cased for `recall`
// (pinned separately: src/voice/__tests__/channel-delivery.test.ts).
const MADE_UP = 'made-up-kind' as ChannelType;

describe('registerChannelDeliverer / getChannelDeliverer', () => {
  it('returns undefined for a kind nothing has registered', () => {
    expect(getChannelDeliverer('nobody-registered-this' as ChannelType)).toBeUndefined();
  });

  it('returns the registered deliverer for its kind', () => {
    const deliverer: ChannelDeliverer = async () => ({ delivered: true, note: 'ok' });
    registerChannelDeliverer(MADE_UP, deliverer);
    expect(getChannelDeliverer(MADE_UP)).toBe(deliverer);
  });

  it('a second registration for the same kind replaces the first', () => {
    const first: ChannelDeliverer = async () => ({ delivered: true, note: 'first' });
    const second: ChannelDeliverer = async () => ({ delivered: true, note: 'second' });
    registerChannelDeliverer(MADE_UP, first);
    registerChannelDeliverer(MADE_UP, second);
    expect(getChannelDeliverer(MADE_UP)).toBe(second);
  });
});

// channel-render.ts's "no renderer registered" case is pinned in its own test, not here.
describe('registerChannelDeliverer / getChannelRenderer', () => {
  it('returns undefined for a kind nothing has registered', () => {
    expect(getChannelRenderer('nobody-registered-this' as ChannelType)).toBeUndefined();
  });

  it('returns undefined for a kind that registered a deliverer but no renderer', () => {
    const RENDERLESS = 'renderless-kind' as ChannelType;
    registerChannelDeliverer(RENDERLESS, async () => undefined);
    expect(getChannelDeliverer(RENDERLESS)).toBeDefined();
    expect(getChannelRenderer(RENDERLESS)).toBeUndefined();
  });

  it('returns the registered renderer for its kind', () => {
    const render: ChannelRenderer = () => 'rendered';
    registerChannelDeliverer(MADE_UP, async () => undefined, render);
    expect(getChannelRenderer(MADE_UP)).toBe(render);
  });

  it('a second registration for the same kind replaces the first renderer', () => {
    const first: ChannelRenderer = () => 'first';
    const second: ChannelRenderer = () => 'second';
    registerChannelDeliverer(MADE_UP, async () => undefined, first);
    registerChannelDeliverer(MADE_UP, async () => undefined, second);
    expect(getChannelRenderer(MADE_UP)).toBe(second);
  });

  it('a replacement registration with no renderer clears the previous one, rather than inheriting it', () => {
    registerChannelDeliverer(MADE_UP, async () => undefined, () => 'stale render');
    expect(getChannelRenderer(MADE_UP)).toBeDefined();

    registerChannelDeliverer(MADE_UP, async () => undefined);
    expect(getChannelRenderer(MADE_UP)).toBeUndefined();
  });
});

describe('Task.postToUser dispatches a targeted, non-Slack channel through the seam', () => {
  beforeEach(() => {
    postMock.mockReset();
    vi.mocked(appendMessageToUser).mockClear();
  });

  it('relays the deliverer\'s note back as postToUser\'s return value, and logs the delivered message to the knowledge log', async () => {
    const deliverer: ChannelDeliverer = vi.fn().mockResolvedValue({ delivered: true, note: 'delivered — spoken aloud' });
    registerChannelDeliverer(MADE_UP, deliverer);

    const key = 'made-up:1';
    const channel = madeUpChannel();
    const meta = metadata({ channels: { [key]: channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(deliverer).toHaveBeenCalledTimes(1);
    const call = (deliverer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.task).toBe(task);
    expect(call.channel).toBe(channel);
    expect(call.message).toBe('an answer');
    expect(call.sender).toBe('pm-agent');
    expect(result).toBe('delivered — spoken aloud');
    expect(postMock).not.toHaveBeenCalled();

    // Logs the channel's key, not a display string — stable even if its renderer is stale or unregistered.
    expect(vi.mocked(appendMessageToUser)).toHaveBeenCalledWith('t1', 'pm-agent', 'an answer', key);
  });

  it('relays a failed delivery\'s note back, but does not log it — the message never reached anyone', async () => {
    const deliverer: ChannelDeliverer = vi.fn().mockResolvedValue({
      delivered: false,
      note: 'That meeting has ended — the room has already dispersed. Post to the thread instead.',
    });
    registerChannelDeliverer(MADE_UP, deliverer);

    const key = 'made-up:1b';
    const channel = madeUpChannel();
    const meta = metadata({ channels: { [key]: channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(result).toBe('That meeting has ended — the room has already dispersed. Post to the thread instead.');
    expect(vi.mocked(appendMessageToUser)).not.toHaveBeenCalled();
  });

  it('does not log when a registered deliverer resolves to undefined (its own defensive/no-op case)', async () => {
    const deliverer: ChannelDeliverer = vi.fn().mockResolvedValue(undefined);
    registerChannelDeliverer(MADE_UP, deliverer);

    const key = 'made-up:1c';
    const channel = madeUpChannel();
    const meta = metadata({ channels: { [key]: channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(result).toBeNull();
    expect(vi.mocked(appendMessageToUser)).not.toHaveBeenCalled();
  });

  it('is a silent no-op — same shape as today\'s unresolved target — when nothing is registered for the kind, and logs nothing either', async () => {
    const key = 'made-up:2';
    const channel = madeUpChannel('nobody-registered-this-either');
    const meta = metadata({ channels: { [key]: channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(result).toBeNull();
    expect(vi.mocked(appendMessageToUser)).not.toHaveBeenCalled();
  });

  it('is a silent no-op for a target naming a channel key that is not linked at all', async () => {
    const meta = metadata({ channels: {} });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: 'made-up:missing' });

    expect(result).toBeNull();
  });

  it('never assigns default_channel while dispatching through the seam', async () => {
    registerChannelDeliverer(MADE_UP, vi.fn().mockResolvedValue({ delivered: true, note: 'note' }));
    const key = 'made-up:3';
    const channel = madeUpChannel();
    const meta = metadata({ channels: { [key]: channel }, default_channel: 'slack:C1:100' });
    const task = newTask(meta);

    await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(meta.default_channel).toBe('slack:C1:100');
  });

  // `default_channel` only gets a Slack/CLI key (task.ts's `??=` sites); a registered kind there is
  // unreachable today — pins the seam silent regardless, should that change.
  it('does not dispatch through the seam for the default channel, even if a registered kind ended up there', async () => {
    const deliverer = vi.fn().mockResolvedValue({ delivered: true, note: 'should not be called' });
    registerChannelDeliverer(MADE_UP, deliverer);
    const key = 'made-up:4';
    const channel = madeUpChannel();
    const meta = metadata({ channels: { [key]: channel }, default_channel: key });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent');

    expect(deliverer).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
