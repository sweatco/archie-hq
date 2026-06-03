/**
 * Memory Housekeeping
 *
 * Periodically consolidates `users/*.md`:
 *   - Merge semantically-duplicate bullets.
 *   - Drop entries whose `<!-- touched: -->` date is past the staleness window.
 *   - Reorder bullets within each section so the most-recently-touched come first.
 *
 * Consolidation is done by a Sonnet side-agent (same `query()` shape as the
 * extractor — `maxTurns: 1`, `allowedTools: []`). A trace-back validator
 * checks that every output bullet is derivable from an input bullet — output
 * bullets that don't trace back are dropped, preventing the side-agent from
 * smuggling in new facts.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  isHousekeepingEnabled,
  getUserPath,
  getEntityPath,
  getUsersDir,
  getStalenessDays,
} from './paths.js';
import { sanitizeEntitySlug } from './sanitize.js';
import { listEntities, writeEntity, addRelation } from './entities.js';
import { rebuildIndex } from './entity-index.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { logger } from '../system/logger.js';
import { recordHousekeepingNote } from './lifecycle.js';
import { parseLastTouched as parseLastTouchedFromAnnotations, stripLastTouched as stripLastTouchedFromAnnotations, appendLastTouched as appendLastTouchedFromAnnotations } from './annotations.js';
import type { EntityRecord } from './types.js';

const TOUCHED_RE = /<!--\s*touched:\s*(\d{4}-\d{2}-\d{2})\s*-->/;
const TRACE_DISTANCE_THRESHOLD = 0.4;

// ============================================================================
// Public entry point
// ============================================================================

export type HousekeepingTarget = 'all' | 'entities' | string;

/**
 * Consolidate one or more memory files. No-op when the housekeeping flag is
 * disabled.
 *
 *   - `target = 'all'`      → consolidate every users/<id>.md, and entities
 *   - `target = 'entities'` → dedup/merge + archive-stale + rebuild index (code-level)
 *   - `target = '<id>'`     → consolidate users/<id>.md only (side-agent)
 */
export async function runHousekeeping(target: HousekeepingTarget): Promise<void> {
  if (!isHousekeepingEnabled()) {
    logger.system('[memory] housekeeping disabled (ARCHIE_MEMORY_HOUSEKEEPING=false)');
    return;
  }
  if (target === 'entities') {
    await runEntityHousekeeping();
  } else if (target === 'all') {
    await consolidateAllUserFiles();
    await runEntityHousekeeping();
  } else {
    // assume a user ID
    await consolidateFile(`users/${target}.md`, getUserPath(target));
  }
}

async function consolidateAllUserFiles(): Promise<void> {
  const dir = getUsersDir();
  if (!existsSync(dir)) return;
  const { readdir } = await import('fs/promises');
  const entries = await readdir(dir);
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const stem = name.slice(0, -3);
    const id = stem.includes('__') ? stem.replace('__', ':') : stem;
    try {
      await consolidateFile(`users/${name}`, getUserPath(id));
    } catch (err) {
      logger.warn('memory', `housekeeping: skipped users/${name}: ${err}`);
    }
  }
}

// ============================================================================
// Entity housekeeping (code-level, deterministic)
// ============================================================================
//
// Unlike user consolidation (which uses the side-agent), entity
// consolidation is done in code: merging structured pages and repointing
// graph edges is deterministic and safe, and it trivially satisfies the
// no-new-facts constraint — only existing observations/relations are moved,
// never authored.

/**
 * Plan alias-based merges: if entity C lists alias A and a separate file with
 * slug A exists, that file (the duplicate) folds into C. Returns a map of
 * duplicate-slug → canonical-slug. Pure.
 */
export function planEntityMerges(records: EntityRecord[]): Map<string, string> {
  const bySlug = new Map(records.map((r) => [r.entity, r]));
  const mergedAway = new Map<string, string>();
  for (const canonical of records) {
    if (mergedAway.has(canonical.entity)) continue;
    for (const alias of canonical.aliases) {
      const dupSlug = sanitizeEntitySlug(alias);
      if (!dupSlug || dupSlug === canonical.entity) continue;
      const dup = bySlug.get(dupSlug);
      if (!dup || dup.entity === canonical.entity || mergedAway.has(dup.entity)) continue;
      mergedAway.set(dup.entity, canonical.entity);
    }
  }
  return mergedAway;
}

/**
 * True when every observation on the record is dated and older than the
 * staleness window. Undated observations are treated as fresh (never archive
 * on missing dates). An observation-less entity is not stale. Pure.
 */
