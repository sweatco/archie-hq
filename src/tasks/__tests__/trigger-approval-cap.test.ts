/**
 * Tests for Task.handleTriggerApproval when the active-trigger cap is reached.
 *
 * Caps are re-checked at approval because pending proposals don't count toward
 * them (several could otherwise be approved past the limit). The refusal used to
 * DELETE the pending file, which made it indistinguishable from a withdrawal:
 * the Slack handler re-reads, finds nothing, and tells the user the proposal "is
 * no longer around" — never that a cap was the reason — and the proposal is gone,
 * so freeing a slot doesn't help. Nothing was logged either.
 *
 * Calls the real prototype method on a minimal fake task.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    slack: vi.fn(), agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(),
  },
}));

vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));

const { loadTrigger, deleteTrigger, enableProposedTrigger, countActiveTriggers } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  deleteTrigger: vi.fn().mockResolvedValue(undefined),
  enableProposedTrigger: vi.fn(),
  countActiveTriggers: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger, deleteTrigger, enableProposedTrigger, countActiveTriggers };
});

const { indexTrigger, announceTriggerChange } = vi.hoisted(() => ({
  indexTrigger: vi.fn(),
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../system/trigger-scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../system/trigger-scheduler.js')>();
  return { ...actual, indexTrigger, announceTriggerChange };
});

import { Task } from '../task.js';
import { appendAgentFinding } from '../persistence.js';
import { logger } from '../../system/logger.js';
import type { Trigger } from '../../types/trigger.js';

const TRIGGER_ID = 'trg-20260729-1056-capped';

function makeFakeTask() {
  return { taskId: 'task-1', metadata: { pending_trigger_id: TRIGGER_ID }, debouncedSave: vi.fn() };
}

function pending(): Trigger {
  return {
    id: TRIGGER_ID,
    status: 'pending',
    created_by: 'U1',
    created_at: '2026-07-29T10:56:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'growth-operations' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-07-30T08:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'do it' },
  } as Trigger;
}

const approve = (task: ReturnType<typeof makeFakeTask>) =>
  Task.prototype.handleTriggerApproval.call(task as unknown as Task, 'U9', TRIGGER_ID);

beforeEach(() => {
  vi.clearAllMocks();
  deleteTrigger.mockResolvedValue(undefined);
  announceTriggerChange.mockResolvedValue(undefined);
});

describe('handleTriggerApproval — cap reached', () => {
  it('does NOT delete the proposal, so the user can free a slot and approve it again', async () => {
    loadTrigger.mockResolvedValue(pending());
    countActiveTriggers.mockResolvedValue(999); // over any cap

    await expect(approve(makeFakeTask())).resolves.toBeNull();

    expect(deleteTrigger).not.toHaveBeenCalled();
    expect(enableProposedTrigger).not.toHaveBeenCalled();
    expect(indexTrigger).not.toHaveBeenCalled();
  });

  it('leaves the proposal reachable — pending_trigger_id survives an unresolved click', async () => {
    loadTrigger.mockResolvedValue(pending());
    countActiveTriggers.mockResolvedValue(999);
    const task = makeFakeTask();

    await approve(task);

    expect(task.metadata.pending_trigger_id).toBe(TRIGGER_ID);
  });

  it('records the cap as the reason, in the log and the knowledge log', async () => {
    loadTrigger.mockResolvedValue(pending());
    countActiveTriggers.mockResolvedValue(999);

    await approve(makeFakeTask());

    expect(logger.warn).toHaveBeenCalled();
    expect(appendAgentFinding).toHaveBeenCalledOnce();
    const [, , text] = (appendAgentFinding as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(text)).toMatch(/cap reached/i);
    expect(String(text)).toMatch(/awaiting approval/i);
  });

  it('enables normally when under the cap', async () => {
    const enabled = { ...pending(), status: 'enabled' as const };
    loadTrigger.mockResolvedValue(pending());
    countActiveTriggers.mockResolvedValue(0);
    enableProposedTrigger.mockResolvedValue(enabled);
    const task = makeFakeTask();

    await expect(approve(task)).resolves.toEqual(enabled);

    expect(indexTrigger).toHaveBeenCalledOnce();
    expect(announceTriggerChange).toHaveBeenCalledOnce();
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });
});
