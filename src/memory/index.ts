/**
 * Memory Module Entry Point
 *
 * Registers the memory lifecycle handler on the event bus.
 * Creates the memory directory structure if it doesn't exist.
 *
 * Integration: call initMemory() once at startup after initEventPersistence().
 * Ejection: delete this file + src/memory/ directory + remove the initMemory() call from src/index.ts.
 */

import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { onEvent } from '../system/event-bus.js';
import { handleTaskCompleted, rescheduleTaskCompleted } from './lifecycle.js';
import { readPending } from './pending-queue.js';
import {
  getMemoryDir,
  getMemoryMarkerPath,
  getPublicMemoryDir,
  getPrivateChannelsMemoryDir,
  getPrivateUsersMemoryDir,
  getRuntimeMemoryDir,
  getUsersDir,
  getSummariesDir,
  getEntitiesDir,
  isMemoryEnabled,
  isAllowedUserId,
  setMemoryReady,
} from './paths.js';
import { logger } from '../system/logger.js';

/**
 * Initialize the memory subsystem.
 * Safe to call when ARCHIE_MEMORY=false — becomes a no-op.
 */
let initPromise: Promise<boolean> | null = null;
const MARKER_TEMP_RE = /^\.scoped-v1\.json\.\d+(?:\.[0-9a-f-]{36})?\.tmp$/;
const MARKER_TEMP_STALE_MS = 5 * 60_000;

export async function initMemory(teamId: string | null): Promise<boolean> {
  initPromise ??= initializeMemory(teamId);
  return initPromise;
}

async function initializeMemory(teamId: string | null): Promise<boolean> {
  if (!isMemoryEnabled()) {
    setMemoryReady(false);
    logger.system('Memory layer disabled (ARCHIE_MEMORY=false)');
    return false;
  }

  if (!teamId) {
    setMemoryReady(false);
    logger.warn('memory', 'Memory layer disabled: Slack auth did not provide a team ID');
    return false;
  }

  try {
    const memoryDir = getMemoryDir();
    const markerPath = getMemoryMarkerPath();
    await mkdir(memoryDir, { recursive: true });
    const entries = await readdir(memoryDir);
    const markerTemps = entries.filter((entry) => MARKER_TEMP_RE.test(entry));
    await Promise.all(markerTemps.map(async (entry) => {
      const path = `${memoryDir}/${entry}`;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs >= MARKER_TEMP_STALE_MS) {
        await unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    }));
    const remainingEntries = entries.filter((entry) => !MARKER_TEMP_RE.test(entry));
    const hasMarker = remainingEntries.includes('.scoped-v1.json');
    if (remainingEntries.length > 0 && !hasMarker) {
      setMemoryReady(false);
      logger.warn('memory', 'Memory layer disabled: non-empty legacy store has no scoped-v1 marker');
      return false;
    }

    if (!hasMarker) {
      const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, `${JSON.stringify({ version: 1, team_id: teamId }, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
        await link(tempPath, markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(tempPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    }

    const marker = JSON.parse(await readFile(markerPath, 'utf-8')) as { version?: unknown; team_id?: unknown };
    if (marker.version !== 1 || marker.team_id !== teamId) {
      setMemoryReady(false);
      logger.warn('memory', 'Memory layer disabled: scoped store does not match the authenticated Slack workspace');
      return false;
    }

    await Promise.all([
      mkdir(getPublicMemoryDir(), { recursive: true }),
      mkdir(getPrivateChannelsMemoryDir(), { recursive: true }),
      mkdir(getPrivateUsersMemoryDir(), { recursive: true }),
      mkdir(getRuntimeMemoryDir(), { recursive: true }),
      mkdir(getUsersDir(), { recursive: true }),
      mkdir(getSummariesDir(), { recursive: true }),
      mkdir(getEntitiesDir(), { recursive: true }),
    ]);

    setMemoryReady(true);
    await warnLegacyUserFiles();
    await drainPendingExtractions();

    onEvent((event) => {
      if (event.type === 'task:completed') {
        handleTaskCompleted(event.taskId);
      }
    });

    logger.system('Memory layer initialized');
    return true;
  } catch (error) {
    setMemoryReady(false);
    logger.warn('memory', 'Memory layer disabled: scoped-store initialization failed', error);
    return false;
  }
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
 * Scan workdir/memory/public/users/ for filenames that are NOT raw Slack IDs and
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
export { isMemoryEnabled, isInjectionEnabled, isMemoryReady } from './paths.js';
