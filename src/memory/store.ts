/**
 * Memory Store
 *
 * Read/write operations for org.md and per-user memory files.
 * All path resolution is delegated to paths.ts.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getOrgPath, getUserPath, getUsersDir } from './paths.js';
import type { MemoryUpdate } from './types.js';

// ---- Org ----

/** Read org.md — returns '' if file does not exist */
export async function readOrg(): Promise<string> {
  try {
    return await readFile(getOrgPath(), 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Write org.md, creating parent directory if needed */
export async function writeOrg(content: string): Promise<void> {
  const path = getOrgPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

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

/** Write a user's memory file, creating users/ directory if needed */
export async function writeUser(username: string, content: string): Promise<void> {
  await mkdir(getUsersDir(), { recursive: true });
  await writeFile(getUserPath(username), content, 'utf-8');
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
  if (update.action === 'update' && update.old !== undefined) {
    const lines = content.split('\n');
    const idx = lines.findIndex((line) => line.includes(update.old!));
    if (idx !== -1) {
      lines[idx] = `- ${update.content}`;
      return lines.join('\n');
    }
    // old text not found — fall through to append as add
  }

  // 'add' action (or 'update' with no match — treat as add)
  const section = update.section;
  const newItem = `- ${update.content}`;

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

/** Apply a list of updates to org.md */
export async function applyOrgUpdates(updates: MemoryUpdate[]): Promise<void> {
  let content = await readOrg();
  for (const update of updates) {
    content = applyUpdate(content, update);
  }
  await writeOrg(content);
}

/** Apply a list of updates to a user's memory file */
export async function applyUserUpdates(username: string, updates: MemoryUpdate[]): Promise<void> {
  let content = await readUser(username);
  for (const update of updates) {
    content = applyUpdate(content, update);
  }
  await writeUser(username, content);
}
