/**
 * Memory Store
 *
 * Read/write operations for per-user memory files.
 * All path resolution is delegated to paths.ts.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import {
  getUserPath,
  getUsersDir,
  getUserCap,
  getSectionCap,
  isHousekeepingEnabled,
} from './paths.js';
import { sanitizeUpdate } from './sanitize.js';
import { appendLastTouched, stripLastTouched } from './annotations.js';
import { logger } from '../system/logger.js';
import type { MemoryUpdate } from './types.js';

// ---- Users ----

/** Read a user's memory file — returns '' if it does not exist */
export async function readUser(username: string): Promise<string> {
  try {
    return await readFile(getUserPath(username), 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Write a user's memory file, creating users/ directory if needed. */
export async function writeUser(username: string, content: string): Promise<void> {
  await mkdir(getUsersDir(), { recursive: true });
  await writeFile(getUserPath(username), content, 'utf-8');
}

/** A loaded user memory file: guarded id, display name, raw content. */
export interface UserFile {
  id: string;
  displayName: string;
  text: string;
}

/** Parse the quoted display_name frontmatter written by this store. */
export function parseUserDisplayName(text: string): string {
  const match = text.match(/^display_name:\s*"((?:\\"|[^"\n])*)"\s*$/m);
  return match?.[1]?.replace(/\\"/g, '"').trim() ?? '';
}

/** Read only the requested user files, skipping missing or malformed entries. */
export async function readUserFiles(userIds: readonly string[]): Promise<UserFile[]> {
  const out: UserFile[] = [];
  for (const id of new Set(userIds)) {
    let text: string;
    try {
      text = await readUser(id);
    } catch (error) {
      logger.warn('memory', `readUserFiles: skipping invalid or unreadable user ${JSON.stringify(id)}: ${error}`);
      continue;
    }
    if (!text) continue;
    const displayName = parseUserDisplayName(text);
    if (!displayName) {
      logger.warn('memory', `readUserFiles: skipping ${id} with missing or malformed display_name`);
      continue;
    }
    out.push({ id, displayName, text });
  }
  return out;
}

/**
 * Apply a list of updates to a user's memory file. If the file does not exist,
 * create it with YAML frontmatter (`slack_user_id`, `display_name`, `aliases`).
 * Returns true if a soft cap was exceeded after the write.
 */
export async function applyUserUpdatesWithIdentity(
  userId: string,
  displayName: string,
  updates: MemoryUpdate[]
): Promise<boolean> {
  let content = await readUser(userId);
  if (!content) {
    content = buildUserFrontmatter(userId, displayName);
  }
  for (const update of updates) {
    const clean = sanitizeUpdate(update);
    if (!clean) {
      logger.warn('memory', `dropped user update for ${userId} (sanitizer rejected): ${JSON.stringify(update).slice(0, 120)}`);
      continue;
    }
    content = applyUpdate(content, clean);
  }
  await writeUser(userId, content);
  return softCapExceeded(content, getUserCap(), getSectionCap());
}

/**
 * Count bullets per section and total. Returns true if either threshold exceeds the cap.
 * Pure function — used by callers to decide whether to schedule a housekeeping pass.
 */
export function softCapExceeded(content: string, totalCap: number, sectionCap: number): boolean {
  if (!isHousekeepingEnabled()) return false;
  const bulletsBySection = new Map<string, number>();
  let currentSection = '';
  let total = 0;
  for (const raw of content.split('\n')) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(raw);
    if (sectionMatch && !raw.startsWith('### ')) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (/^-\s+/.test(raw)) {
      total++;
      bulletsBySection.set(currentSection, (bulletsBySection.get(currentSection) ?? 0) + 1);
    }
  }
  if (total > totalCap) return true;
  for (const n of bulletsBySection.values()) if (n > sectionCap) return true;
  return false;
}

function buildUserFrontmatter(userId: string, displayName: string): string {
  const safeDisplay = displayName.replace(/"/g, '\\"');
  return [
    '---',
    `slack_user_id: ${userId}`,
    `display_name: "${safeDisplay}"`,
    'aliases: []',
    '---',
    '',
  ].join('\n');
}

// ---- Update application ----

/**
 * Apply a single MemoryUpdate to a markdown string.
 *
 * - 'update' with old: find first line containing old text, replace with `- {content}`
 * - 'add': find `## {section}` header and insert `- {content}` at end of that section
 *           If section missing, append it at end of file
 */
export function applyUpdate(content: string, update: MemoryUpdate): string {
  if (update.action === 'update') {
    if (update.old === undefined) {
      logger.warn('memory', 'applyUpdate: update action without `old` field — skipped');
      return content;
    }
    const lines = content.split('\n');
    const idx = lines.findIndex((line) => stripLastTouched(line).includes(update.old!));
    if (idx !== -1) {
      // Refresh the touched annotation on update
      lines[idx] = appendLastTouched(`- ${update.content}`);
      return lines.join('\n');
    }
    // old text not found — skip + warn rather than silently appending
    logger.warn('memory', `applyUpdate: \`old\` text not found, skipped: ${update.old.slice(0, 80)}`);
    return content;
  }

  // 'add' action only — annotate with today's date
  const section = update.section;
  const newItem = appendLastTouched(`- ${update.content}`);

  if (!section) {
    // No section — append to end
    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n${newItem}\n` : `${newItem}\n`;
  }

  const lines = content.split('\n');
  const headerPattern = `## ${section}`;
  const headerIdx = lines.findIndex((line) => line.trim() === headerPattern);

  if (headerIdx === -1) {
    // Section does not exist — create it at end of file
    const trimmed = content.trimEnd();
    const separator = trimmed ? '\n\n' : '';
    return `${trimmed}${separator}## ${section}\n${newItem}\n`;
  }

  // Find end of section: next ## header or end of file
  let insertIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      insertIdx = i;
      break;
    }
  }

  // Remove trailing empty lines before insert point (within the section)
  // to avoid accumulating blank lines, then insert item before any trailing empties
  let actualInsert = insertIdx;
  while (actualInsert > headerIdx + 1 && lines[actualInsert - 1].trim() === '') {
    actualInsert--;
  }

  lines.splice(actualInsert, 0, newItem);
  return lines.join('\n');
}

/** Apply a list of updates to a user's memory file, sanitizing each before write. */
export async function applyUserUpdates(username: string, updates: MemoryUpdate[]): Promise<void> {
  let content = await readUser(username);
  for (const update of updates) {
    const clean = sanitizeUpdate(update);
    if (!clean) {
      logger.warn('memory', `dropped user update for ${username} (sanitizer rejected): ${JSON.stringify(update).slice(0, 120)}`);
      continue;
    }
    content = applyUpdate(content, clean);
  }
  await writeUser(username, content);
}
