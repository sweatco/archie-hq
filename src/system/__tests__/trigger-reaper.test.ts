/**
 * The boot-scan reaper itself.
 *
 * `pendingSince` decides which clock the 24h pending TTL measures from, and that
 * is unit-tested next door — but nothing exercised the scan that CALLS it, so the
 * whole reaper branch could be deleted in silence. This drives it through
 * `initTriggerScheduler`, which is the only exported entry point that reaches
 * `rebuildFromDisk`.
 *
 * `ARCHIE_TRIGGERS_ENABLED=false` is required, not incidental: with firing on,
 * `initTriggerScheduler` starts a 60s interval and runs an immediate due-check,
 * which would leak a timer out of the test and try to fire real triggers. The
 * index is still rebuilt when firing is off, which is exactly the part under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

process.env.ARCHIE_TRIGGERS_ENABLED = 'false';

const { listTriggers, deleteTrigger, saveTrigger, countActiveTriggers } = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  deleteTrigger: vi.fn().mockResolvedValue(undefined),
  saveTrigger: vi.fn().mockResolvedValue(undefined),
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../trigger-store.js', () => ({ listTriggers, deleteTrigger, saveTrigger, countActiveTriggers }));

vi.mock('../logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));
vi.mock('../../tasks/task.js', () => ({ Task: { get: vi.fn(), create: vi.fn() }, activeTasks: new Map() }));
vi.mock('../../tasks/persistence.js', () => ({ appendSlackMessage: vi.fn(), loadMetadata: vi.fn(), findTaskByThread: vi.fn() }));
vi.mock('../event-bus.js', () => ({ emitEvent: vi.fn(), onEvent: vi.fn(), offEvent: vi.fn() }));

const { initTriggerScheduler, getEnabledTriggerIds } = await import('../trigger-scheduler.js') as typeof import('../trigger-scheduler.js') & { getEnabledTriggerIds?: () => string[] };

const DAY = 24 * 60 * 60_000;
const now = () => Date.now();

function trigger(over: Partial<Trigger>): Trigger {
  return {
    id: 'trg-20260824-0900-x',
    status: 'pending',
    summary: 's',
    created_by: 'U1',
    created_at: new Date(now() - 2 * DAY).toISOString(),
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'general' },
    conditions: [{ type: 'schedule', cron: '0 9 * * *', tz: 'UTC', next_run_at: new Date(now() + DAY).toISOString() }],
    action: { prompt: 'p' },
    ...over,
  } as Trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteTrigger.mockResolvedValue(undefined);
});

describe('the boot scan reaps abandoned proposals', () => {
  it('reaps a pending proposal past the 24h TTL', async () => {
    listTriggers.mockResolvedValue([trigger({ id: 'trg-20260801-0900-stale' })]);
    await initTriggerScheduler();
    expect(deleteTrigger).toHaveBeenCalledWith('trg-20260801-0900-stale');
  });

  it('spares one revised inside the window — an edit renews the clock', async () => {
    // Created two days ago, edited a minute ago. Measuring from created_at would
    // reap this and take its just-posted Approve/Deny card with it.
    listTriggers.mockResolvedValue([trigger({
      id: 'trg-20260801-0900-revised',
      created_at: new Date(now() - 2 * DAY).toISOString(),
      updated_at: new Date(now() - 60_000).toISOString(),
    })]);
    await initTriggerScheduler();
    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('spares a fresh proposal', async () => {
    listTriggers.mockResolvedValue([trigger({ id: 'trg-20260824-0900-fresh', created_at: new Date(now() - 60_000).toISOString() })]);
    await initTriggerScheduler();
    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('never reaps an enabled trigger, however old', async () => {
    // The reaper is for proposals nobody answered. An approved automation is not
    // one, and age says nothing about it.
    listTriggers.mockResolvedValue([trigger({
      id: 'trg-20250101-0900-ancient',
      status: 'enabled',
      created_at: new Date(now() - 400 * DAY).toISOString(),
    })]);
    await initTriggerScheduler();
    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('never reaps a paused trigger', async () => {
    listTriggers.mockResolvedValue([trigger({ id: 'trg-20250101-0900-paused', status: 'paused', created_at: new Date(now() - 400 * DAY).toISOString() })]);
    await initTriggerScheduler();
    expect(deleteTrigger).not.toHaveBeenCalled();
  });
});
