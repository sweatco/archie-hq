/**
 * Memory Layer Types
 *
 * Self-contained types for the memory subsystem.
 * No imports from core types — keeps the dependency one-way.
 */

/** A single update to a user's collaboration-profile file. */
export interface MemoryUpdate {
  action: 'add' | 'update';
  /** Required collaboration-profile section; validated against the closed allowlist. */
  section?: string;
  /** New content to add */
  content: string;
  /** For 'update': the old line to replace */
  old?: string;
  /** Author-owned source message IDs (`msg:<ts>`) supporting this update. */
  evidence?: string[];
}

/** Extraction result from the Sonnet side-agent */
export interface ExtractionResult {
  /** Collaboration-profile updates keyed by canonical Slack user ID. */
  user_updates: Record<string, MemoryUpdate[]>;
  /** Create/update operations for entity pages (resolved against the index) */
  entity_updates: EntityUpdate[];
  /** Structured task summary markdown */
  task_summary: string;
  /** One-line summary for recent-activity.md */
  activity_summary: string;
  /** Domain tag (engineering, marketing, operations, etc.) */
  domain: string;
}

// ============================================================================
// Entity layer
// ============================================================================

/** Kind of durable subject an entity page represents. People are NOT entities. */
export type EntityType = 'service' | 'system' | 'integration' | 'concept' | 'repo';

/** How broadly an entity is relevant — drives push selection at spawn. */
export type EntityScope = 'org' | 'domain' | 'repo';

/** Entity lifecycle status. Stale entities are archived, never deleted. */
export type EntityStatus = 'active' | 'archived';

/** Closed vocabulary of observation categories (the `[category]` prefix in `## Facts`). */
export type ObservationCategory = 'fact' | 'config' | 'decision' | 'caveat';

/** Closed vocabulary of typed relation edges in `## Relations`. */
export type RelationType =
  | 'depends_on'
  | 'integrates'
  | 'owned_by'
  | 'part_of'
  | 'touched_by'
  | 'related_to';

/** A single typed observation: `- [category] text  <!-- touched: ... -->` */
export interface EntityObservation {
  category: ObservationCategory;
  text: string;
  /** YYYY-MM-DD touched annotation, when present. */
  touched?: string;
}

/** A single typed relation edge: `- <type> [[target]]` */
export interface EntityRelation {
  type: RelationType;
  /** Wikilink target — another entity slug, a user id, or a task id. */
  target: string;
}

/** A parsed entity page (`workdir/memory/entities/<slug>.md`). */
export interface EntityRecord {
  /** Canonical slug — also the filename stem. */
  entity: string;
  type: EntityType;
  displayName: string;
  aliases: string[];
  scope: EntityScope;
  repos: string[];
  /** Domain enum value, or '' when unscoped. */
  domain: string;
  status: EntityStatus;
  /** L0 one-line summary (from the `<!-- L0: ... -->` comment). */
  summary: string;
  observations: EntityObservation[];
  relations: EntityRelation[];
}

/**
 * A create-or-update operation emitted by the extraction side-agent. `slug`
 * either matches an existing entity (by canonical slug or alias) or names a
 * new one. Fields are validated/sanitized before any write; unknown
 * categories/relation types are dropped.
 */
export interface EntityUpdate {
  /** Proposed slug, or an existing slug/alias to resolve against. */
  slug: string;
  /** Required when creating a new entity. */
  type?: string;
  display_name?: string;
  aliases?: string[];
  scope?: string;
  repos?: string[];
  domain?: string;
  /** L0 one-line summary. */
  summary?: string;
  observations?: Array<{ category: string; text: string }>;
  relations?: Array<{ type: string; target: string }>;
}

/** A single row in recent-activity.md */
export interface ActivityEntry {
  date: string;
  taskId: string;
  summary: string;
  domain: string;
  user: string;
}

/** A user reference parsed from a transcript mention or resolved as a fallback. */
export interface UserRef {
  /** Canonical filename identifier (raw Slack ID `U…`/`W…`/`B…`/`T…`, or `cli:<...>` / `local:<...>` fallback). */
  userId: string;
  /** Display name for prompt labels. Defaults to userId when not derivable. */
  displayName: string;
}
