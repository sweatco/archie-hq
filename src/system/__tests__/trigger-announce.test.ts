import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

const { postSlackMessageMock } = vi.hoisted(() => ({ postSlackMessageMock: vi.fn() }));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage: postSlackMessageMock };
});

vi.mock('../trigger-store.js', () => ({
  saveTrigger: vi.fn(),
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

import { announceTriggerChange } from '../trigger-scheduler.js';

const CHANNEL = 'C0OPS';
const DM_CHANNEL = 'D0DANA';
const DM_USER = 'U0DANA';

const CHANGES = ['enabled', 'edited', 'paused', 'resumed', 'deleted'] as const;

function makeTrigger(binding: Trigger['binding']): Trigger {
  return {
    id: 'trg-20260827-0900-abc123',
    status: 'enabled',
    created_by: DM_USER,
    created_at: '2026-08-27T09:00:00.000Z',
    binding,
    conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2099-01-01T09:00:00.000Z' }],
    action: { prompt: 'send the morning digest' },
    summary: 'Morning digest',
  };
}

const channelTrigger = () => makeTrigger({ type: 'channel', channel_id: CHANNEL, channel_name: 'ops-daily' });
const dmTrigger = () => makeTrigger({ type: 'user', user_id: DM_USER, channel_id: DM_CHANNEL, channel_name: 'DM with Dana' });

beforeEach(() => {
  vi.clearAllMocks();
  postSlackMessageMock.mockResolvedValue(undefined);
});

describe('a DM-bound trigger is announced nowhere', () => {
  it.each(CHANGES)('posts nothing on %s', async (change) => {
    await announceTriggerChange(dmTrigger(), change);

    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });
});

describe('a channel-bound trigger is still announced in its channel', () => {
  it('posts exactly one notice to the bound channel', async () => {
    await announceTriggerChange(channelTrigger(), 'enabled');

    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    const call = postSlackMessageMock.mock.calls[0]![0] as { channel: string; text: string };
    expect(call.channel).toBe(CHANNEL);
    expect(call.text).toContain('Morning digest');
  });
});
