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
import { computeNextRun, describeSchedule } from './trigger-scheduler.js';
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
type Recurrence = { cron?: string; tz?: string; until?: string };

/**
 * One line in the task's thread when a recurring reminder starts or stops, so it never runs
 * silently in the background. Nothing is posted per run. Never throws: it sits on the paths
 * that stop a reminder.
 */
export function announceRecurrence(task: Task, kind: 'set' | 'ended' | 'cancelled', r: Recurrence): void {
  if (!r.cron) return;
  const cron = r.cron;
  void Promise.resolve()
    .then(() => {
      const tz = r.tz ?? 'UTC';
      const cadence = describeSchedule(cron, tz);
      const until = r.until
        ? new Date(r.until).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })
        : '';
      const line = kind === 'set'
        ? `⏰ I'll check this ${cadence}${until ? ` until ${until}` : ''}.`
        : kind === 'ended'
          ? `⏰ Last scheduled check — this ends the reminder that ran ${cadence}.`
          : `⏰ Stopped the reminder that ran ${cadence}.`;
      return task.postToUser(line);
    })
    .catch((err) => logger.warn('reminder-scheduler', `Could not post the reminder notice for ${task.taskId}`, err));
}

export function cancelReminder(task: Task): void {
  const prior = task.metadata.reminder;
  pendingReminders.delete(task.taskId);
  task.metadata.reminder = undefined;
  task.debouncedSave();
  emitEvent('reminder:cancelled', task.taskId);
  if (prior) announceRecurrence(task, 'cancelled', prior);
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
const MAX_LOAD_FAILURES = 5;
const loadFailures = new Map<string, number>();

export async function checkDueReminders(): Promise<void> {
  const now = new Date();

  // Iterate a snapshot: a Map iterator revisits a key re-inserted mid-loop, so an already-due
  // re-arm would be processed again in the same tick, forever.
  const due = [...pendingReminders].filter(([, reminder]) => reminder.trigger_at <= now);

  for (const [taskId, reminder] of due) {
    // 1. Remove from in-memory map
    pendingReminders.delete(taskId);

    try {
      // 2. Load the task.
      let task: Task;
      try {
        task = await Task.get(taskId);
      } catch (err) {
        // Retry a transient load failure for a few ticks, but not forever: an unreadable task
        // would otherwise re-run Task.get (and its plugin sync) every minute until restart.
        const failures = (loadFailures.get(taskId) ?? 0) + 1;
        if (taskExistsOnDisk(taskId) && failures < MAX_LOAD_FAILURES) {
          loadFailures.set(taskId, failures);
          pendingReminders.set(taskId, reminder);
          logger.warn('reminder-scheduler', `Could not load task ${taskId} to fire its reminder (attempt ${failures}/${MAX_LOAD_FAILURES}) — retrying next tick`, err);
        } else {
          loadFailures.delete(taskId);
          logger.error('reminder-scheduler', `Dropping the reminder for task ${taskId} — it ${taskExistsOnDisk(taskId) ? `could not be loaded after ${MAX_LOAD_FAILURES} attempts` : 'no longer exists on disk'}`, err);
        }
        continue;
      }
      loadFailures.delete(taskId);

      // 3. Re-arm or clear, flush, then wake — on the canonical instance (see Task.fireReminder).
      const rearm = planReminderRearm(reminder, now);
      const next = rearm
        ? { trigger_at: rearm.trigger_at.toISOString(), reason: reminder.reason, cron: rearm.cron, tz: rearm.tz, until: rearm.until }
        : undefined;
      // Index the re-arm BEFORE the flush so a failed save still retries, but never over a
      // replacement scheduled since this tick removed the entry.
      const rearmEntry = rearm && !pendingReminders.has(taskId)
        ? { trigger_at: rearm.trigger_at, reason: reminder.reason, cron: rearm.cron, tz: rearm.tz, until: rearm.until }
        : undefined;
      if (rearmEntry) pendingReminders.set(taskId, rearmEntry);
      logger.system(`Reminder fired for ${taskId}: ${reminder.reason}`);
      const fired = await task.fireReminder(
        { trigger_at: reminder.trigger_at.toISOString(), reason: reminder.reason, cron: reminder.cron, tz: reminder.tz, until: reminder.until },
        next,
        () => {
          // Fire before re-arm: the CLI folds events in order and reads reminder:fired as "nothing
          // pending", so the reverse order blanks the indicator.
          emitEvent('reminder:fired', taskId, { reason: reminder.reason });
          if (next) emitEvent('reminder:set', taskId, next);
        },
        AGENT_PROMPTS.reminder(reminder.reason),
      );
      if (fired && !rearm) announceRecurrence(task, 'ended', reminder);
      if (!fired) {
        if (rearmEntry && pendingReminders.get(taskId) === rearmEntry) pendingReminders.delete(taskId);
        logger.system(`Reminder for ${taskId} was cancelled or replaced before it fired — skipped`);
      }
    } catch (err) {
      logger.error('reminder-scheduler', `Failed to fire reminder for ${taskId}`, err);
    }
  }
}
