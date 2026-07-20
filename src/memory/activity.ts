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

const ROW_REGEX_5 = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|$/;
const SEPARATOR_REGEX = /^\|[-\s|]+\|$/;

function parseRow(line: string): ActivityEntry | null {
  const match = ROW_REGEX_5.exec(line);
  if (!match) return null;

  const date = match[1].trim();
  // Skip header row and separator row
  if (date === 'Date' || date.startsWith('-')) return null;

  return {
    date,
    taskId: match[2].trim(),
    summary: match[3].trim(),
    domain: match[4].trim(),
    user: match[5].trim(),
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

/** Parse the markdown table and return all data entries. */
export async function readActivity(): Promise<ActivityEntry[]> {
  const path = getRecentActivityPath();
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return [];
  }

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
export async function appendActivity(entry: ActivityEntry): Promise<void> {
  const clean = sanitizeActivityEntry(entry);
  if (!clean) {
    logger.warn('memory', `dropped activity entry (sanitizer rejected): ${JSON.stringify(entry).slice(0, 120)}`);
    return;
  }

  const path = getRecentActivityPath();
  await mkdir(dirname(path), { recursive: true });

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    await writeFile(path, `${HEADER}\n${entryToRow(clean)}\n`, 'utf-8');
    return;
  }

  const lines = content.split('\n');
  const sepIndex = lines.findIndex((line) => SEPARATOR_REGEX.test(line.trimEnd()));

  if (sepIndex === -1) {
    // Malformed file — rewrite from scratch with only the new entry
    await writeFile(path, `${HEADER}\n${entryToRow(clean)}\n`, 'utf-8');
    return;
  }

  // Drop any existing row(s) for the same taskId — last-write-wins semantics.
  const filtered = lines.filter((line, idx) => {
    if (idx <= sepIndex) return true; // header + separator
    const parsed = parseRow(line.trimEnd());
    return !parsed || parsed.taskId !== clean.taskId;
  });

  // Re-find the separator in the filtered list (shouldn't move, but be safe)
  const newSep = filtered.findIndex((line) => SEPARATOR_REGEX.test(line.trimEnd()));
  filtered.splice(newSep + 1, 0, entryToRow(clean));
  await writeFile(path, filtered.join('\n'), 'utf-8');
}

/** Keep only the newest maxEntries entries. Rewrites the file if trimming is needed. */
export async function trimActivity(maxEntries = 50): Promise<void> {
  const path = getRecentActivityPath();

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    // File doesn't exist — nothing to trim
    return;
  }

  const entries: ActivityEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = parseRow(line.trimEnd());
    if (entry) entries.push(entry);
  }

  if (entries.length <= maxEntries) return;

  const trimmed = entries.slice(0, maxEntries);
  await writeFile(path, buildFile(trimmed), 'utf-8');
}
