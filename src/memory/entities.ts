/**
 * Entity Store
 *
 * Read/write/parse for first-class entity pages at
 * `workdir/memory/entities/<slug>.md`. An entity is a durable subject the
 * org's work touches (service, system, integration, concept, repo). People are
 * NOT entities — they live in `users/<id>.md` and are referenced by `[[id]]`.
 *
 * File shape:
 *
 *   ---
 *   entity: payment-service
 *   type: service
 *   display_name: "Payment Service"
 *   aliases: [payments-api]
 *   scope: repo
 *   repos: [backend]
 *   domain: engineering
 *   status: active
 *   ---
 *   <!-- L0: NestJS payments API, Stripe + postgres-prod -->
 *
 *   ## Facts
 *   - [decision] chose idempotency keys  <!-- touched: 2026-06-01 -->
 *
 *   ## Relations
 *   - depends_on [[postgres-prod]]
 *   - touched_by [[task-123]]
 *
 * All model-derived input passes through sanitize.ts before it reaches here.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import {
  getEntityPath,
  getEntitiesDir,
  getEntityCap,
  isValidEntitySlug,
} from './paths.js';
import {
  sanitizeEntitySlug,
  sanitizeEntityDisplayName,
  sanitizeEntitySummary,
  sanitizeEntityObservation,
  sanitizeEntityRelation,
  isAllowedEntityType,
  isAllowedEntityScope,
  isAllowedDomain,
} from './sanitize.js';
import { logger } from '../system/logger.js';
import type {
  EntityRecord,
  EntityObservation,
  EntityRelation,
  EntityScope,
  EntityType,
  EntityUpdate,
} from './types.js';

const REPO_TOKEN_RE = /^[A-Za-z0-9._\-]{1,64}$/;

// ============================================================================
// Parse / serialize
// ============================================================================

/** Parse an entity file's content into a record, or null when malformed. */
export function parseEntity(content: string): EntityRecord | null {
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const entity = fm.values.entity;
  if (!entity || !isValidEntitySlug(entity)) return null;

  const type = (fm.values.type ?? '') as EntityType;
  const scope = (fm.values.scope ?? 'org') as EntityScope;
  const body = fm.body;

  return {
    entity,
    type: isAllowedEntityType(type) ? type : 'concept',
    displayName: fm.values.display_name || entity,
    aliases: parseInlineList(fm.rawValues.aliases),
    scope: isAllowedEntityScope(scope) ? scope : 'org',
    repos: parseInlineList(fm.rawValues.repos),
    domain: fm.values.domain && isAllowedDomain(fm.values.domain) ? fm.values.domain : '',
    status: fm.values.status === 'archived' ? 'archived' : 'active',
    summary: parseL0(body),
    observations: parseObservations(body),
    relations: parseRelations(body),
  };
}

/** Serialize a record back to Markdown. Deterministic key/section order. */
export function serializeEntity(record: EntityRecord): string {
  const lines: string[] = ['---'];
  lines.push(`entity: ${record.entity}`);
  lines.push(`type: ${record.type}`);
  lines.push(`display_name: "${record.displayName.replace(/"/g, '\\"')}"`);
  lines.push(`aliases: ${serializeInlineList(record.aliases)}`);
  lines.push(`scope: ${record.scope}`);
  lines.push(`repos: ${serializeInlineList(record.repos)}`);
  lines.push(`domain: ${record.domain}`);
  lines.push(`status: ${record.status}`);
  lines.push('---');
  if (record.summary) lines.push(`<!-- L0: ${record.summary} -->`);
  lines.push('');
  lines.push('## Facts');
  for (const o of record.observations) {
    const touched = o.touched ? `  <!-- touched: ${o.touched} -->` : '';
    lines.push(`- [${o.category}] ${o.text}${touched}`);
  }
  lines.push('');
  lines.push('## Relations');
  for (const r of record.relations) {
    lines.push(`- ${r.type} [[${r.target}]]`);
  }
  return lines.join('\n') + '\n';
}

// ============================================================================
// Read / write / list
// ============================================================================

