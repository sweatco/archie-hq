/**
 * Reminder Scheduler
 *
 * In-memory index of pending reminders, backed by task metadata on disk.
 * A 5-minute interval checks for due reminders and reactivates tasks.
 */

import { execSync } from 'child_process';
import { Task } from '../tasks/task.js';
import { SESSIONS_DIR } from './workdir.js';
import { loadMetadata } from '../tasks/persistence.js';
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

  // Check every 5 minutes
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
  recurrence?: { cron: string; tz: string },
): void {
  pendingReminders.set(task.taskId, { trigger_at: triggerAt, reason, ...recurrence });
  task.metadata.reminder = { trigger_at: triggerAt.toISOString(), reason, ...recurrence };
  task.debouncedSave();
  emitEvent('reminder:set', task.taskId, {
    trigger_at: triggerAt.toISOString(),
    reason,
    ...(recurrence ? { cron: recurrence.cron, tz: recurrence.tz } : {}),
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
          ...(metadata.reminder.cron ? { cron: metadata.reminder.cron, tz: metadata.reminder.tz } : {}),
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
  reminder: { cron?: string; tz?: string },
  firedAt: Date,
): { trigger_at: Date; cron: string; tz: string } | null {
  if (!reminder.cron) return null;
  const tz = reminder.tz || 'UTC';
  const next = computeNextRun(reminder.cron, tz, firedAt);
  if (!next) {
    logger.warn('reminder-scheduler', `Recurring reminder cron "${reminder.cron}" (${tz}) no longer computes — dropping the recurrence`);
    return null;
  }
  return { trigger_at: next, cron: reminder.cron, tz };
}

/**
 * Check for due reminders and fire them. Exported for tests — the ordering here
 * (resolve the live task, then re-arm, then flush, then reactivate) is the part
 * that matters and it is not expressible as a pure function.
 */
export async function checkDueReminders(): Promise<void> {
  const now = new Date();

  for (const [taskId, reminder] of pendingReminders) {
    if (reminder.trigger_at > now) continue;

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
      } catch {
        logger.warn('reminder-scheduler', `Task ${taskId} not found on disk, skipping reminder`);
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
        };
        pendingReminders.set(taskId, {
          trigger_at: rearm.trigger_at,
          reason: reminder.reason,
          cron: rearm.cron,
          tz: rearm.tz,
        });
        emitEvent('reminder:set', taskId, {
          trigger_at: rearm.trigger_at.toISOString(),
          reason: reminder.reason,
          cron: rearm.cron,
          tz: rearm.tz,
        });
      } else {
        task.metadata.reminder = undefined;
      }
      await task.save(true);

      // 4. Reactivate task
      emitEvent('reminder:fired', taskId, { reason: reminder.reason });
      logger.system(`Reminder fired for ${taskId}: ${reminder.reason}`);
      await task.sendMessage(
        AGENT_PROMPTS.reminder(reminder.reason),
      );
    } catch (err) {
      logger.error('reminder-scheduler', `Failed to fire reminder for ${taskId}`, err);
    }
  }
}