export function isFullyStale(record: EntityRecord, stalenessDays: number, today: string): boolean {
  if (record.observations.length === 0) return false;
  return record.observations.every((o) => !!o.touched && daysBetween(o.touched, today) > stalenessDays);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

function mergeInto(canonical: EntityRecord, dup: EntityRecord): void {
  for (const o of dup.observations) {
    const norm = o.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!canonical.observations.some((x) => x.category === o.category && x.text.toLowerCase().replace(/\s+/g, ' ').trim() === norm)) {
      canonical.observations.push(o);
    }
  }
  for (const rel of dup.relations) addRelation(canonical.relations, rel);
  for (const a of [...dup.aliases, dup.entity]) {
    if (a.toLowerCase() !== canonical.entity && !canonical.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
      canonical.aliases.push(a);
    }
  }
  for (const repo of dup.repos) {
    if (!canonical.repos.some((x) => x.toLowerCase() === repo.toLowerCase())) canonical.repos.push(repo);
  }
  if (!canonical.domain && dup.domain) canonical.domain = dup.domain;
  if (!canonical.summary && dup.summary) canonical.summary = dup.summary;
}

async function runEntityHousekeeping(today?: string): Promise<void> {
  const date = today ?? new Date().toISOString().slice(0, 10);
  const records = await listEntities();
  if (records.length === 0) return;

  const bySlug = new Map(records.map((r) => [r.entity, r]));
  const mergedAway = planEntityMerges(records);

  // Fold each duplicate into its canonical entity.
  for (const [dupSlug, canonicalSlug] of mergedAway) {
    const dup = bySlug.get(dupSlug);
    const canonical = bySlug.get(canonicalSlug);
    if (dup && canonical) mergeInto(canonical, dup);
  }

  const staleness = getStalenessDays();
  let archived = 0;

  for (const r of records) {
    if (mergedAway.has(r.entity)) continue; // deleted below
    // Repoint relation edges that targeted a merged-away entity; dedupe after.
    const repointed: EntityRecord['relations'] = [];
    for (const rel of r.relations) {
      const target = mergedAway.get(rel.target) ?? rel.target;
      if (!repointed.some((x) => x.type === rel.type && x.target.toLowerCase() === target.toLowerCase())) {
        repointed.push({ ...rel, target });
      }
    }
    r.relations = repointed;
    if (r.status === 'active' && isFullyStale(r, staleness, date)) {
      r.status = 'archived';
      archived++;
    }
    await writeEntity(r);
  }

  // Remove merged-away files.
  for (const dupSlug of mergedAway.keys()) {
    await rm(getEntityPath(dupSlug), { force: true });
  }

  await rebuildIndex();

  const note = `entities: merged ${mergedAway.size} duplicate(s), archived ${archived} stale`;
  recordHousekeepingNote('entities', note);
  logger.system(`[memory] entity housekeeping — ${note}`);
}

// ============================================================================
// consolidateFile
// ============================================================================

async function consolidateFile(label: string, path: string): Promise<void> {
  if (!existsSync(path)) return;
  const before = await readFile(path, 'utf-8');
  if (!before.trim()) return;

  const inputBullets = extractBullets(before);
  if (inputBullets.length === 0) return;

  let proposed: string;
  try {
    proposed = await runHousekeeperAgent(before);
  } catch (err) {
    logger.warn('memory', `housekeeping: side-agent call failed for ${label}: ${err}`);
    return;
  }

  const outputBullets = extractBullets(proposed);
  const { accepted, rejected } = validateTraceBack(inputBullets, outputBullets);

  if (rejected.length > 0) {
    logger.warn('memory', `housekeeping: ${label} — dropped ${rejected.length} non-traceable bullet(s) from agent output`);
  }

  // Rebuild the file using only accepted bullets, grouped under their original sections.
  const rebuilt = rebuildFile(before, accepted);
  if (rebuilt === before) return;

  await writeFile(path, rebuilt, 'utf-8');

  const dropped = inputBullets.length - accepted.length;
  const merged = countMerges(inputBullets, accepted);
  recordHousekeepingNote(
    label,
    `${label}: dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'}, merged ${merged} duplicate(s)`
  );
  logger.system(`[memory] housekeeping consolidated ${label}: ${inputBullets.length} → ${accepted.length} bullet(s)`);
}

// ============================================================================
// Side-agent invocation
// ============================================================================

async function runHousekeeperAgent(fileContent: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const variables = {
    FILE_CONTENT: fileContent,
    STALENESS_DAYS: String(getStalenessDays()),
    TODAY: today,
  };
  let prompt: string;
  try {
    prompt = await loadPrompt('memory-housekeeper', variables);
  } catch {
    // Inline fallback so housekeeping degrades gracefully when the template is missing
    prompt = `Consolidate this memory file by merging duplicates and dropping stale entries older than ${variables.STALENESS_DAYS} days. Do not introduce new facts.\n\n${fileContent}`;
  }

  const agent = query({
    prompt,
    options: {
      model: 'sonnet' as any,
      maxTurns: 1,
      tools: [],
      executable: 'node',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      stderr: (data: string) => {
        logger.debug('memory', `housekeeping stderr: ${data.trim()}`);
      },
    },
  });

  let responseText = '';
  for await (const event of agent) {
    if (event.type === 'assistant') {
      const content = (event as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            responseText += block.text;
          }
        }
      }
    }
    if (event.type === 'result' && event.subtype === 'success') {
      const r = (event as any).result;
      if (typeof r === 'string' && r.trim()) responseText = r;
    }
  }
  return responseText.trim();
}

