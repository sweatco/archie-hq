/**
 * Memory Paths
 *
 * All path resolution for memory artifacts.
 * Uses WORKDIR from core but owns the memory/ subtree.
 */

import { join, resolve, sep } from 'path';
import { WORKDIR } from '../system/workdir.js';
import { logger } from '../system/logger.js';

// ---- Feature flags ----

/** Master feature flag: set ARCHIE_MEMORY=false to disable the layer entirely. */
export function isMemoryEnabled(): boolean {
  return process.env.ARCHIE_MEMORY !== 'false';
}

/** Housekeeping flag: set ARCHIE_MEMORY_HOUSEKEEPING=false to disable both auto and manual modes. */
export function isHousekeepingEnabled(): boolean {
  return process.env.ARCHIE_MEMORY_HOUSEKEEPING !== 'false';
}

/**
 * Injection flag: gates ONLY the read path (stored memory → agent prompt),
 * independent of extraction. Defaults OFF — set ARCHIE_MEMORY_INJECT=true to
 * inject memory into prompts. This deliberately inverts the default-enabled
 * convention of the other flags so the safe, collect-only posture (facts keep
 * accumulating for evaluation, but never reach prompts) needs no configuration.
 * The master flag still wins: when ARCHIE_MEMORY=false, injection is off
 * regardless of this value. Extraction/storage/housekeeping ignore it.
 */
export function isInjectionEnabled(): boolean {
  return process.env.ARCHIE_MEMORY_INJECT === 'true';
}

/**
 * Memory read-tools flag: gates the agent-callable pull path (search_memory /
 * read_entity / read_task_summary), independent of injection.
 * Defaults OFF like ARCHIE_MEMORY_INJECT — set ARCHIE_MEMORY_TOOLS=true to
 * register the tools. The master flag still wins: when ARCHIE_MEMORY=false the
 * tools are off regardless of this value.
 */
export function isMemoryToolsEnabled(): boolean {
  return isMemoryEnabled() && process.env.ARCHIE_MEMORY_TOOLS === 'true';
}

// ---- Configurable caps ----

/** Parse an integer env flag, warning and falling back when invalid. */
function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= min) return n;
  logger.warn('memory', `${name}: ignoring invalid value ${JSON.stringify(raw)} (expected integer >= ${min}); using ${fallback}`);
  return fallback;
}

/** Soft cap on total bullets in each collaboration-profile file before housekeeping triggers. */
export function getUserCap(): number { return envInt('ARCHIE_MEMORY_USER_CAP', 100); }
/** Soft cap on bullets per section in any memory file. */
export function getSectionCap(): number { return envInt('ARCHIE_MEMORY_SECTION_CAP', 30); }
/** Days after which an unrefreshed bullet becomes eligible for housekeeping removal. */
export function getStalenessDays(): number { return envInt('ARCHIE_MEMORY_STALENESS_DAYS', 180); }
/** Soft cap on total entity files before entity housekeeping triggers. */
export function getEntityCap(): number { return envInt('ARCHIE_MEMORY_ENTITY_CAP', 300); }
/** Max full non-`org` entity pages per prompt (`0` → index-only). */
export function getEntityInjectMax(): number { return envInt('ARCHIE_MEMORY_ENTITY_INJECT_MAX', 8, 0); }
/** Maximum number of full `scope: org` entity pages injected into a single agent prompt (org is no longer unbounded; the thin index still lists every entity). */
export function getOrgInjectMax(): number { return envInt('ARCHIE_MEMORY_ORG_INJECT_MAX', 8, 0); }
/** Soft cap on observations kept on a single entity page; on write the newest-touched are retained and the oldest surplus dropped. */
export function getEntityObsCap(): number { return envInt('ARCHIE_MEMORY_ENTITY_OBS_CAP', 30); }
/** Max `touched_by` relations rendered into an injected entity block (newest kept; `0` → none); the stored page keeps full history. */
export function getTouchedByInjectMax(): number { return envInt('ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX', 10, 0); }

// ---- Directory & file paths ----

/** Root memory directory: workdir/memory/ */
export function getMemoryDir(): string {
  return join(WORKDIR, 'memory');
}

/** Users directory: workdir/memory/users/ */
export function getUsersDir(): string {
  return join(getMemoryDir(), 'users');
}

/** Per-task artifacts root: workdir/memory/tasks/ (episodic memory — summaries + telemetry). */
export function getTasksDir(): string {
  return join(getMemoryDir(), 'tasks');
}

/**
 * Per-task artifact directory: workdir/memory/tasks/<taskId>/. The taskId is a
 * directory segment here, so pure-dot names are rejected on top of the shared
 * guard — `isAllowedTaskId` accepts dots, and `.`/`..` would escape the tree.
 */
export function getTaskDir(taskId: string): string {
  if (!isAllowedTaskId(taskId) || /^\.+$/.test(taskId)) {
    throw new Error(`getTaskDir: invalid taskId ${JSON.stringify(taskId)}`);
  }
  // resolve+startsWith containment — the boundary shape static analysis
  // recognizes (js/path-injection); holds even if the regex regresses.
  const root = resolve(getTasksDir());
  const dir = resolve(root, taskId);
  if (!dir.startsWith(root + sep)) {
    throw new Error(`getTaskDir: taskId escapes the tasks root ${JSON.stringify(taskId)}`);
  }
  return dir;
}

/** Per-task summary file: workdir/memory/tasks/<taskId>/summary.md */
export function getSummaryPath(taskId: string): string {
  return join(getTaskDir(taskId), 'summary.md');
}

/** Per-task selection-sensor log: workdir/memory/tasks/<taskId>/telemetry.jsonl */
export function getTaskTelemetryPath(taskId: string): string {
  return join(getTaskDir(taskId), 'telemetry.jsonl');
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

/** True if `id` is either a Slack ID or a legacy fallback identifier accepted as a profile filename. */
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
 * Per-user collaboration-profile file: workdir/memory/users/<id>.md.
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
