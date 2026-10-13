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
vi.mock('../workdir.js', () => ({ SESSIONS_DIR: '/sessions', WORKDIR: '/workdir' }));
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

import { scheduleReminder, cancelReminder, checkDueReminders, getReminder, announceRecurrence } from '../reminder-scheduler.js';
import type { Task } from '../../tasks/task.js';

/**
 * A stand-in for the canonical Task instance. Its `fireReminder` mirrors the real one acting on
 * itself; which instance is canonical is Task's concern and is tested in task-fire-reminder.test.ts.
 */
function makeTask(taskId = 'task-1') {
  const task = {
    taskId,
    metadata: { task_id: taskId, reminder: undefined as unknown },
    save: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
    postToUser: vi.fn().mockResolvedValue(null),
    fireReminder: vi.fn(async (fired: { trigger_at: string; cron?: string }, next: unknown, beforeWake: () => void, message: string) => {
      const current = task.metadata.reminder as { trigger_at: string; cron?: string } | undefined;
      if (!current || new Date(current.trigger_at).getTime() !== new Date(fired.trigger_at).getTime() || current.cron !== fired.cron) return false;
      task.metadata.reminder = next;
      await task.save(true);
      beforeWake();
      await task.sendMessage(message);
      return true;
    }),
  };
  return task;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** announceRecurrence posts fire-and-forget; let it land. */
const flush = () => new Promise((r) => setImmediate(r));

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

    emitEvent.mockClear();
    cancelReminder(task as unknown as Task);

    expect(getReminder('task-1')).toBeUndefined();
    expect(task.metadata.reminder).toBeUndefined();
    // The off switch is observable — consumers clear their indicator on this event.
    expect(emitEvent).toHaveBeenCalledWith('reminder:cancelled', 'task-1');
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
  });
});

describe('checkDueReminders — the index survives a failed or overtaken fire', () => {
  it('keeps the next occurrence indexed when the flush fails, so the cadence retries', async () => {
    const task = makeTask();
    task.save.mockRejectedValue(new Error('EBUSY'));
    taskGet.mockResolvedValue(task as unknown as Task);
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });

    await checkDueReminders();

    expect(getReminder('task-1')?.cron).toBe('0 * * * *');
  });

  it('does not overwrite a reminder scheduled while the task was loading', async () => {
    const task = makeTask();
    const replacementAt = new Date(Date.now() + 5 * 3_600_000);
    taskGet.mockImplementationOnce(async () => {
      scheduleReminder(task as unknown as Task, replacementAt, 'replacement');
      return task as unknown as Task;
    });
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });

    await checkDueReminders();

    expect(getReminder('task-1')?.reason).toBe('replacement');
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('does not overwrite a reminder scheduled while the fire was in flight', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });
    const replacementAt = new Date(Date.now() + 5 * 3_600_000);
    task.fireReminder.mockImplementationOnce(async () => {
      scheduleReminder(task as unknown as Task, replacementAt, 'replacement');
      return false;
    });

    await checkDueReminders();

    expect(getReminder('task-1')?.reason).toBe('replacement');
    expect(getReminder('task-1')?.trigger_at.getTime()).toBe(replacementAt.getTime());
  });
});

