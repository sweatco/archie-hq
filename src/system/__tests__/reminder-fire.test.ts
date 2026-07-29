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
const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }));
vi.mock('../event-bus.js', () => ({ emitEvent }));
vi.mock('../workdir.js', () => ({ SESSIONS_DIR: '/sessions' }));
vi.mock('../../agents/prompts.js', () => ({
  AGENT_PROMPTS: { reminder: (r: string) => `[reminder] ${r}` },
}));
const { metadataExists } = vi.hoisted(() => ({ metadataExists: { value: true } }));
vi.mock('../../tasks/persistence.js', () => ({
  loadMetadata: vi.fn(),
  taskExistsOnDisk: () => metadataExists.value,
}));

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
    metadataExists.value = false; // the task really is gone, not just unreadable
    taskGet.mockRejectedValue(new Error('Task task-1 not found'));

    await expect(checkDueReminders()).resolves.toBeUndefined();
    expect(getReminder('task-1')).toBeUndefined();
    metadataExists.value = true;
  });
});

describe('event order is a UI contract', () => {
  it('emits reminder:fired BEFORE the re-armed reminder:set', async () => {
    // Consumers fold this stream in order and read `reminder:fired` as "nothing
    // pending now" (cli/components/TaskDetail.tsx), so emitting the re-arm first
    // left the ⏰ indicator blank for the whole interval on an armed reminder.
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    emitEvent.mockClear();
    await checkDueReminders();

    const order = emitEvent.mock.calls.map((c) => c[0]);
    expect(order).toEqual(['reminder:fired', 'reminder:set']);
  });

  it('a one-shot emits only reminder:fired', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r');
    emitEvent.mockClear();
    await checkDueReminders();

    expect(emitEvent.mock.calls.map((c) => c[0])).toEqual(['reminder:fired']);
  });
});

describe('a failure loading the task must not silently kill the cadence', () => {
  it('leaves the reminder armed when the task metadata still exists (transient failure)', async () => {
    // Task.get throws for more than a missing task — a torn metadata read, a
    // failed migration write, a bad plugins commit. Dropping the entry on one of
    // those would kill a recurring cadence for the process lifetime while the
    // reminder stayed armed on disk to re-fire after a restart.
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    metadataExists.value = true;
    taskGet.mockRejectedValue(new Error('Unexpected token } in JSON'));

    await expect(checkDueReminders()).resolves.toBeUndefined();

    expect(getReminder('task-1')).toBeDefined(); // still armed, retried next tick
    metadataExists.value = true;
  });

  it('drops the reminder when the task is genuinely gone', async () => {
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    metadataExists.value = false;
    taskGet.mockRejectedValue(new Error('Task task-1 not found'));

    await checkDueReminders();

    expect(getReminder('task-1')).toBeUndefined(); // no infinite retry loop
    metadataExists.value = true;
  });
});

describe('a bounded recurrence expires on its own', () => {
  it('stops re-arming once the next wake would fall past until', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);
    // Hourly, but the window closes 30 minutes from now — so the next slot is out.
    const until = new Date(Date.now() + 30 * 60_000).toISOString();

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC', until });
    await checkDueReminders();

    expect(task.metadata.reminder).toBeUndefined();
    expect(getReminder('task-1')).toBeUndefined();
    expect(task.sendMessage).toHaveBeenCalledOnce(); // the due wake still happened
  });

  it('keeps re-arming while the window is still open, carrying until forward', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);
    const until = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();

    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC', until });
    await checkDueReminders();

    const next = task.metadata.reminder as { until: string; cron: string };
    expect(next).toBeDefined();
    expect(next.until).toBe(until);
    expect(getReminder('task-1')?.until).toBe(until);
  });
});

describe('one tick handles each task exactly once', () => {
  it('does not re-process a retry re-armed inside the same tick', async () => {
    // Regression: the retry path re-inserts a STILL-DUE entry, and a JS Map
    // iterator revisits keys re-added during iteration — so iterating the live map
    // spun forever on a transient Task.get failure. The tick iterates a snapshot.
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    metadataExists.value = true;
    taskGet.mockRejectedValue(new Error('torn read'));

    await expect(checkDueReminders()).resolves.toBeUndefined();

    expect(taskGet).toHaveBeenCalledTimes(1); // one attempt, not an endless retry
    expect(getReminder('task-1')).toBeDefined();
  });

  it('does not re-process a recurring reminder whose catch-up slot is also overdue', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);
    // Armed 3 days back on an hourly cron: the re-arm is computed from `now`, so
    // it lands in the future — but the guard must not depend on that.
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 3 * 24 * 3_600_000), 'r', { cron: '0 * * * *', tz: 'UTC' });

    await checkDueReminders();

    expect(task.sendMessage).toHaveBeenCalledTimes(1);
  });
});
