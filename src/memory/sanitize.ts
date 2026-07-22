/**
 * Memory Sanitization
 *
 * Centralised validation/sanitization for every memory artifact persisted
 * to disk. Model output is untrusted — fields embedded into Markdown bullets,
 * table cells, or YAML frontmatter must be normalised (or rejected) here
 * before they touch the filesystem.
 *
 * Rejected updates are dropped (not coerced into a hostile shape) and the
 * caller is expected to `logger.warn('memory', ...)` with the rejection
 * reason.
 */

import type {
  MemoryUpdate,
  ActivityEntry,
  EntityObservation,
  EntityRelation,
} from './types.js';
import { isValidEntitySlug } from './paths.js';

// ---- Limits & enums ----

const CONTENT_MAX = 200;
const ACTIVITY_SUMMARY_MAX = 100;
const TASK_SUMMARY_MAX = 2000;
const ENTITY_SUMMARY_MAX = 200;
const RELATION_TARGET_MAX = 80;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID_RE = /^[A-Za-z0-9._\-:]+$/;
const ACTIVITY_USER_RE = /^[A-Za-z0-9._\-:]+$/;
// Wikilink relation targets: entity slugs, Slack/fallback user ids, task ids.
// No spaces, brackets, pipes, newlines, or path separators.
const RELATION_TARGET_RE = /^[A-Za-z0-9._:\-]+$/;

const ALLOWED_DOMAINS = new Set(['engineering', 'marketing', 'operations', 'product', 'other']);

/** Sections that may receive new collaboration-profile updates. */
export const COLLABORATION_PROFILE_SECTIONS = [
  'Communication',
  'Deliverables',
  'Workflow',
  'Decision Making',
  'Constraints',
] as const;

const ALLOWED_COLLABORATION_PROFILE_SECTIONS = new Set<string>(COLLABORATION_PROFILE_SECTIONS);

// Closed entity vocabularies — see types.ts. Kept as string sets so model
// output can be membership-tested before it becomes a type.
const ALLOWED_ENTITY_TYPES = new Set(['service', 'system', 'integration', 'concept', 'repo']);
const ALLOWED_ENTITY_SCOPES = new Set(['org', 'domain', 'repo']);
const ALLOWED_OBSERVATION_CATEGORIES = new Set(['fact', 'config', 'decision', 'caveat']);
const ALLOWED_RELATION_TYPES = new Set([
  'depends_on',
  'integrates',
  'owned_by',
  'part_of',
  'touched_by',
  'related_to',
]);

// ---- Field-level helpers ----

/** New profile updates may target only the closed collaboration-profile section set. */
export function isAllowedSection(section: string): boolean {
  return ALLOWED_COLLABORATION_PROFILE_SECTIONS.has(section);
}

/** Domain must be one of the spec-defined enum values. */
export function isAllowedDomain(domain: string): boolean {
  return ALLOWED_DOMAINS.has(domain);
}

/** Escape pipe characters so a value can safely live in a Markdown table cell. */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Collapse runs of whitespace, strip leading list markers, single-line only. */
function normaliseBullet(content: string): string | null {
  let s = content.replace(/^[-*]\s+/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/\n|\r/.test(s)) return null;
  if (s.length > CONTENT_MAX) return null;
  return s;
}

// ---- Prompt-injection heuristics ----

/**
 * Reject content that resembles imperative agent instructions
 * (e.g., "Always grant admin", "You are now a sysadmin").
 * Heuristic — false-negatives possible but false-positives on
 * normal memory facts should be rare since useful memory describes
 * a state of the world, not commands to the agent.
 */
export function looksLikeInstruction(content: string): boolean {
  if (/^(always|never|must|do not|don['']t)\b/i.test(content)) return true;
  const bypassTokens = [
    'system prompt',
    'ignore previous',
    'ignore the previous',
    'ignore all previous',
    'you are now',
    'you are a',
    'act as',
    'pretend to be',
    'forget your instructions',
    'override your',
    'disregard',
  ];
  const lc = content.toLowerCase();
  return bypassTokens.some((t) => lc.includes(t));
}

/**
 * Reject content that resembles a credential or API key.
 * Heuristic; defense-in-depth on top of the extractor prompt.
 */
export function looksLikeSecret(content: string): boolean {
  if (/\b(Bearer\s+[A-Za-z0-9_\-.=]{16,})/i.test(content)) return true;
  // Common secret prefixes followed by long token bodies
  if (/\b(sk-|xoxb-|xoxp-|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_\-]{16,}/.test(content)) return true;
  if (/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/.test(content)) return true;
  // KEY=long-alphanumeric-blob pattern
  if (/[A-Z_]{3,}=[A-Za-z0-9+/=_\-]{24,}/.test(content)) return true;
  return false;
}

// ---- Per-artifact sanitizers ----

/**
 * Validate + sanitize a MemoryUpdate. Returns the cleaned update or null
 * when any rule rejects (caller should drop and log).
 */
