/**
 * Task Recovery
 *
 * Recovers active tasks after server restart.
 * Scans disk for in_progress tasks and re-spawns their agents.
 */

import { findTasksByStatus } from './task-manager.js';
import { reactivateTask } from './event-handler.js';
import { logger } from './logger.js';

/**
 * Recover all in_progress tasks after server restart.
 * Called once during startup, after server is ready to accept webhooks.
 */
export async function recoverActiveTasks(): Promise<void> {
  const activeTasks = await findTasksByStatus('in_progress');

  if (activeTasks.length === 0) {
    logger.system('Recovery: No in_progress tasks found');
    return;
  }

  logger.system(`Recovery: Found ${activeTasks.length} in_progress task(s), re-activating...`);

  for (const task of activeTasks) {
    try {
      await reactivateTask(task.task_id, 'recovery');
      logger.system(`Recovery: Re-activated task ${task.task_id}`);
    } catch (error) {
      logger.error('recovery', `Failed to recover task ${task.task_id}`, error);
    }
  }
}