/** Read + parse a single entity by slug. Returns null when absent or malformed. */
export async function readEntity(slug: string): Promise<EntityRecord | null> {
  if (!isValidEntitySlug(slug)) return null;
  let content: string;
  try {
    content = await readFile(getEntityPath(slug), 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return parseEntity(content);
}

/** Write an entity record to its file, creating entities/ if needed. */
export async function writeEntity(record: EntityRecord): Promise<void> {
  const path = getEntityPath(record.entity);
  await mkdir(getEntitiesDir(), { recursive: true });
  await writeFile(path, serializeEntity(record), 'utf-8');
}

/** Read + parse every entity file (excluding the derived index). */
export async function listEntities(): Promise<EntityRecord[]> {
  const dir = getEntitiesDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: EntityRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const stem = name.slice(0, -3);
    if (!isValidEntitySlug(stem)) continue; // skips index.md and junk
    const rec = await readEntity(stem);
    if (rec) records.push(rec);
  }
  return records;
}

/** Count entity files (excluding the index). */
export async function entityCount(): Promise<number> {
  return (await listEntities()).length;
}

/**
 * Resolve a slug-or-alias against a set of records (case-insensitive on
 * aliases). Used by extraction to fold updates into an existing entity
 * instead of creating a duplicate.
 */
export function resolveEntity(key: string, records: EntityRecord[]): EntityRecord | null {
  if (typeof key !== 'string' || !key.trim()) return null;
  const lower = key.trim().toLowerCase();
  const sanitized = sanitizeEntitySlug(key);
  for (const r of records) {
    if (r.entity === lower || r.entity === sanitized) return r;
    if (r.aliases.some((a) => a.toLowerCase() === lower)) return r;
  }
  return null;
}

// ============================================================================
// applyEntityUpdate
// ============================================================================

export interface AppliedEntity {
  slug: string;
  created: boolean;
  capExceeded: boolean;
}

/**
 * Apply one extraction-emitted entity update: resolve against existing
 * entities (by slug or alias) or create a new one, merge sanitized
 * observations/relations/aliases, and always add a `touched_by [[taskId]]`
 * edge. Returns null when the update can't be applied (e.g. unresolvable
 * slug on a create, or no valid type).
 */
export async function applyEntityUpdate(
  update: EntityUpdate,
  taskId: string,
  today?: string,
): Promise<AppliedEntity | null> {
  if (!update || typeof update.slug !== 'string') return null;
  const date = today ?? new Date().toISOString().slice(0, 10);

  const all = await listEntities();
  const proposedSlug = sanitizeEntitySlug(update.slug);
  let record = (proposedSlug && resolveEntity(proposedSlug, all)) || resolveEntity(update.slug, all);
  let created = false;

  if (!record) {
    if (!proposedSlug) {
      logger.warn('memory', `applyEntityUpdate: dropped — unusable slug ${JSON.stringify(update.slug)}`);
      return null;
    }
    const type = typeof update.type === 'string' ? update.type.toLowerCase().trim() : '';
    if (!isAllowedEntityType(type)) {
      logger.warn('memory', `applyEntityUpdate: dropped new entity "${proposedSlug}" — missing/invalid type`);
      return null;
    }
    const cleanRepos = cleanRepoList(update.repos);
    const scope = pickScope(update.scope, cleanRepos);
    record = {
      entity: proposedSlug,
      type: type as EntityType,
      displayName: sanitizeEntityDisplayName(update.display_name) ?? proposedSlug,
      aliases: [],
      scope,
      repos: cleanRepos,
      domain: pickDomain(update.domain),
      status: 'active',
      summary: '',
      observations: [],
      relations: [],
    };
    created = true;
  } else {
    // Merge scalar fields into the existing record when provided + valid.
    const dn = sanitizeEntityDisplayName(update.display_name);
    if (dn) record.displayName = dn;
    if (typeof update.scope === 'string' && isAllowedEntityScope(update.scope.toLowerCase().trim())) {
      record.scope = update.scope.toLowerCase().trim() as EntityScope;
    }
    const domain = pickDomain(update.domain);
    if (domain) record.domain = domain;
    record.repos = dedupe([...record.repos, ...cleanRepoList(update.repos)]);
  }

  // L0 summary
  const summary = sanitizeEntitySummary(update.summary);
  if (summary) record.summary = summary;

  // Aliases (never equal to the canonical slug)
  if (Array.isArray(update.aliases)) {
    for (const a of update.aliases) {
      const alias = typeof a === 'string' ? a.replace(/\s+/g, ' ').trim() : '';
      if (alias && alias.toLowerCase() !== record.entity && alias.length <= 80) {
        if (!record.aliases.some((x) => x.toLowerCase() === alias.toLowerCase())) record.aliases.push(alias);
      }
    }
  }

  // Observations — append sanitized, dedupe by (category, normalized text), stamp touched.
  if (Array.isArray(update.observations)) {
    for (const o of update.observations) {
      const clean = sanitizeEntityObservation(o);
      if (!clean) continue;
      if (hasObservation(record.observations, clean)) continue;
      record.observations.push({ ...clean, touched: date });
    }
  }

  // Relations — add sanitized, dedupe by (type, target).
  if (Array.isArray(update.relations)) {
    for (const r of update.relations) {
      const clean = sanitizeEntityRelation(r);
      if (!clean) continue;
      addRelation(record.relations, clean);
    }
  }

  // Auto touched_by edge for provenance + the related-tasks signal.
  addRelation(record.relations, { type: 'touched_by', target: taskId });

  await writeEntity(record);

  const count = created ? all.length + 1 : all.length;
  return { slug: record.entity, created, capExceeded: count > getEntityCap() };
}

// ============================================================================
// Helpers
// ============================================================================

function pickScope(raw: string | undefined, repos: string[]): EntityScope {
  if (typeof raw === 'string' && isAllowedEntityScope(raw.toLowerCase().trim())) {
    return raw.toLowerCase().trim() as EntityScope;
  }
  return repos.length > 0 ? 'repo' : 'org';
}

function pickDomain(raw: string | undefined): string {
  if (typeof raw === 'string' && isAllowedDomain(raw.toLowerCase().trim())) return raw.toLowerCase().trim();
  return '';
}

function cleanRepoList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r === 'string' && REPO_TOKEN_RE.test(r.trim())) out.push(r.trim());
  }
  return dedupe(out);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

