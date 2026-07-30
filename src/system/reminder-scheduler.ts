/**
 * Reminder Scheduler
 *
 * In-memory index of pending reminders, backed by task metadata on disk.
 * A 5-minute interval checks for due reminders and reactivates tasks.
 */

import { execSync } from 'child_process';
import { Task } from '../tasks/task.js';
import { SESSIONS_DIR } from './workdir.js';
import { loadMetadata, taskExistsOnDisk } from '../tasks/persistence.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { emitEvent } from './event-bus.js';
import { computeNextRun } from './trigger-scheduler.js';
import { logger } from './logger.js';

// ---- In-memory index ----

interface PendingReminder {
  trigger_at: Date;
  reason: string;
  /** Set for a recurring reminder — the scheduler re-arms from it instead of clearing. */
  cron?: string;
  /** IANA timezone the cron is evaluated in. */
  tz?: string;
  /** ISO 8601 end for a recurring reminder; the re-arm stops past it. */
  until?: string;
}

const pendingReminders = new Map<string, PendingReminder>();
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

// ---- Public API ----

/**
 * Initialize the reminder scheduler.
 * Scans task metadata on disk to rebuild the in-memory index, then starts the interval.
 */
export async function initReminderScheduler(): Promise<void> {
  await rebuildFromDisk();

  const count = pendingReminders.size;
  if (count > 0) {
    logger.system(`Reminder scheduler: loaded ${count} pending reminder(s)`);
  }

  // Tick every minute. A schedule slot is therefore honoured within a minute of
  // its cron instant, and an overdue reminder is caught up on the first tick.
  schedulerTimer = setInterval(() => {
    checkDueReminders().catch((err) =>
      logger.error('reminder-scheduler', 'Error checking due reminders', err),
    );
  }, 60_000);

  // Also run immediately to fire any overdue reminders from downtime
  checkDueReminders().catch((err) =>
    logger.error('reminder-scheduler', 'Error on initial reminder check', err),
  );
}

/**
 * Register a reminder for a task. Replaces any existing reminder.
 * Updates both in-memory map and task metadata.
 *
 * Pass `recurrence` to make it recurring: the scheduler then re-arms from the
 * cron after each fire instead of clearing it, so the cadence is owned by the
 * runtime rather than re-decided by the agent on every wake.
 */
export function scheduleReminder(
  task: Task,
  triggerAt: Date,
  reason: string,
  recurrence?: { cron: string; tz: string; until?: string },
): void {
  pendingReminders.set(task.taskId, { trigger_at: triggerAt, reason, ...recurrence });
  task.metadata.reminder = { trigger_at: triggerAt.toISOString(), reason, ...recurrence };
  task.debouncedSave();
  emitEvent('reminder:set', task.taskId, {
    trigger_at: triggerAt.toISOString(),
    reason,
    ...(recurrence ?? {}),
  });
}

/**
 * Cancel a pending reminder for a task.
 * Clears both in-memory map and task metadata.
 */
export function cancelReminder(task: Task): void {
  pendingReminders.delete(task.taskId);
  task.metadata.reminder = undefined;
  task.debouncedSave();
  emitEvent('reminder:cancelled', task.taskId);
}

/**
 * Get the pending reminder for a task (if any). Read-only.
 */
export function getReminder(taskId: string): PendingReminder | undefined {
  return pendingReminders.get(taskId);
}

// ---- Internal ----

/**
 * Scan all task metadata files to rebuild the in-memory index.
 */