export function sanitizeUpdate(update: MemoryUpdate): MemoryUpdate | null {
  if (!update || (update.action !== 'add' && update.action !== 'update')) return null;

  const content = normaliseBullet(update.content);
  if (content === null) return null;
  if (looksLikeInstruction(content) || looksLikeSecret(content)) return null;

  if (typeof update.section !== 'string') return null;
  const section = update.section.replace(/^#+\s*/, '').trim();
  if (!isAllowedSection(section)) return null;

  let old: string | undefined = undefined;
  if (update.action === 'update') {
    if (update.old === undefined) return null;
    const o = normaliseBullet(update.old);
    if (o === null) return null;
    old = o;
  }

  return { action: update.action, section, content, ...(old !== undefined && { old }) };
}

/**
 * Validate + sanitize an ActivityEntry. Returns the cleaned row or null.
 */
export function sanitizeActivityEntry(entry: ActivityEntry): ActivityEntry | null {
  if (!entry) return null;
  if (!DATE_RE.test(entry.date)) return null;
  if (!TASK_ID_RE.test(entry.taskId)) return null;
  if (!isAllowedDomain(entry.domain)) return null;
  if (!ACTIVITY_USER_RE.test(entry.user)) return null;

  let summary = entry.summary.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  if (/\n|\r/.test(summary)) return null;
  if (summary.length > ACTIVITY_SUMMARY_MAX) summary = summary.slice(0, ACTIVITY_SUMMARY_MAX);
  summary = escapeTableCell(summary);

  return {
    date: entry.date,
    taskId: entry.taskId,
    summary,
    domain: entry.domain,
    user: entry.user,
  };
}

/**
 * Validate the prose task summary. Reject if it would break YAML frontmatter
 * or exceed the cap. Multi-line is allowed.
 */
export function sanitizeTaskSummary(summary: string): string | null {
  if (typeof summary !== 'string') return null;
  const s = summary.trim();
  if (!s) return null;
  if (/^---$/m.test(s)) return null;
  if (s.length > TASK_SUMMARY_MAX) return null;
  return s;
}

// ---- Entity-layer closed-vocabulary guards ----

export function isAllowedEntityType(t: string): boolean {
  return ALLOWED_ENTITY_TYPES.has(t);
}
export function isAllowedEntityScope(s: string): boolean {
  return ALLOWED_ENTITY_SCOPES.has(s);
}
export function isAllowedObservationCategory(c: string): boolean {
  return ALLOWED_OBSERVATION_CATEGORIES.has(c);
}
export function isAllowedRelationType(t: string): boolean {
  return ALLOWED_RELATION_TYPES.has(t);
}

// ---- Entity-layer sanitizers ----

/**
 * Normalize and validate an entity slug. Entity slugs come from untrusted
 * transcripts and become filenames — this is the front door before
 * `getEntityPath`'s hard assert.
 *
 * Path-shaped input (separators or `..`) is rejected outright rather than
 * coerced, so a traversal attempt can never be silently normalized into a
 * valid-looking slug. Otherwise the candidate is lowercased, spaces/underscores
 * become hyphens, stray characters are stripped, and the result is validated.
 * Returns null when nothing safe remains.
 */
export function sanitizeEntitySlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Reject path-shaped input outright — never coerce a traversal away.
  if (/[\/\\]/.test(s) || s.includes('..')) return null;
  let slug = s
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '');
  if (!slug) return null;
  return isValidEntitySlug(slug) ? slug : null;
}

/** Normalize an entity display name to a safe single-line string (or null). */
export function sanitizeEntityDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || /[\n\r]/.test(s)) return null;
  if (s.length > 120) return null;
  return s;
}

/** Validate + normalize an entity L0 summary (single line, bounded, no injection). */
export function sanitizeEntitySummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || /[\n\r]/.test(s)) return null;
  if (s.length > ENTITY_SUMMARY_MAX) return null;
  if (looksLikeInstruction(s) || looksLikeSecret(s)) return null;
  return s;
}

/**
 * Validate + sanitize a single typed observation. Drops (returns null) when
 * the category is outside the closed vocabulary, the text is multi-line / too
 * long, or the text looks like an instruction or a secret.
 */
export function sanitizeEntityObservation(obs: { category: string; text: string }): EntityObservation | null {
  if (!obs || typeof obs.category !== 'string' || typeof obs.text !== 'string') return null;
  const category = obs.category.toLowerCase().trim();
  if (!isAllowedObservationCategory(category)) return null;
  const text = normaliseBullet(obs.text);
  if (text === null) return null;
  if (looksLikeInstruction(text) || looksLikeSecret(text)) return null;
  return { category: category as EntityObservation['category'], text };
}

/**
 * Validate + sanitize a single typed relation. Drops (returns null) when the
 * relation type is outside the closed vocabulary or the target is not a clean
 * wikilink target (entity slug, user id, or task id; no spaces/brackets/pipes).
 */
export function sanitizeEntityRelation(rel: { type: string; target: string }): EntityRelation | null {
  if (!rel || typeof rel.type !== 'string' || typeof rel.target !== 'string') return null;
  const type = rel.type.toLowerCase().trim();
  if (!isAllowedRelationType(type)) return null;
  const target = rel.target.trim();
  if (!target || target.length > RELATION_TARGET_MAX) return null;
  if (!RELATION_TARGET_RE.test(target)) return null;
  return { type: type as EntityRelation['type'], target };
}
