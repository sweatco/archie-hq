/**
 * Memory Telemetry
 *
 * Shared append-only sensor writer for `memory/tasks/<taskId>/telemetry.jsonl`.
 * Record kinds sharing the file:
 *
 * - selection records (`v: 1`, no `kind` field — the original sensor shape;
 *   readers MUST treat kind-less lines as selection records)
 * - pull records (`v: 1, kind: "pull"`) — one per read-tool invocation;
 *   authorization denials carry `denied: true` + `denyReason`
 * - extraction-skip records (`v: 1, kind: "extraction-skip"`) — one per task
 *   the confidentiality gate excluded from extraction, so memory loss from the
 *   policy stays measurable
 * - extraction-prefs-only records (`v: 1, kind: "extraction-prefs-only"`) —
 *   one per DM-carrying task extracted in prefs-only mode
 * - user-update-dropped records (`v: 1, kind: "user-update-dropped"`) — one
 *   per user update rejected by evidence validation
 *
 * All sensors are fail-safe: a write error logs one warning and never
 * affects the spawn or the tool result. Records are single-line appends;
 * readers skip unparseable lines.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getTaskTelemetryPath } from './paths.js';
import { logger } from '../system/logger.js';

/** Discriminator for pull records; selection records carry no `kind` field. */
export const TELEMETRY_KIND_PULL = 'pull';

/** Discriminator for extraction-skip records (confidentiality gate). */
export const TELEMETRY_KIND_EXTRACTION_SKIP = 'extraction-skip';

/** Discriminator for prefs-only extraction records (DM write lockdown). */
export const TELEMETRY_KIND_EXTRACTION_PREFS_ONLY = 'extraction-prefs-only';

/** Discriminator for user updates dropped by evidence validation. */
export const TELEMETRY_KIND_USER_UPDATE_DROPPED = 'user-update-dropped';

/**
 * Append one JSON record to the task's telemetry file, creating the task
 * directory when absent. Fail-safe: never throws — on any error (including an
 * invalid taskId) it logs a warning and returns.
 */
export async function appendTelemetry(taskId: string, record: Record<string, unknown>): Promise<void> {
  try {
    const path = getTaskTelemetryPath(taskId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err: any) {
    logger.warn('memory', `telemetry write failed (caller unaffected): ${err?.message ?? err}`);
  }
}

/** Result summary carried on a pull record. */
export interface PullRecordResult {
  /** Identifiers returned to the agent (entity slugs, task IDs, file ids). */
  returned: string[];
  /** Total result count (may exceed `returned.length` if truncated). */
  count: number;
  /** True when the call produced no results — a measured store gap for search. */
  zeroResult: boolean;
  /** Set when the call was refused by the authorization policy. */
  denied?: string;
}

/**
 * Pull sensor: record one read-tool invocation. Skips silently without a
 * taskId (the tool result is still served). Args are recorded as passed —
 * they are agent-authored queries, not secrets.
 */
export async function recordPull(
  taskId: string | undefined,
  agent: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  result: PullRecordResult,
): Promise<void> {
  if (!taskId) return;
  await appendTelemetry(taskId, {
    v: 1,
    kind: TELEMETRY_KIND_PULL,
    ts: new Date().toISOString(),
    taskId,
    agent: agent ?? null,
    tool: toolName,
    args,
    returned: result.returned,
    resultCount: result.count,
    zeroResult: result.zeroResult,
    ...(result.denied ? { denied: true, denyReason: result.denied } : {}),
  });
}

/**
 * Extraction-gate sensor: record that a completed task was excluded from
 * memory extraction by the confidentiality policy (private / ext-shared /
 * unknown channel). One line per skipped completion; keeps the policy's
 * memory loss measurable in `memory:eval` reports. `retracted` marks a
 * downgraded re-completion that removed a prior completion's artifacts.
 */
export async function recordExtractionSkip(taskId: string, reason: string, retracted = false): Promise<void> {
  await appendTelemetry(taskId, {
    v: 1,
    kind: TELEMETRY_KIND_EXTRACTION_SKIP,
    ts: new Date().toISOString(),
    taskId,
    reason,
    ...(retracted ? { retracted: true } : {}),
  });
}

/**
 * DM write-lockdown sensor: record that a completed task extracted in
 * prefs-only mode (user preference updates applied; no episodic artifacts).
 * `retracted` marks a downgraded re-completion that removed a prior
 * completion's artifacts.
 */
export async function recordExtractionPrefsOnly(taskId: string, retracted = false): Promise<void> {
  await appendTelemetry(taskId, {
    v: 1,
    kind: TELEMETRY_KIND_EXTRACTION_PREFS_ONLY,
    ts: new Date().toISOString(),
    taskId,
    ...(retracted ? { retracted: true } : {}),
  });
}

/**
 * Ownership-enforcement sensor: record a user update dropped by evidence
 * validation (missing/unresolvable citations, or a cited line authored by
 * someone other than the target user). Keeps misattribution drops measurable.
 */
export async function recordUserUpdateDropped(
  taskId: string,
  targetUser: string,
  citedIds: string[],
): Promise<void> {
  await appendTelemetry(taskId, {
    v: 1,
    kind: TELEMETRY_KIND_USER_UPDATE_DROPPED,
    ts: new Date().toISOString(),
    taskId,
    targetUser,
    citedIds,
  });
}
