/**
 * Reminder Scheduler
 *
 * In-memory index of pending reminders, backed by task metadata on disk.
 * A 5-minute interval checks for due reminders and reactivates tasks.
 */

import { execSync } from 'child_process';
import { writeFile } from 'fs/promises';
import { Task } from '../tasks/task.js';
import { SESSIONS_DIR } from './workdir.js';
import { loadMetadata, getMetadataPath } from '../tasks/persistence.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { emitEvent } from './event-bus.js';
import { logger } from './logger.js';

// ---- In-memory index ----

interface PendingReminder {
  trigger_at: Date;
  reason: string;
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
 */
export function scheduleReminder(task: Task, triggerAt: Date, reason: string): void {
  pendingReminders.set(task.taskId, { trigger_at: triggerAt, reason });
  task.metadata.reminder = { trigger_at: triggerAt.toISOString(), reason };
  task.debouncedSave();
  emitEvent('reminder:set', task.taskId, { trigger_at: triggerAt.toISOString(), reason });
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
        });
      }
    }
  } catch (err) {
    logger.error('reminder-scheduler', 'Failed to rebuild reminders from disk', err);
  }
}

/**
 * Check for due reminders and fire them.
 */
async function checkDueReminders(): Promise<void> {
  const now = new Date();

  for (const [taskId, reminder] of pendingReminders) {
    if (reminder.trigger_at > now) continue;

    // 1. Remove from in-memory map
    pendingReminders.delete(taskId);

    try {
      // 2. Clear metadata.reminder + flush save (agent sees clean state)
      const metadata = await loadMetadata(taskId);
      if (!metadata) {
        logger.warn('reminder-scheduler', `Task ${taskId} not found on disk, skipping reminder`);
        continue;
      }

      metadata.reminder = undefined;
      await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));

      // 3. Reactivate task
      emitEvent('reminder:fired', taskId, { reason: reminder.reason });
      logger.system(`Reminder fired for ${taskId}: ${reminder.reason}`);
      const task = await Task.get(taskId);
      await task.sendMessage(
        AGENT_PROMPTS.reminder(reminder.reason),
      );
    } catch (err) {
      logger.error('reminder-scheduler', `Failed to fire reminder for ${taskId}`, err);
    }
  }
}
