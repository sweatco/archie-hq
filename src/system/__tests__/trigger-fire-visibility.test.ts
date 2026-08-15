import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

const { createTask, fetchChannelIsPrivate } = vi.hoisted(() => ({
  createTask: vi.fn(),
  fetchChannelIsPrivate: vi.fn(),
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
  postSlackMessage: vi.fn().mockResolvedValue(undefined),
  isChannelReachable: vi.fn().mockResolvedValue(true),
  fetchChannelIsPrivate,
}));

import { fireTrigger } from '../trigger-scheduler.js';

function trigger(): Trigger {
  return {
    id: 'trg-20260728-1200-abc123',
    status: 'enabled',
    created_by: 'U07AUTHOR1',
    created_at: '2026-07-28T12:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C123', channel_name: 'general' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-07-28T13:00:00.000Z' }],
    action: { prompt: 'Summarize the channel' },
    prompt_origin_visibility: 'public',
  };
}

describe('fireTrigger task visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ARCHIE_TRIGGERS_ENABLED = 'true';
    fetchChannelIsPrivate.mockResolvedValue(false);
    createTask.mockImplementation(async () => ({
      taskId: 'task-triggered',
      metadata: {},
      linkSlackThread: vi.fn(),
      debouncedSave: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    delete process.env.ARCHIE_TRIGGERS_ENABLED;
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
    fetchChannelIsPrivate.mockResolvedValue(true);

    await fireTrigger(trigger(), { kind: 'schedule' });

    expect(createTask).toHaveBeenCalledWith('private');
  });

  it('uses the current destination visibility on every schedule fire', async () => {
    const existing = trigger();
    fetchChannelIsPrivate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await fireTrigger(existing, { kind: 'schedule' });
    await fireTrigger(existing, { kind: 'schedule' });

    expect(createTask).toHaveBeenNthCalledWith(1, 'private');
    expect(createTask).toHaveBeenNthCalledWith(2, 'public');
    expect(existing.status).toBe('enabled');
  });

  it('defers a schedule fire when destination visibility cannot be verified', async () => {
    const existing = trigger();
    fetchChannelIsPrivate.mockRejectedValue(new Error('Slack unavailable'));

    await expect(fireTrigger(existing, { kind: 'schedule' })).rejects.toThrow('Slack unavailable');

    expect(createTask).not.toHaveBeenCalled();
    expect(existing.status).toBe('enabled');
  });

  it('defers a legacy prompt before creating a public task', async () => {
    const existing = trigger();
    delete existing.prompt_origin_visibility;

    await expect(fireTrigger(existing, { kind: 'schedule' })).resolves.toBe('deferred');

    expect(createTask).not.toHaveBeenCalled();
    expect(existing.status).toBe('enabled');
    expect(existing.conditions[0]).toMatchObject({ next_run_at: '2026-07-28T13:00:00.000Z' });
  });

  it('allows a legacy prompt to keep firing into a private destination', async () => {
    const existing = trigger();
    delete existing.prompt_origin_visibility;
    fetchChannelIsPrivate.mockResolvedValue(true);

    await expect(fireTrigger(existing, { kind: 'schedule' })).resolves.toBe('fired');

    expect(createTask).toHaveBeenCalledWith('private');
  });
});