function hasObservation(list: EntityObservation[], o: EntityObservation): boolean {
  const norm = o.text.toLowerCase().replace(/\s+/g, ' ').trim();
  return list.some((x) => x.category === o.category && x.text.toLowerCase().replace(/\s+/g, ' ').trim() === norm);
}

/** Add a relation if (type, target) is not already present. */
export function addRelation(list: EntityRelation[], rel: EntityRelation): void {
  if (list.some((x) => x.type === rel.type && x.target.toLowerCase() === rel.target.toLowerCase())) return;
  list.push(rel);
}

// ---- Frontmatter / body parsing ----

interface Frontmatter {
  values: Record<string, string>;
  rawValues: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const values: Record<string, string> = {};
  const rawValues: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      i++;
      break;
    }
    const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    rawValues[key] = raw;
    values[key] = unquote(raw);
  }
  return { values, rawValues, body: lines.slice(i).join('\n') };
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function parseInlineList(raw: string | undefined): string[] {
  if (!raw) return [];
  const m = /^\[(.*)\]$/.exec(raw.trim());
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

function serializeInlineList(items: string[]): string {
  return `[${items.join(', ')}]`;
}

function parseL0(body: string): string {
  const m = /<!--\s*L0:\s*([\s\S]*?)\s*-->/.exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function parseObservations(body: string): EntityObservation[] {
  const out: EntityObservation[] = [];
  const section = extractSection(body, 'Facts');
  for (const line of section) {
    const m = /^-\s*\[([a-z]+)\]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const category = m[1];
    const touchedM = /<!--\s*touched:\s*(\d{4}-\d{2}-\d{2})\s*-->/.exec(m[2]);
    const text = m[2].replace(/<!--\s*touched:\s*\d{4}-\d{2}-\d{2}\s*-->/, '').trim();
    if (!text) continue;
    out.push({
      category: category as EntityObservation['category'],
      text,
      ...(touchedM ? { touched: touchedM[1] } : {}),
    });
  }
  return out;
}

function parseRelations(body: string): EntityRelation[] {
  const out: EntityRelation[] = [];
  const section = extractSection(body, 'Relations');
  for (const line of section) {
    const m = /^-\s*([a-z_]+)\s*\[\[([^\]]+)\]\]\s*$/.exec(line);
    if (!m) continue;
    out.push({ type: m[1] as EntityRelation['type'], target: m[2].trim() });
  }
  return out;
}

/** Return the lines belonging to a `## <name>` section (until the next `## `). */
function extractSection(body: string, name: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header && !line.startsWith('### ')) {
      inSection = header[1] === name;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}
