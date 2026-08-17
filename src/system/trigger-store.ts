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

import { mkdir, readFile, writeFile, readdir, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import type { Trigger } from '../types/trigger.js';
import { TRIGGERS_DIR, TRIGGERS_DATA_DIR } from './workdir.js';
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

/**
 * Path to a trigger's persistent data directory. Same two-guard shape as
 * {@link getTriggerPath} — the id-shape check, then resolved-path containment
 * within TRIGGERS_DATA_DIR — because this path is handed to `mkdir`/`rm` and to
 * a sandbox write grant, all of which deserve the same provable containment.
 * The one difference: no `.json` suffix, because this is a directory the agent
 * writes files into, not a record file.
 */
export function getTriggerDataPath(id: string): string {
  const safeId = matchedTriggerId(id);
  if (safeId === null) {
    throw new Error(`Invalid trigger id: ${JSON.stringify(id)}`);
  }
  const base = resolve(TRIGGERS_DATA_DIR);
  const full = resolve(base, safeId);
  if (!full.startsWith(base + sep)) {
    throw new Error(`Invalid trigger id: ${JSON.stringify(id)}`);
  }
  return full;
}

/**
 * Ensure a trigger's persistent data directory exists, and return its path.
 * Returns null when the trigger no longer exists, having created nothing.
 *
 * The directory is deliberately left empty — no seed file, no subdirectories.
 * Conventions for what belongs in there are taught to the agent by the
 * `trigger-continuity` skill, and imposing a structure from code is an explicit
 * non-goal: the agent decides its own layout and the skill describes it.
 *
 * `recursive: true` is what makes this idempotent, and idempotence is required
 * rather than merely nice: agent spawn re-runs this per agent, on every wake of
 * a task, and again after a process restart, so it must be safe to call on a
 * directory that already exists and already holds an earlier fire's notes.
 *
 * That same re-entrancy is why the record has to be checked first. A task
 * outlives the fire that created it — a user can keep replying in its thread,
 * the PM can delegate to a specialist, and a restart re-spawns it — while
 * `metadata.triggered_by` keeps naming a trigger the user may have deleted in
 * the meantime. Without this check the next spawn would `mkdir` the directory
 * straight back after {@link deleteTrigger} removed it, so deleted content
 * reappears on disk and the directory is orphaned for good: nothing scans
 * TRIGGERS_DATA_DIR for entries whose record is gone, so nothing would ever
 * remove it again.
 *
 * The check is deliberately `existsSync` on the record path rather than
 * {@link loadTrigger}. `loadTrigger` returns null for three different states —
 * malformed id, missing file, and a `JSON.parse` failure — and only the first
 * two mean "gone". `saveTrigger` is a plain `writeFile`, so it truncates before
 * it writes, and it runs on every fire as well as on every PM edit; a spawn that
 * happened to read the record mid-write would see unparseable JSON and conclude
 * a perfectly live trigger had been deleted, silently denying that fire its
 * directory. Existence cannot be torn that way, and it costs no read or parse on
 * a path that runs once per agent per wake.
 */
export async function ensureTriggerDataDir(id: string): Promise<string | null> {
  if (!isValidTriggerId(id) || !existsSync(getTriggerPath(id))) return null;
  const path = getTriggerDataPath(id);
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Remove a trigger's persistent data directory and everything inside it.
 * Mirrors {@link deleteTrigger}'s malformed-id contract: a silent return, not a
 * throw. `force: true` makes a never-created directory a silent no-op, which is
 * the common case rather than the exception — a pending trigger that was denied,
 * refused by a cap, or garbage-collected never fired, so it never got a
 * directory in the first place.
 *
 * A real filesystem refusal (EACCES, EPERM, a busy mount) propagates, on
 * purpose. Swallowing it was tried and reverted: it made every caller report a
 * deletion that had not happened — the PM tool answers "deleted" and announces
 * it to the bound channel, the API route returns ok — while the record was
 * already unlinked, leaving the retained notes both unreachable (nothing can
 * resolve a directory whose record is gone) and unremovable (no caller reaches
 * this function except through {@link deleteTrigger}). Telling a user their
 * automation's data is gone when it is still on the host is worse than failing
 * loudly.
 *
 * That leaves `deleteTrigger` with two throw sites inside the loop
 * `rebuildFromDisk` uses to index enabled triggers, so a refusal there still
 * aborts the scan. That fragility is pre-existing — the `unlink` above throws
 * the same way — and the fix belongs in the scheduler's GC call, not here.
 */
export async function removeTriggerDataDir(id: string): Promise<void> {
  if (!isValidTriggerId(id)) return; // malformed id → nothing to delete
  await rm(getTriggerDataPath(id), { recursive: true, force: true });
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

/** Delete a trigger's file and its persistent data directory. No-op if already gone. */
export async function deleteTrigger(id: string): Promise<void> {
  if (!isValidTriggerId(id)) return; // malformed id → nothing to delete
  const path = getTriggerPath(id);
  if (existsSync(path)) {
    await unlink(path);
  }
  // Every deletion entry point — the PM tool, the API route, the pending-trigger
  // GC — funnels through this one function, so putting the directory cleanup
  // here reaches all of them without any caller having to change.
  await removeTriggerDataDir(id);
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
