/**
 * Trigger Store
 *
 * File-based persistence for triggers — one JSON file per trigger under
 * TRIGGERS_DIR. Mirrors the task persistence helpers (src/tasks/persistence.ts)
 * in spirit: simple load/save/list/delete over a flat directory.
 *
 * The trigger scheduler (trigger-scheduler.ts) holds the in-memory index; this
 * module is the durable source of truth.
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import type { Trigger } from '../types/trigger.js';
import { TRIGGERS_DIR } from './workdir.js';
import { logger } from './logger.js';

/**
 * Generate a unique trigger ID.
 * Format: trg-YYYYMMDD-HHMM-xxxxxx (mirrors generateTaskId).
 */
export function generateTriggerId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8);
  return `trg-${year}${month}${day}-${hours}${minutes}-${random}`;
}

/**
 * Trigger ids are always minted by `generateTriggerId` as
 * `trg-<digits>-<digits>-<alnum>`. Validate any caller-supplied id — a PM tool
 * arg, the `/triggers/:id` route param, an approval `ref`, a Slack button value
 * — against that shape before it reaches a filesystem path. The allowed charset
 * excludes `.` and the path separators, so a validated id cannot express path
 * traversal (`../…`). This is the single sanitiser guarding every store path.
 */
const TRIGGER_ID_RE = /^trg-[A-Za-z0-9-]+$/;

export function isValidTriggerId(id: string): boolean {
  return typeof id === 'string' && TRIGGER_ID_RE.test(id);
}

/**
 * Return the id ONLY if it matches the trigger-id shape, as the value read from
 * the regex match (not the raw input). Building a path from the matched value —
 * rather than the caller's string — is what breaks the path-injection taint
 * flow: the result is provably constrained to `[A-Za-z0-9-]`, so it can carry
 * no `.` or separator and cannot express traversal. Returns null on no match.
 */
function matchedTriggerId(id: string): string | null {
  if (typeof id !== 'string') return null;
  const m = TRIGGER_ID_RE.exec(id);
  return m ? m[0] : null;
}

/**
 * Path to a trigger's JSON file. Throws on any id that would escape
 * TRIGGERS_DIR. Two guards: the id-shape check above, and — the canonical
 * path-injection remediation — resolving the candidate path and requiring it to
 * stay within the resolved base directory (`startsWith(base + sep)`), so the
 * returned path handed to `readFile`/`unlink`/`writeFile` is provably contained.
 */
export function getTriggerPath(id: string): string {
  const safeId = matchedTriggerId(id);
  if (safeId === null) {
    throw new Error(`Invalid trigger id: ${JSON.stringify(id)}`);
  }
  // Build from `safeId` (the regex-matched value), and additionally require the
  // resolved path to sit directly inside TRIGGERS_DIR — belt-and-suspenders
  // containment on top of the shape barrier.
  const base = resolve(TRIGGERS_DIR);
  const full = resolve(base, `${safeId}.json`);
  if (!full.startsWith(base + sep)) {
    throw new Error(`Invalid trigger id: ${JSON.stringify(id)}`);
  }
  return full;
}

/** Ensure the triggers directory exists. */
async function ensureTriggersDir(): Promise<void> {
  if (!existsSync(TRIGGERS_DIR)) {
    await mkdir(TRIGGERS_DIR, { recursive: true });
  }
}

/** Persist a trigger (create or overwrite). */
export async function saveTrigger(trigger: Trigger): Promise<void> {
  await ensureTriggersDir();
  await writeFile(getTriggerPath(trigger.id), JSON.stringify(trigger, null, 2));
}

/** Load a trigger by ID. Returns null if missing or unparseable. */
export async function loadTrigger(id: string): Promise<Trigger | null> {
  if (!isValidTriggerId(id)) return null; // malformed id → treat as "not found"
  const path = getTriggerPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Trigger;
  } catch (err) {
    logger.warn('trigger-store', `Failed to parse trigger ${id}: ${err}`);
    return null;
  }
}

/** List all triggers on disk (any status). */
export async function listTriggers(): Promise<Trigger[]> {
  await ensureTriggersDir();
  const entries = await readdir(TRIGGERS_DIR, { withFileTypes: true });
  const triggers: Trigger[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const trigger = await loadTrigger(entry.name.replace(/\.json$/, ''));
    if (trigger) triggers.push(trigger);
  }
  return triggers;
}

/** Delete a trigger's file. No-op if already gone. */
export async function deleteTrigger(id: string): Promise<void> {
  if (!isValidTriggerId(id)) return; // malformed id → nothing to delete
  const path = getTriggerPath(id);
  if (existsSync(path)) {
    await unlink(path);
  }
}

/**
 * Count active (enabled) triggers, optionally filtered by a predicate.
 * Used to enforce per-user / per-channel caps at creation time.
 */
export async function countActiveTriggers(
  predicate?: (t: Trigger) => boolean,
): Promise<number> {
  const all = await listTriggers();
  return all.filter((t) => t.status === 'enabled' && (!predicate || predicate(t))).length;
}

/**
 * Flip a proposed (`pending`) trigger to `enabled` and record the approver.
 * Returns the updated trigger, or null when it doesn't exist or isn't pending.
 * The caller is responsible for indexing it into the scheduler (which computes
 * the first `next_run_at` for schedule conditions).
 */
export async function enableProposedTrigger(
  id: string,
  approverId: string,
): Promise<Trigger | null> {
  const trigger = await loadTrigger(id);
  if (!trigger || trigger.status !== 'pending') return null;
  trigger.status = 'enabled';
  trigger.approved_by = approverId;
  await saveTrigger(trigger);
  return trigger;
}