// ============================================================================
// Bullet extraction / rebuilding
// ============================================================================

export interface BulletInfo {
  section: string | null;
  text: string;
  touched: string | null;
}

/** Parse a Markdown file into its bullet records (section + visible text + touched annotation). */
export function extractBullets(content: string): BulletInfo[] {
  const bullets: BulletInfo[] = [];
  let currentSection: string | null = null;
  for (const raw of content.split('\n')) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(raw);
    if (sectionMatch && !raw.startsWith('### ')) {
      currentSection = sectionMatch[1];
      continue;
    }
    const bulletMatch = /^-\s+(.+?)\s*$/.exec(raw);
    if (!bulletMatch) continue;
    const body = bulletMatch[1];
    const touchedMatch = TOUCHED_RE.exec(body);
    const text = body.replace(TOUCHED_RE, '').trim();
    bullets.push({ section: currentSection, text, touched: touchedMatch ? touchedMatch[1] : null });
  }
  return bullets;
}

function rebuildFile(originalContent: string, accepted: BulletInfo[]): string {
  // Preserve original non-bullet structure: frontmatter, prose, section headers.
  // Group accepted bullets by section; replace each section's bullets with the accepted set.
  const lines = originalContent.split('\n');
  const sectionOrder: string[] = [];
  let currentSection: string | null = null;
  const bySection = new Map<string, BulletInfo[]>();
  for (const b of accepted) {
    const key = b.section ?? '';
    if (!bySection.has(key)) {
      bySection.set(key, []);
      if (b.section) sectionOrder.push(b.section);
    }
    bySection.get(key)!.push(b);
  }

  // Sort each section's bullets by touched date desc (untouched go last).
  for (const list of bySection.values()) {
    list.sort((a, b) => {
      if (!a.touched && !b.touched) return 0;
      if (!a.touched) return 1;
      if (!b.touched) return -1;
      return b.touched.localeCompare(a.touched);
    });
  }

  const out: string[] = [];
  let inSection = false;
  let sectionEmitted = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch && !line.startsWith('### ')) {
      currentSection = sectionMatch[1];
      out.push(line);
      // Emit accepted bullets for this section
      const list = bySection.get(currentSection) ?? [];
      for (const b of list) out.push(renderBullet(b));
      sectionEmitted.add(currentSection);
      inSection = true;
      // Skip original bullets in this section until next section header or EOF
      while (i + 1 < lines.length && !/^##\s+/.test(lines[i + 1])) {
        if (!/^-\s+/.test(lines[i + 1]) && lines[i + 1].trim() !== '') {
          // preserve non-bullet content (rare, but possible)
          out.push(lines[i + 1]);
        }
        i++;
      }
      continue;
    }
    if (!inSection) out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderBullet(b: BulletInfo): string {
  const annotation = b.touched ? `  <!-- touched: ${b.touched} -->` : '';
  return `- ${b.text}${annotation}`;
}

// ============================================================================
// Trace-back validator
// ============================================================================

/**
 * Drop any output bullet whose text cannot be matched to an input bullet
 * within `TRACE_DISTANCE_THRESHOLD` normalized edit distance. The validator
 * enforces design.md §D8: the side-agent may merge, drop, or reorder bullets
 * but MUST NOT introduce new facts.
 */
export function validateTraceBack(
  inputs: BulletInfo[],
  outputs: BulletInfo[]
): { accepted: BulletInfo[]; rejected: BulletInfo[] } {
  const accepted: BulletInfo[] = [];
  const rejected: BulletInfo[] = [];
  for (const out of outputs) {
    if (traceBackOutput(inputs, out)) {
      accepted.push(out);
    } else {
      rejected.push(out);
    }
  }
  return { accepted, rejected };
}

export function traceBackOutput(inputs: BulletInfo[], out: BulletInfo): boolean {
  const outNorm = normalise(out.text);
  for (const inp of inputs) {
    const inpNorm = normalise(inp.text);
    if (inpNorm === outNorm) return true;
    if (normalisedEditDistance(inpNorm, outNorm) <= TRACE_DISTANCE_THRESHOLD) return true;
  }
  return false;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalisedEditDistance(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 0;
  return levenshtein(a, b) / longer;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function countMerges(inputs: BulletInfo[], accepted: BulletInfo[]): number {
  // A merge is when two or more input bullets map to the same accepted bullet.
  // Count how many input bullets share a normalised match with an accepted bullet,
  // minus the accepted count (so 3 inputs → 1 accepted = 2 merges).
  let merges = 0;
  for (const out of accepted) {
    const matches = inputs.filter((i) => normalise(i.text) === normalise(out.text)).length;
    if (matches > 1) merges += matches - 1;
  }
  return merges;
}

// Re-export the annotation helpers for convenience.
export const parseLastTouched = parseLastTouchedFromAnnotations;
export const stripLastTouched = stripLastTouchedFromAnnotations;
export const appendLastTouched = appendLastTouchedFromAnnotations;
