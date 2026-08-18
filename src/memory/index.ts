/**
 * Memory Module Entry Point
 *
 * Registers the memory lifecycle handler on the event bus.
 * Creates the memory directory structure if it doesn't exist.
 *
 * Integration: call initMemory() once at startup after initEventPersistence().
 * Ejection: delete this file + src/memory/ directory + remove the initMemory() call from src/index.ts.
 */

import { mkdir, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { onTaskCompleted } from '../system/event-bus.js';
import { handleTaskCompleted, rescheduleTaskCompleted } from './lifecycle.js';
import { readPendingEntries } from './pending-queue.js';
import {
  getMemoryDir,
  getPublicStoreMarkerPath,
  getUsersDir,
  getTasksDir,
  getEntitiesDir,
  isMemoryEnabled,
  disableMemoryRuntime,
  isAllowedUserId,
} from './paths.js';
import { logger } from '../system/logger.js';

/**
 * Initialize the memory subsystem.
 * Safe to call when ARCHIE_MEMORY=false — becomes a no-op.
 */
export async function initMemory(): Promise<void> {
  if (!isMemoryEnabled()) {
    logger.system('Memory layer disabled (ARCHIE_MEMORY=false)');
    return;
  }

  try {
    if (!(await preparePublicStore())) return;
    await warnLegacyUserFiles();
    await drainPendingExtractions();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    disableMemoryRuntime(reason);
    logger.error('memory', `Memory initialization failed; memory is disabled for this process: ${reason}`);
    return;
  }

  onTaskCompleted((event) => handleTaskCompleted(event.taskId));

  logger.system('Memory layer initialized');
}

async function preparePublicStore(): Promise<boolean> {
  const memoryDir = getMemoryDir();
  const marker = getPublicStoreMarkerPath();
  if (!existsSync(marker) && await containsAnyFile(memoryDir)) {
    const reason = `existing store has no public-store marker; snapshot and clear ${memoryDir} before enabling memory`;
    disableMemoryRuntime(reason);
    logger.error('memory', `Memory disabled: ${reason}`);
    return false;
  }

  await mkdir(memoryDir, { recursive: true });
  await mkdir(getUsersDir(), { recursive: true });
  await mkdir(getTasksDir(), { recursive: true });
  await mkdir(getEntitiesDir(), { recursive: true });
  if (!existsSync(marker)) await writeFile(marker, 'public-store-v1\n', 'utf-8');
  return true;
}

async function containsAnyFile(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && await containsAnyFile(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * On startup, replay any task IDs left in pending-extractions.md so that
 * a process exit between task:completed and extraction completion does not
 * lose the learning.
 */
async function drainPendingExtractions(): Promise<void> {
  const pending = await readPendingEntries();
  if (pending.length === 0) return;
  logger.system(`[memory] Draining ${pending.length} pending extraction(s) from prior run`);
  for (const { taskId, generation } of pending) {
    rescheduleTaskCompleted(taskId, generation);
  }
}

/**
 * Scan workdir/memory/users/ for profile filenames that are NOT raw Slack IDs
 * or documented fallback identifiers. Log a warning per file. No file is
 * renamed or deleted — operators decide what to do with legacy data.
 */
async function warnLegacyUserFiles(): Promise<void> {
  const dir = getUsersDir();
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const stem = name.slice(0, -3);
    // Reverse the colon-to-double-underscore normalisation for fallback IDs.
    const candidate = stem.replace(/^(cli|local)__/, '$1:');
    if (!isAllowedUserId(candidate)) {
      logger.warn('memory', `legacy profile file (non-Slack-ID name): users/${name} — retained unchanged and ignored by profile extraction`);
    }
  }
}

export { enrichPromptWithMemory } from './context.js';
export { isMemoryEnabled, isInjectionEnabled } from './paths.js';
