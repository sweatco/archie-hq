/**
 * Memory Module Entry Point
 *
 * Registers the memory lifecycle handler on the event bus.
 * Creates the memory directory structure if it doesn't exist.
 *
 * Integration: call initMemory() once at startup after initEventPersistence().
 * Ejection: delete this file + src/memory/ directory + remove the initMemory() call from src/index.ts.
 */

import { mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { onEvent } from '../system/event-bus.js';
import { handleTaskCompleted, rescheduleTaskCompleted, migrateLegacySummaries } from './lifecycle.js';
import { readPending } from './pending-queue.js';
import {
  getMemoryDir,
  getUsersDir,
  getTasksDir,
  getEntitiesDir,
  isMemoryEnabled,
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

  await mkdir(getMemoryDir(), { recursive: true });
  await mkdir(getUsersDir(), { recursive: true });
  await mkdir(getTasksDir(), { recursive: true });
  await mkdir(getEntitiesDir(), { recursive: true });

  await migrateLegacySummaries();
  await warnLegacyUserFiles();
  await drainPendingExtractions();

  onEvent((event) => {
    if (event.type === 'task:completed') {
      handleTaskCompleted(event.taskId);
    }
  });

  logger.system('Memory layer initialized');
}

/**
 * On startup, replay any task IDs left in pending-extractions.md so that
 * a process exit between task:completed and extraction completion does not
 * lose the learning.
 */
async function drainPendingExtractions(): Promise<void> {
  const pending = await readPending();
  if (pending.length === 0) return;
  logger.system(`[memory] Draining ${pending.length} pending extraction(s) from prior run`);
  for (const taskId of pending) {
    rescheduleTaskCompleted(taskId);
  }
}

/**
 * Scan workdir/memory/users/ for filenames that are NOT raw Slack IDs and
 * NOT documented fallback identifiers. Log a warning per file. No file is
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
      logger.warn('memory', `legacy user file (non-Slack-ID name): users/${name} — read at extraction time, never written to by this version`);
    }
  }
}

export { enrichPromptWithMemory } from './context.js';
export { isMemoryEnabled, isInjectionEnabled, isMemoryToolsEnabled } from './paths.js';
export { createMemoryToolsMcpServer } from './tools.js';
export type { MemoryToolsCtx } from './tools.js';