describe('a recurring reminder is never silent', () => {
  it('words the set line as a plain cadence and an end date, never cron syntax', async () => {
    const task = makeTask();
    announceRecurrence(task as unknown as Task, 'set', { cron: '0 */12 * * *', tz: 'UTC', until: '2026-10-30T18:00:00.000Z' });
    await flush();
    // The exact end instant, not a bare day — a bare day hides whether that day's run happens.
    expect(task.postToUser).toHaveBeenCalledWith("⏰ I'll check this every 12 hours until 30 Oct, 18:00 UTC.");
  });

  it('words an hour list as times rather than "a custom schedule"', async () => {
    const task = makeTask();
    announceRecurrence(task as unknown as Task, 'set', { cron: '0 5,17 * * *', tz: 'UTC', until: '2026-10-30T18:00:00.000Z' });
    await flush();
    expect(task.postToUser.mock.calls[0][0]).toContain('every day at 5:00 AM and 5:00 PM');
  });

  it('never throws, even for a timezone that no longer resolves — it sits on the stop paths', async () => {
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() + 3_600_000), 'r', { cron: '0 9 * * *', tz: 'Not/A_Zone', until: '2026-10-30T00:00:00.000Z' });
    expect(() => cancelReminder(task as unknown as Task)).not.toThrow();
    await flush();
    expect(task.metadata.reminder).toBeUndefined();
    expect(getReminder('task-1')).toBeUndefined();
  });

  it('posts one line when it is cancelled', async () => {
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() + 3_600_000), 'r', { cron: '0 */12 * * *', tz: 'UTC', until: '2026-10-30T00:00:00.000Z' });

    cancelReminder(task as unknown as Task);
    await flush();

    expect(task.postToUser).toHaveBeenCalledWith('⏰ Stopped the reminder that ran every 12 hours.');
  });

  it('posts nothing per run while it keeps re-arming', async () => {
    const task = makeTask();
    taskGet.mockResolvedValue(task as unknown as Task);
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC', until: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() });

    await checkDueReminders();
    await flush();

    expect(task.sendMessage).toHaveBeenCalledOnce();
    expect(task.postToUser).not.toHaveBeenCalled();
  });

  it('posts nothing when a one-shot is cancelled', async () => {
    const task = makeTask();
    scheduleReminder(task as unknown as Task, new Date(Date.now() + 3_600_000), 'r');
    cancelReminder(task as unknown as Task);
    await flush();
    expect(task.postToUser).not.toHaveBeenCalled();
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

  it('stops retrying a task that stays unreadable, instead of every minute forever', async () => {
    const task = makeTask();
    taskGet.mockRejectedValue(new Error('unparseable metadata'));
    metadataExists.value = true;
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC' });

    for (let i = 0; i < 10; i++) await checkDueReminders();

    expect(taskGet.mock.calls.length).toBeLessThan(10);
    expect(getReminder('task-1')).toBeUndefined();
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
  it('stops re-arming once the next wake would fall past until, and says so in the thread', async () => {
    // Pinned to :05 past the hour: with a window closing 30 minutes later, the next hourly slot is out.
    // Unpinned, this only held in the second half of each hour.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
    try {
      const task = makeTask();
      taskGet.mockResolvedValue(task as unknown as Task);
      const until = new Date(Date.now() + 30 * 60_000).toISOString();

      scheduleReminder(task as unknown as Task, new Date(Date.now() - 1000), 'r', { cron: '0 * * * *', tz: 'UTC', until });
      await checkDueReminders();
      await flush();

      expect(task.metadata.reminder).toBeUndefined();
      expect(getReminder('task-1')).toBeUndefined();
      expect(task.sendMessage).toHaveBeenCalledOnce(); // the due wake still happened
      // Posted at the last run, so it must not name a date that is still ahead.
      expect(task.postToUser).toHaveBeenCalledWith('⏰ Last scheduled check — this ends the reminder that ran every hour.');
    } finally {
      vi.useRealTimers();
    }
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

  it('does not re-process a recurring reminder re-armed by a failed load inside the same tick', async () => {
    // The retry path re-inserts the SAME overdue entry; a Map iterator would revisit it, and the
    // second Task.get (now succeeding) would fire it within the tick that just failed.
    const task = makeTask();
    taskGet.mockRejectedValueOnce(new Error('torn read')).mockResolvedValue(task as unknown as Task);
    scheduleReminder(task as unknown as Task, new Date(Date.now() - 3 * 24 * 3_600_000), 'r', { cron: '0 * * * *', tz: 'UTC' });

    await checkDueReminders();

    expect(taskGet).toHaveBeenCalledTimes(1);
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(getReminder('task-1')).toBeDefined();
  });
});
