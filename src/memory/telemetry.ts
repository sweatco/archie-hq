/**
 * Memory Telemetry
 *
 * Shared append-only sensor writer for `memory/tasks/<taskId>/telemetry.jsonl`.
 * Two record kinds share the file:
 *
 * - selection records (`v: 1`, no `kind` field — the original sensor shape;
 *   readers MUST treat kind-less lines as selection records)
 * - pull records (`v: 1, kind: "pull"`) — one per read-tool invocation
 *
 * Both sensors are fail-safe: a write error logs one warning and never
 * affects the spawn or the tool result. Records are single-line appends;
 * readers skip unparseable lines.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getTaskTelemetryPath } from './paths.js';
import { logger } from '../system/logger.js';

/** Discriminator for pull records; selection records carry no `kind` field. */
export const TELEMETRY_KIND_PULL = 'pull';

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
  });
}
