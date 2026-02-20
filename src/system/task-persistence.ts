/**
 * Task Persistence
 *
 * Debounced metadata writes. Single responsibility: disk I/O.
 *
 * Core principle: while a task is active, runtime.metadata is the truth.
 * Disk is a crash-recovery checkpoint — write-only via debounce.
 */

import { writeFile } from 'fs/promises';
import { getMetadataPath } from './task-manager.js';
import type { TaskRuntimeState } from './active-tasks.js';
import { logger } from './logger.js';

const DEBOUNCE_MS = 500;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const debouncedRuntimes = new Map<string, TaskRuntimeState>();

/**
 * Save task metadata to disk.
 * Default: debounced (coalesces rapid changes into one write).
 * With flush=true: cancels pending debounce and writes immediately.
 *
 * Syncs runtime.sessions → metadata.agent_sessions before every write.
 */
export async function saveTask(runtime: TaskRuntimeState, flush?: boolean): Promise<void> {
  const taskId = runtime.taskId;

  // Always cancel any pending debounce
  const existing = debounceTimers.get(taskId);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(taskId);
    debouncedRuntimes.delete(taskId);
  }

  if (flush) {
    await syncAndWrite(runtime);
    return;
  }

  // Debounced write
  debouncedRuntimes.set(taskId, runtime);
  debounceTimers.set(taskId, setTimeout(() => {
    debounceTimers.delete(taskId);
    debouncedRuntimes.delete(taskId);
    syncAndWrite(runtime).catch((err) =>
      logger.error('task-persistence', `Failed to persist metadata for task ${taskId}`, err)
    );
  }, DEBOUNCE_MS));
}

async function syncAndWrite(runtime: TaskRuntimeState): Promise<void> {
  for (const [name, session] of runtime.sessions) {
    runtime.metadata.agent_sessions[name] = { ...session };
  }
  runtime.metadata.updated_at = new Date().toISOString();
  await writeFile(getMetadataPath(runtime.taskId), JSON.stringify(runtime.metadata, null, 2));
}
