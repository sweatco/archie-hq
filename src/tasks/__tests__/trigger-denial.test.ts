/**
 * Unit tests for Task.handleTriggerDenial's status gate.
 *
 * Approve/Deny cards are never retracted when they're superseded — an edited
 * proposal re-posts a card, and a task can propose more than once — so an older
 * card stays clickable after its trigger has been approved. Approval is already
 * idempotent (`enableProposedTrigger` requires `pending`); denial was not: it
 * deleted whatever id it was handed. A stale Deny therefore destroyed a LIVE
 * automation, and left it firing from the scheduler's in-memory index while its
 * file was gone, until the next restart.
 *
 * Calls the real prototype method on a minimal fake task (no LLM, no SDK).
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

const { loadTrigger, deleteTrigger } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  deleteTrigger: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../system/trigger-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger, deleteTrigger };
});

import { Task } from '../task.js';
import type { Trigger, TriggerStatus } from '../../types/trigger.js';

const TRIGGER_ID = 'trg-20260729-1056-6nd69p';

type FakeTask = {
  taskId: string;
  metadata: { pending_trigger_id?: string };
  debouncedSave: ReturnType<typeof vi.fn>;
};

function makeFakeTask(pendingId?: string): FakeTask {
  return {
    taskId: 'task-1',
    metadata: { pending_trigger_id: pendingId },
    debouncedSave: vi.fn(),
  };
}

function trigger(status: TriggerStatus): Trigger {
  return {
    id: TRIGGER_ID,
    status,
    created_by: 'U1',
    created_at: '2026-07-29T10:56:00.000Z',
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'growth-operations' },
    conditions: [{ type: 'schedule', tz: 'Europe/London', next_run_at: '2026-07-30T08:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'do it' },
  };
}

const deny = (task: FakeTask, id?: string) =>
  Task.prototype.handleTriggerDenial.call(task as unknown as Task, id);

beforeEach(() => {
  vi.clearAllMocks();
  deleteTrigger.mockResolvedValue(undefined);
});

describe('handleTriggerDenial', () => {
  it('withdraws a still-pending proposal', async () => {
    loadTrigger.mockResolvedValue(trigger('pending'));
    const task = makeFakeTask(TRIGGER_ID);

    await expect(deny(task, TRIGGER_ID)).resolves.toBe('withdrawn');

    expect(deleteTrigger).toHaveBeenCalledWith(TRIGGER_ID);
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });

  it('does NOT delete an already-approved trigger from a stale card', async () => {
    loadTrigger.mockResolvedValue(trigger('enabled'));
    const task = makeFakeTask();

    await expect(deny(task, TRIGGER_ID)).resolves.toBe('already_live');

    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('leaves a paused trigger alone too — pausing is not the same as never approved', async () => {
    loadTrigger.mockResolvedValue(trigger('paused'));

    await expect(deny(makeFakeTask(), TRIGGER_ID)).resolves.toBe('already_live');

    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('reports a trigger that is already gone rather than calling delete again', async () => {
    loadTrigger.mockResolvedValue(null);

    await expect(deny(makeFakeTask(), TRIGGER_ID)).resolves.toBe('not_found');

    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('falls back to the task\'s own pending id when no id is passed', async () => {
    loadTrigger.mockResolvedValue(trigger('pending'));
    const task = makeFakeTask(TRIGGER_ID);

    await expect(deny(task)).resolves.toBe('withdrawn');

    expect(loadTrigger).toHaveBeenCalledWith(TRIGGER_ID);
    expect(deleteTrigger).toHaveBeenCalledWith(TRIGGER_ID);
  });

  it('is a no-op when there is no id at all', async () => {
    await expect(deny(makeFakeTask())).resolves.toBe('not_found');

    expect(loadTrigger).not.toHaveBeenCalled();
    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('clears pending_trigger_id only when it matches the denied id', async () => {
    loadTrigger.mockResolvedValue(trigger('enabled'));
    const task = makeFakeTask('trg-20260729-1057-other');

    await deny(task, TRIGGER_ID);

    expect(task.metadata.pending_trigger_id).toBe('trg-20260729-1057-other');
  });
});
