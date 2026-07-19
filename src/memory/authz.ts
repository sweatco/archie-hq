/**
 * Memory Read Authorization
 *
 * Pure decision logic for the memory layer's confidentiality policy:
 *
 * - Extraction gate (`classifyTaskChannels`): whitelist modes — any ext-shared
 *   channel → skip; any unknown (classification failure) → skip; any private /
 *   unstamped / out-of-vocabulary value → skip; any dm → prefs-only (user
 *   preference updates only, no episodic artifacts); else full (`access: org`).
 * - Episodic artifacts (task summaries, knowledge-log grep) are readable
 *   cross-task only when the target's persisted stamp is exactly `access: org`.
 *   DM-derived content is unreachable by construction (prefs-only writes no
 *   artifacts); v1 `access: dm` leftovers are denied like legacy.
 * - Everything fails closed: missing caller context, missing summary, missing
 *   or unrecognized `access:` stamp means self-only access; a locked caller
 *   (ext-shared / unknown-stamped channel) is denied everything.
 *
 * No filesystem access and no imports from paths.ts — callers pass parsed
 * summary text and spawn-derived primitives, which keeps this module trivially
 * unit-testable and the tools' mocks untouched.
 */

import type { ChannelVisibilityClass, TaskAccess } from './types.js';

/** Spawn-derived caller identity, frozen into the tool closure at registration. */
export interface MemoryToolsCtx {
  taskId?: string;
  agent?: string;
  /** Slack user ids of the calling task's message AUTHORS (not body mentions). */
  authorUserIds?: string[];
  /**
   * Memory lockdown flag: any calling-task Slack channel observed ext-shared
   * (stamped visibility or legacy `isShared`) or stamped `unknown`
   * (classification failure — the true class may be ext-shared). Spawn-time
   * snapshot; never un-locks. Handlers re-derive per call via
   * `hasLockedSlackChannel` — a running agent is not re-spawned per message.
   */
  extShared?: boolean;
}

/**
 * Positive lock signal on any Slack channel: `ext-shared`, `unknown`, or
 * legacy `isShared`. Structural param type — this module imports no core types.
 */
export function hasLockedSlackChannel(
  channels: Record<string, { type?: string; visibility?: string; isShared?: boolean }> | null | undefined,
): boolean {
  if (!channels) return false;
  for (const ch of Object.values(channels)) {
    if (ch.type !== 'slack') continue;
    if (ch.visibility === 'ext-shared' || ch.visibility === 'unknown' || ch.isShared === true) return true;
  }
  return false;
}

/** Access grant parsed from a summary.md's frontmatter. */
export interface SummaryAccess {
  /**
   * The persisted `access:` stamp. Only `org` is recognized; anything else —
   * absent, v1 `dm`, unknown values — parses to null (deny non-self).
   */
  access: TaskAccess | null;
}

export type DeniedReason = 'no-access-stamp' | 'ext-shared';

export type EpisodicDecision = { allowed: true } | { allowed: false; reason: DeniedReason };

// Only `org` grants anything; a v1 `access: dm` stamp deliberately does NOT
// match — it denies exactly like a legacy unstamped summary.
const ACCESS_RE = /^access:\s*(org)\s*$/;

function frontmatterLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return out;
    out.push(lines[i]);
  }
  return []; // unterminated frontmatter — treat as absent
}

/**
 * Parse the access grant out of a task summary's frontmatter. Never throws;
 * anything unparseable degrades to `access: null` (deny non-self).
 */
export function parseSummaryAccess(summaryText: string): SummaryAccess {
  for (const line of frontmatterLines(summaryText)) {
    const access = ACCESS_RE.exec(line);
    if (access) return { access: access[1] as TaskAccess };
  }
  return { access: null };
}

/**
 * Decide whether the calling task may read another task's episodic artifacts
 * (summary content, knowledge-log grep). `parsed` is null when the target has
 * no summary on disk. Evaluated in order; everything unknown fails closed.
 */
export function authorizeEpisodicRead(
  caller: MemoryToolsCtx,
  targetTaskId: string,
  parsed: SummaryAccess | null,
): EpisodicDecision {
  // 1. Locked caller (ext-shared / unknown-stamped channel) — denied before
  //    the self rule, so the lockdown is unconditional (backstop; the primary
  //    control is that spawn never registers memory tools for locked tasks).
  if (caller.extShared) return { allowed: false, reason: 'ext-shared' };

  // 2. Self — an agent may always read its own artifacts (it already has
  //    read access to its own shared/knowledge.log via the sandbox mounts).
  if (caller.taskId && caller.taskId === targetTaskId) return { allowed: true };

  // 3. Org-derived artifacts are readable by every agent.
  if (parsed?.access === 'org') return { allowed: true };

  // 4. Everything else — no summary, no stamp, a v1 `access: dm` stamp, an
  //    unrecognized value — denies identically (fail-closed).
  return { allowed: false, reason: 'no-access-stamp' };
}

// ============================================================================
// Extraction gate (push path)
// ============================================================================

/** Minimal structural view of a task channel — matches core's Channel union. */
export interface ChannelLike {
  type: string;
  visibility?: ChannelVisibilityClass;
}

export type ExtractionMode =
  | { mode: 'full'; access: TaskAccess }
  | { mode: 'prefs-only' }
  | { mode: 'skip'; reason: 'ext-shared' | 'unknown' | 'private' };

/**
 * Classify a task's channels into an extraction mode, whitelist-style: only
 * `public` and `dm` are recognized as non-gating, so an out-of-vocabulary or
 * missing visibility value can never widen the gate. Precedence: ext-shared →
 * unknown → private → prefs-only (dm) → full. GitHub/CLI channels are
 * org-contributing (governed by their own ACLs / the host operator). A task
 * with zero channels never ingested human conversation, so it classifies full.
 */
export function classifyTaskChannels(channels: Record<string, ChannelLike>): ExtractionMode {
  let sawUnknown = false;
  let sawPrivate = false;
  let sawDm = false;
  for (const ch of Object.values(channels)) {
    if (ch.type !== 'slack') continue;
    const visibility = ch.visibility ?? 'private';
    if (visibility === 'ext-shared') return { mode: 'skip', reason: 'ext-shared' };
    else if (visibility === 'unknown') sawUnknown = true;
    else if (visibility === 'dm') sawDm = true;
    else if (visibility !== 'public') sawPrivate = true; // 'private' + any out-of-vocab value
  }
  if (sawUnknown) return { mode: 'skip', reason: 'unknown' };
  if (sawPrivate) return { mode: 'skip', reason: 'private' };
  if (sawDm) return { mode: 'prefs-only' };
  return { mode: 'full', access: 'org' };
}
