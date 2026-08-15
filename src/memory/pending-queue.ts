/**
 * Pending Extraction Queue
 *
 * Disk-backed queue of task IDs whose `task:completed` event fired but
 * whose extraction has not yet finished. Survives process restarts so the
 * memory layer never silently loses a learning.
 *
 * Storage: `workdir/memory/pending-extractions.md` — a Markdown file with
 * one task ID and extraction generation per `- ` list bullet. Human-readable;
 * deletable by hand if needed. Legacy task-only bullets remain readable.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { getMemoryDir, getPendingPath, isAllowedTaskId } from './paths.js';
import { logger } from '../system/logger.js';

const HEADER = '# Pending Extractions';
const GENERATION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface PendingExtraction {
  taskId: string;
  generation: string;
}

/**
 * Append a taskId to the pending queue. Idempotent: re-enqueueing an existing
 * ID is a no-op. Writes are atomic (tmp file + rename).
 */
export async function enqueuePending(taskId: string, generation = 'legacy'): Promise<string> {
  if (!isAllowedTaskId(taskId)) {
    logger.warn('memory', `enqueuePending: refused malformed taskId ${JSON.stringify(taskId)}`);
    return generation;
  }
  if (!GENERATION_RE.test(generation)) throw new Error(`Invalid extraction generation: ${generation}`);
  await mkdir(getMemoryDir(), { recursive: true });
  const existing = await readPendingEntries();
  const queued = existing.find((entry) => entry.taskId === taskId);
  if (queued) return queued.generation;
  const next = [...existing, { taskId, generation }];
  await writeAtomic(formatFile(next));
  return generation;
}

/**
 * Remove a taskId from the pending queue. No-op if absent. Writes are atomic.
 */
export async function dequeuePending(taskId: string, generation?: string): Promise<void> {
  const existing = await readPendingEntries();
  if (!existing.some((entry) => entry.taskId === taskId && (!generation || entry.generation === generation))) return;
  const next = existing.filter((entry) => entry.taskId !== taskId || (generation && entry.generation !== generation));
  await writeAtomic(formatFile(next));
}

/**
 * Return every task ID currently in the queue, in enqueue order.
 */
export async function readPending(): Promise<string[]> {
  return (await readPendingEntries()).map((entry) => entry.taskId);
}

/** Return pending task IDs with the generation that owns finalization. */
export async function readPendingEntries(): Promise<PendingExtraction[]> {
  const path = getPendingPath();
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const entries: PendingExtraction[] = [];
  for (const line of content.split('\n')) {
    const m = /^-\s+(\S+?)(?:\s+\[([A-Za-z0-9_-]{1,64})\])?\s*$/.exec(line);
    if (!m) continue;
    const taskId = m[1];
    if (isAllowedTaskId(taskId)) entries.push({ taskId, generation: m[2] ?? 'legacy' });
  }
  return entries;
}

// ---- Internal ----

function formatFile(entries: PendingExtraction[]): string {
  if (entries.length === 0) return `${HEADER}\n`;
  return `${HEADER}\n\n${entries.map(({ taskId, generation }) => `- ${taskId} [${generation}]`).join('\n')}\n`;
}

async function writeAtomic(content: string): Promise<void> {
  const path = getPendingPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}
