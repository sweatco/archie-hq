/**
 * Memory Paths
 *
 * All path resolution for memory artifacts.
 * Uses WORKDIR from core but owns the memory/ subtree.
 */

import { join } from 'path';
import { WORKDIR } from '../system/workdir.js';

// ---- Feature flags ----

/** Master feature flag: set ARCHIE_MEMORY=false to disable the layer entirely. */
export function isMemoryEnabled(): boolean {
  return process.env.ARCHIE_MEMORY !== 'false';
}

/** Housekeeping flag: set ARCHIE_MEMORY_HOUSEKEEPING=false to disable both auto and manual modes. */
export function isHousekeepingEnabled(): boolean {
  return process.env.ARCHIE_MEMORY_HOUSEKEEPING !== 'false';
}

// ---- Configurable caps ----

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Soft cap on total bullets in each user file before housekeeping triggers. */
export function getUserCap(): number { return envInt('ARCHIE_MEMORY_USER_CAP', 100); }
/** Soft cap on bullets per section in any memory file. */
export function getSectionCap(): number { return envInt('ARCHIE_MEMORY_SECTION_CAP', 30); }
/** Days after which an unrefreshed bullet becomes eligible for housekeeping removal. */
export function getStalenessDays(): number { return envInt('ARCHIE_MEMORY_STALENESS_DAYS', 180); }
/** Soft cap on total entity files before entity housekeeping triggers. */
export function getEntityCap(): number { return envInt('ARCHIE_MEMORY_ENTITY_CAP', 300); }
/** Maximum number of full entity pages injected into a single agent prompt. */
export function getEntityInjectMax(): number { return envInt('ARCHIE_MEMORY_ENTITY_INJECT_MAX', 8); }

// ---- Directory & file paths ----

/** Root memory directory: workdir/memory/ */
export function getMemoryDir(): string {
  return join(WORKDIR, 'memory');
}

/** Users directory: workdir/memory/users/ */
export function getUsersDir(): string {
  return join(getMemoryDir(), 'users');
}

/** Summaries directory: workdir/memory/summaries/ */
export function getSummariesDir(): string {
  return join(getMemoryDir(), 'summaries');
}

/** Per-task summary file: workdir/memory/summaries/<taskId>.md */
export function getSummaryPath(taskId: string): string {
  if (!isAllowedTaskId(taskId)) {
    throw new Error(`getSummaryPath: invalid taskId ${JSON.stringify(taskId)}`);
  }
  return join(getSummariesDir(), `${taskId}.md`);
}

/** Pending-extraction queue file: workdir/memory/pending-extractions.md */
export function getPendingPath(): string {
  return join(getMemoryDir(), 'pending-extractions.md');
}

/** Recent activity index: workdir/memory/recent-activity.md */
export function getRecentActivityPath(): string {
  return join(getMemoryDir(), 'recent-activity.md');
}

/** Entities directory: workdir/memory/entities/ */
export function getEntitiesDir(): string {
  return join(getMemoryDir(), 'entities');
}

/** Derived entity index: workdir/memory/entities/index.md */
export function getEntityIndexPath(): string {
  return join(getEntitiesDir(), 'index.md');
}

/**
 * Per-entity file: workdir/memory/entities/<slug>.md.
 *
 * `slug` MUST be a valid entity slug (see `isValidEntitySlug`). Throws on any
 * other input — entity slugs originate from untrusted transcripts and become
 * filenames, so this guard is the hard boundary. Use `sanitizeEntitySlug`
 * (sanitize.ts) as the normalizing front door before reaching here.
 */
export function getEntityPath(slug: string): string {
  if (!isValidEntitySlug(slug)) {
    throw new Error(`getEntityPath: invalid entity slug ${JSON.stringify(slug)}`);
  }
  return join(getEntitiesDir(), `${slug}.md`);
}

// ---- User identifier validation ----

const SLACK_ID_RE = /^(U|W|B|T)[A-Z0-9]{6,}$/;
const FALLBACK_ID_RE = /^(cli|local):[A-Za-z0-9_\-]+$/;
const TASK_ID_RE = /^[A-Za-z0-9._\-]+$/;

/** True if `id` is a raw Slack user identifier (`U…`/`W…`/`B…`/`T…`). */
export function isSlackUserId(id: string): boolean {
  return SLACK_ID_RE.test(id);
}

/** True if `id` is a documented non-Slack fallback identifier (`cli:…` / `local:…`). */
export function isFallbackUserId(id: string): boolean {
  return FALLBACK_ID_RE.test(id);
}

/** True if `id` is either a Slack ID or a fallback identifier — accepted as a user-memory filename. */
export function isAllowedUserId(id: string): boolean {
  return isSlackUserId(id) || isFallbackUserId(id);
}

/** True if `taskId` is safe to embed in a filename. */
export function isAllowedTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

// ---- Entity slug validation ----

const ENTITY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Names that would collide with non-entity files in entities/ or are otherwise unsafe.
const RESERVED_ENTITY_SLUGS = new Set(['index']);

/**
 * True if `slug` is safe to use as an entity filename stem: lowercase
 * alphanumerics and single hyphens only, length-bounded, no path separators,
 * no `.` segments, and not a reserved name. This is the hard validator; the
 * normalizing front door is `sanitizeEntitySlug` in sanitize.ts.
 */
export function isValidEntitySlug(slug: string): boolean {
  return typeof slug === 'string' && ENTITY_SLUG_RE.test(slug) && !RESERVED_ENTITY_SLUGS.has(slug);
}

/**
 * Per-user file: workdir/memory/users/<id>.md.
 *
 * `id` MUST be either a raw Slack user identifier (`U…`/`W…`/`B…`/`T…`)
 * or a fallback identifier (`cli:<sessionId>`, `local:<osUser>`).
 * Throws on any other input.
 */
export function getUserPath(id: string): string {
  if (!isAllowedUserId(id)) {
    throw new Error(`getUserPath: invalid user identifier ${JSON.stringify(id)} — must be Slack ID or cli:/local: fallback`);
  }
  // On case-insensitive filesystems the colon in fallback IDs could clash;
  // normalise `:` to `__` for the fallback namespace only.
  const safe = id.includes(':') ? id.replace(':', '__') : id;
  return join(getUsersDir(), `${safe}.md`);
}

// ---- Legacy (kept for callers that need to remove old session-dir summaries) ----

/**
 * @deprecated Use `getSummaryPath` (memory dir) instead. Retained only so callers
 * can locate and clean up legacy summaries written under sessions/<taskId>/shared/.
 */
export function getTaskSummaryPath(taskId: string): string {
  return join(WORKDIR, 'sessions', taskId, 'shared', 'summary.md');
}
