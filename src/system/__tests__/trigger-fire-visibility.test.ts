import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

const { createTask, getChannelInfo } = vi.hoisted(() => ({
  createTask: vi.fn(),
  getChannelInfo: vi.fn(),
}));

vi.mock('../../tasks/task.js', () => ({
  Task: { create: createTask },
}));
vi.mock('../trigger-store.js', () => ({
  listTriggers: vi.fn(),
  saveTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
}));
vi.mock('../event-bus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));
vi.mock('../../connectors/slack/client.js', () => ({
  postSlackMessage: vi.fn(),
  isChannelReachable: vi.fn().mockResolvedValue(true),
  getChannelInfo,
}));

import { fireTrigger } from '../trigger-scheduler.js';
import { saveTrigger } from '../trigger-store.js';

function trigger(): Trigger {
  return {
    id: 'trg-20260728-1200-abc123',
    status: 'enabled',
    created_by: 'U07AUTHOR1',
    created_at: '2026-07-28T12:00:00.000Z',
    created_from_visibility: 'public',
    binding: { type: 'channel', channel_id: 'C123', channel_name: 'general' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-07-28T13:00:00.000Z' }],
    action: { prompt: 'Summarize the channel' },
  };
}

describe('fireTrigger task visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTask.mockImplementation(async () => ({
      taskId: 'task-triggered',
      metadata: {},
      linkSlackThread: vi.fn(),
      debouncedSave: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it('preserves the triggering Slack thread visibility for message fires', async () => {
    await fireTrigger(trigger(), {
      kind: 'message',
      channelId: 'GPRIVATE',
      channelName: 'leadership',
      threadId: '100.0',
      visibility: 'private',
    });

    expect(createTask).toHaveBeenCalledWith('private');
  });

  it('derives schedule-fire visibility from the live delivery channel', async () => {
    getChannelInfo.mockResolvedValue({
      id: 'C123',
      name: 'general',
      isPrivate: true,
      isIm: false,
    });

    await fireTrigger(trigger(), { kind: 'schedule' });

    expect(createTask).toHaveBeenCalledWith('private');
  });

  it('pauses legacy triggers whose creation context cannot be verified', async () => {
    const legacy = trigger();
    delete legacy.created_from_visibility;

    await fireTrigger(legacy, { kind: 'schedule' });

    expect(createTask).not.toHaveBeenCalled();
    expect(legacy.status).toBe('paused');
    expect(saveTrigger).toHaveBeenCalledWith(legacy);
  });
});
