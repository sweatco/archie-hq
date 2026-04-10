/**
 * Memory Module Entry Point
 *
 * Registers the memory lifecycle handler on the event bus.
 * Creates the memory directory structure if it doesn't exist.
 *
 * Integration: call initMemory() once at startup after initEventPersistence().
 * Ejection: delete this file + src/memory/ directory + remove the initMemory() call from src/index.ts.
 */

import { mkdir } from 'fs/promises';
import { onEvent } from '../system/event-bus.js';
import { handleTaskCompleted } from './lifecycle.js';
import { getMemoryDir, getUsersDir, isMemoryEnabled } from './paths.js';
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

  onEvent((event) => {
    if (event.type === 'task:completed') {
      handleTaskCompleted(event.taskId);
    }
  });

  logger.system('Memory layer initialized');
}

export { enrichPromptWithMemory } from './context.js';
export { isMemoryEnabled } from './paths.js';
