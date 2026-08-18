/**
 * Recent Activity Index
 *
 * Manages workdir/memory/recent-activity.md — a markdown table
 * of the most recent completed tasks, newest first.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getRecentActivityPath } from './paths.js';
import { sanitizeActivityEntry } from './sanitize.js';
import { logger } from '../system/logger.js';
import type { ActivityEntry } from './types.js';

const HEADER = `# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|`;

function parseRow(line: string): ActivityEntry | null {
  if (!line.startsWith('|') || !line.endsWith('|')) return null;
  const cells: string[] = [];
  let cell = '';
  for (let i = 1; i < line.length - 1; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += line[i];
    }
  }
  cells.push(cell.trim());
  if (cells.length !== 5) return null;

  const date = cells[0];
  // Skip header row and separator row
  if (date === 'Date' || date.startsWith('-')) return null;

  return {
    date,
    taskId: cells[1],
    summary: cells[2].replace(/\\\|/g, '|'),
    domain: cells[3],
    user: cells[4],
  };
}

function entryToRow(entry: ActivityEntry): string {
  return `| ${entry.date} | ${entry.taskId} | ${entry.summary} | ${entry.domain} | ${entry.user} |`;
}

function buildFile(entries: ActivityEntry[]): string {
  const rows = entries.map(entryToRow).join('\n');
  return rows.length > 0 ? `${HEADER}\n${rows}\n` : `${HEADER}\n`;
}

/**
 * Render entries as the activity markdown table (header + rows).
 */
export function renderActivityTable(entries: ActivityEntry[]): string {
  return buildFile(entries);
}

/** Read the activity file verbatim for prompt injection. */
export async function readActivityMarkdown(): Promise<string> {
  try {
    return await readFile(getRecentActivityPath(), 'utf-8');
  } catch {
    return '';
  }
}

/** Parse the markdown table and return all data entries. */
export async function readActivity(): Promise<ActivityEntry[]> {
  const content = await readActivityMarkdown();
  if (!content) return [];

  const entries: ActivityEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = parseRow(line.trimEnd());
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Insert a new entry at the top of the table (newest first). Sanitizes first.
 *
 * The activity index is keyed by `taskId` — at most one row per task. If a row
 * for the same task already exists (e.g. from a prior extraction that was
 * replayed by the durable queue, or from re-extracting the same task), it is
 * removed before the new row is inserted at the top. This keeps the index
 * idempotent under retries.
 */
export async function appendActivity(entry: ActivityEntry, maxEntries = 50): Promise<void> {
  const clean = sanitizeActivityEntry(entry);
  if (!clean) {
    logger.warn('memory', `dropped activity entry (sanitizer rejected): ${JSON.stringify(entry).slice(0, 120)}`);
    return;
  }

  const path = getRecentActivityPath();
  await mkdir(dirname(path), { recursive: true });

  const content = await readFile(path, 'utf-8').catch(() => '');

  const entries: ActivityEntry[] = [clean];
  for (const line of content.split('\n')) {
    const parsed = parseRow(line.trimEnd());
    if (!parsed || parsed.taskId === clean.taskId) continue;
    const existing = sanitizeActivityEntry(parsed);
    if (existing) entries.push(existing);
  }
  await writeFile(path, buildFile(entries.slice(0, Math.max(0, maxEntries))), 'utf-8');
}