async function rebuildFromDisk(): Promise<void> {
  try {
    const grepResult = execSync(
      `grep -l '"trigger_at"' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
      { encoding: 'utf-8' },
    ).trim();

    if (!grepResult) return;

    for (const filePath of grepResult.split('\n')) {
      const taskIdMatch = filePath.match(/task-[a-z0-9-]+/i);
      if (!taskIdMatch) continue;
      const taskId = taskIdMatch[0];

      const metadata = await loadMetadata(taskId);
      if (metadata?.reminder?.trigger_at) {
        pendingReminders.set(metadata.task_id, {
          trigger_at: new Date(metadata.reminder.trigger_at),
          reason: metadata.reminder.reason,
          cron: metadata.reminder.cron,
          tz: metadata.reminder.tz,
          until: metadata.reminder.until,
        });
      }
    }
  } catch (err) {
    logger.error('reminder-scheduler', 'Failed to rebuild reminders from disk', err);
  }
}

/**
 * What replaces a reminder that just fired. Pure so the re-arm rule is testable
 * without a clock or the filesystem.
 *
 * A one-shot (no cron) clears. A recurring one re-arms at the next cron instant
 * strictly after `firedAt`. An overdue recurring reminder — the process was down
 * across one or more windows — therefore fires ONCE on catch-up and then skips
 * straight to the next future instant rather than replaying every missed window,
 * matching how the trigger scheduler handles the same situation.
 *
 * A cron that no longer computes (invalid expression, or a timezone that stopped
 * resolving) degrades to a one-shot instead of re-arming forever on a broken
 * value — the same "drop it rather than re-fire forever" call the trigger tick makes.
 */
export function planReminderRearm(
  reminder: { cron?: string; tz?: string; until?: string },
  firedAt: Date,
): { trigger_at: Date; cron: string; tz: string; until?: string } | null {
  if (!reminder.cron) return null;
  const tz = reminder.tz || 'UTC';
  const next = computeNextRun(reminder.cron, tz, firedAt);
  if (!next) {
    logger.warn('reminder-scheduler', `Recurring reminder cron "${reminder.cron}" (${tz}) no longer computes — dropping the recurrence`);
    return null;
  }
  // A bounded recurrence expires by itself once the next slot falls past `until`,
  // which is what keeps "every morning this week" from waking the task forever.
  if (reminder.until) {
    const until = new Date(reminder.until);
    if (isNaN(until.getTime())) {
      logger.warn('reminder-scheduler', `Recurring reminder has an unparseable until "${reminder.until}" — dropping the recurrence rather than running unbounded`);
      return null;
    }
    if (next > until) {
      logger.system(`Recurring reminder reached its end (${reminder.until}) — not re-arming`);
      return null;
    }
  }
  return { trigger_at: next, cron: reminder.cron, tz, until: reminder.until };
}

/**
 * Check for due reminders and fire them. Exported for tests — the ordering here
 * (resolve the live task, then re-arm, then flush, then reactivate) is the part
 * that matters and it is not expressible as a pure function.
 */
export async function checkDueReminders(): Promise<void> {
  const now = new Date();

  // Snapshot the due set before touching the map. Re-inserting a key mid-iteration
  // appends it, and a JS Map iterator DOES revisit it — so a re-arm that is itself
  // already due (a bounded catch-up, or the retry path below re-arming an overdue
  // reminder) would be processed again in the same tick, forever. Iterating a copy
  // makes each tick handle each task exactly once.
  const due = [...pendingReminders].filter(([, reminder]) => reminder.trigger_at <= now);

  for (const [taskId, reminder] of due) {
    // 1. Remove from in-memory map
    pendingReminders.delete(taskId);

    try {
      // 2. Resolve the task BEFORE touching its reminder state. Task.get returns
      //    the LIVE instance when the task is already active, and that instance
      //    owns the whole metadata object — so writing a loadMetadata() copy
      //    straight to disk would be silently clobbered by its next
      //    debouncedSave, resurrecting the reminder being fired right now. For a
      //    recurring reminder that resurrected value is a trigger_at in the past,
      //    which fires again the moment the process restarts.
      let task: Task;
      try {
        task = await Task.get(taskId);
      } catch (err) {
        // The entry was popped above but nothing has been written yet, so the
        // reminder is still armed on disk. `Task.get` throws for more than a
        // missing task — a torn metadata read (writes are non-atomic), a failed
        // v30 migration write, a bad plugins commit — and dropping the entry on
        // one of those would silently kill a recurring cadence for the rest of
        // the process lifetime while leaving it armed on disk to fire again after
        // a restart. So distinguish: if the task's metadata file is gone the task
        // is really gone and the reminder goes with it; otherwise re-arm and let
        // the next tick retry.
        if (taskExistsOnDisk(taskId)) {
          pendingReminders.set(taskId, reminder);
          logger.warn('reminder-scheduler', `Could not load task ${taskId} to fire its reminder — left armed for the next tick`, err);
        } else {
          logger.warn('reminder-scheduler', `Task ${taskId} no longer exists on disk — dropping its reminder`);
        }
        continue;
      }

      // 3. Re-arm a recurring reminder, or clear a one-shot, and flush BEFORE
      //    reactivating so the agent wakes seeing its next occurrence (or a clean
      //    slate) rather than the fire it is handling. `cancel_reminder` then
      //    operates on that next occurrence, which is how an agent stops a
      //    recurring reminder for good.
      const rearm = planReminderRearm(reminder, now);
      if (rearm) {
        task.metadata.reminder = {
          trigger_at: rearm.trigger_at.toISOString(),
          reason: reminder.reason,
          cron: rearm.cron,
          tz: rearm.tz,
          until: rearm.until,
        };
        pendingReminders.set(taskId, {
          trigger_at: rearm.trigger_at,
          reason: reminder.reason,
          cron: rearm.cron,
          tz: rearm.tz,
          until: rearm.until,
        });
      } else {
        task.metadata.reminder = undefined;
      }
      await task.save(true);

      // 4. Announce the fire, THEN the re-arm. Consumers fold this stream in
      //    order and read `reminder:fired` as "nothing pending now"
      //    (cli/components/TaskDetail.tsx), so emitting the re-arm first left the
      //    ⏰ indicator blank for the whole interval on a reminder that was in fact
      //    armed — and made the log read backwards ("set for <next>" above
      //    "fired"). Order here is a UI contract, not cosmetics.
      emitEvent('reminder:fired', taskId, { reason: reminder.reason });
      if (rearm) {
        emitEvent('reminder:set', taskId, {
          trigger_at: rearm.trigger_at.toISOString(),
          reason: reminder.reason,
          cron: rearm.cron,
          tz: rearm.tz,
          until: rearm.until,
        });
      }

      // 5. Reactivate task
      logger.system(`Reminder fired for ${taskId}: ${reminder.reason}`);
      await task.sendMessage(
        AGENT_PROMPTS.reminder(reminder.reason),
      );
    } catch (err) {
      logger.error('reminder-scheduler', `Failed to fire reminder for ${taskId}`, err);
    }
  }
}
