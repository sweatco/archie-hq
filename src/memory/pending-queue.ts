/**
 * Pending Extraction Queue
 *
 * Disk-backed queue of task IDs whose `task:completed` event fired but
 * whose extraction has not yet finished. Survives process restarts so the
 * memory layer never silently loses a learning.
 *
 * Storage: `workdir/memory/runtime/pending-extractions.md` — a Markdown file with
 * one task ID per line under a `- ` list bullet. Human-readable; deletable
 * by hand if needed.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { getMemoryDir, getPendingPath, isAllowedTaskId } from './paths.js';
import { logger } from '../system/logger.js';

const HEADER = '# Pending Extractions';

/**
 * Append a taskId to the pending queue. Idempotent: re-enqueueing an existing
 * ID is a no-op. Writes are atomic (tmp file + rename).
 */
export async function enqueuePending(taskId: string): Promise<void> {
  if (!isAllowedTaskId(taskId)) {
    logger.warn('memory', `enqueuePending: refused malformed taskId ${JSON.stringify(taskId)}`);
    return;
  }
  await mkdir(getMemoryDir(), { recursive: true });
  const existing = await readPending();
  if (existing.includes(taskId)) return;
  const next = [...existing, taskId];
  await writeAtomic(formatFile(next));
}

/**
 * Remove a taskId from the pending queue. No-op if absent. Writes are atomic.
 */
export async function dequeuePending(taskId: string): Promise<void> {
  const existing = await readPending();
  if (!existing.includes(taskId)) return;
  const next = existing.filter((id) => id !== taskId);
  await writeAtomic(formatFile(next));
}

/**
 * Return every task ID currently in the queue, in enqueue order.
 */
export async function readPending(): Promise<string[]> {
  const path = getPendingPath();
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const ids: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^-\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const id = m[1];
    if (isAllowedTaskId(id)) ids.push(id);
  }
  return ids;
}

// ---- Internal ----

function formatFile(ids: string[]): string {
  if (ids.length === 0) return `${HEADER}\n`;
  return `${HEADER}\n\n${ids.map((id) => `- ${id}`).join('\n')}\n`;
}

async function writeAtomic(content: string): Promise<void> {
  const path = getPendingPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}
