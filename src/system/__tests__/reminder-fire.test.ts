/**
 * Tests for the reminder fire path's ordering: resolve the task, then re-arm on
 * THAT instance, flush, then reactivate.
 *
 * The ordering is the whole point. `Task.get` returns the LIVE instance when a
 * task is already active, and that instance owns the entire metadata object — so
 * re-arming a `loadMetadata()` copy and writing it straight to disk would be
 * silently undone by the live instance's next `debouncedSave`, resurrecting the
 * reminder that just fired. For a recurring reminder the resurrected value is a
 * `trigger_at` in the past, which fires again on the next restart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../event-bus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../workdir.js', () => ({ SESSIONS_DIR: '/sessions' }));
vi.mock('../../agents/prompts.js', () => ({
  AGENT_PROMPTS: { reminder: (r: string) => `[reminder] ${r}` },
}));
vi.mock('../../tasks/persistence.js', () => ({ loadMetadata: vi.fn() }));

const { taskGet } = vi.hoisted(() => ({ taskGet: vi.fn() }));
vi.mock('../../tasks/task.js', () => ({ Task: { get: taskGet } }));

import { scheduleReminder, cancelReminder, checkDueReminders, getReminder } from '../reminder-scheduler.js';
import type { Task } from '../../tasks/task.js';

/** A stand-in for the live Task instance the scheduler must mutate. */
function makeTask(taskId = 'task-1') {
  return {
    taskId,
    metadata: { task_id: taskId, reminder: undefined as unknown },
    save: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkDueReminders — recurring', () => {
  it('re-arms on the live task instance, not on a detached disk copy', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    // Due now, recurring hourly.
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'stock check', { cron: '0 * * * *', tz: 'UTC' });
    await checkDueReminders();

    // The instance the rest of the system holds must carry the NEXT occurrence.
    const next = task.metadata.reminder as { trigger_at: string; cron: string; tz: string; reason: string };
    expect(next).toBeDefined();
    expect(new Date(next.trigger_at).getTime()).toBeGreaterThan(Date.now());
    expect(next.cron).toBe('0 * * * *');
    expect(next.tz).toBe('UTC');
    expect(next.reason).toBe('stock check');
  });

  it('flushes the re-arm before reactivating, so the agent never wakes on a stale reminder', async () => {
    const task = makeTask();
    const order: string[] = [];
    task.save.mockImplementation(async () => { order.push('save'); });
    task.sendMessage.mockImplementation(async () => { order.push('sendMessage'); });
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    await checkDueReminders();

    expect(order).toEqual(['save', 'sendMessage']);
    expect(task.save).toHaveBeenCalledWith(true); // flushed, not debounced
  });

  it('keeps the in-memory index armed for the next occurrence', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    await checkDueReminders();

    const armed = getReminder('task-1');
    expect(armed?.cron).toBe('0 * * * *');
    expect(armed!.trigger_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not fire a reminder that is not due yet', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() + 3_600_000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    await checkDueReminders();

    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(getReminder('task-1')).toBeDefined();
  });
});

describe('checkDueReminders — one-shot', () => {
  it('clears the reminder on the live instance and does not re-arm', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'check CI');
    await checkDueReminders();

    expect(task.metadata.reminder).toBeUndefined();
    expect(getReminder('task-1')).toBeUndefined();
    expect(task.sendMessage).toHaveBeenCalledOnce();
  });
});

describe('cancel_reminder is a complete off switch', () => {
  it('drops a recurring reminder entirely — index, next wake and cron', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() + 3_600_000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    expect(getReminder('task-1')?.cron).toBe('0 * * * *');

    cancelReminder(task as unknown as Task);

    expect(getReminder('task-1')).toBeUndefined();
    expect(task.metadata.reminder).toBeUndefined();
    // Nothing left to fire.
    await checkDueReminders();
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('stops the loop when called on the wake the reminder just re-armed', async () => {
    // The agent wakes, decides the monitor is done, and cancels. The reminder it
    // cancels is the freshly re-armed NEXT occurrence — cancelling that must end
    // the recurrence rather than leave the cron armed.
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    await checkDueReminders();
    expect(getReminder('task-1')).toBeDefined(); // re-armed

    cancelReminder(task as unknown as Task);

    expect(getReminder('task-1')).toBeUndefined();
    expect(task.metadata.reminder).toBeUndefined();
    await checkDueReminders();
    expect(task.sendMessage).toHaveBeenCalledOnce(); // only the original fire
  });
});

describe('checkDueReminders — missing task', () => {
  it('drops the reminder and keeps going when the task is gone', async () => {
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    taskGet.mockRejectedValue(new Error('Task task-1 not found'));

    await expect(checkDueReminders()).resolves.toBeUndefined();
    expect(getReminder('task-1')).toBeUndefined();
  });
});
