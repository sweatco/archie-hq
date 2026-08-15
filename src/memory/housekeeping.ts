import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import {
  isHousekeepingEnabled,
  getUserPath,
  getUsersDir,
  getStalenessDays,
  getEntityCap,
  getEntityPath,
} from './paths.js';
import {
  sanitizeUpdate,
  sanitizeEntityDisplayName,
  sanitizeEntityAlias,
  sanitizeEntitySummary,
  sanitizeEntityObservation,
  sanitizeEntityRelation,
} from './sanitize.js';
import { listEntities, serializeEntity, writeEntity } from './entities.js';
import { rebuildIndex } from './entity-index.js';
import { logger } from '../system/logger.js';
import type { EntityObservation, EntityRecord, EntityRelation } from './types.js';

const TOUCHED_RE = /<!--\s*touched:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

export type HousekeepingTarget = 'all' | 'entities' | string;

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
    const id = name.slice(0, -3).replace('__', ':');
    try {
      await consolidateFile(`users/${name}`, getUserPath(id));
    } catch (err) {
      logger.warn('memory', `housekeeping: skipped users/${name}: ${err}`);
    }
  }
}

export function isFullyStale(record: EntityRecord, stalenessDays: number, today: string): boolean {
  if (record.observations.length === 0) return false;
  return record.observations.every((observation) =>
    !!observation.touched && daysBetween(observation.touched, today) > stalenessDays
  );
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

function newer<T extends { touched?: string }>(current: T, candidate: T): T {
  if (!current.touched) return candidate.touched ? candidate : current;
  if (!candidate.touched) return current;
  return candidate.touched > current.touched ? candidate : current;
}

function dedupeObservations(observations: EntityObservation[]): EntityObservation[] {
  const selected = new Map<string, { value: EntityObservation; index: number }>();
  observations.forEach((observation, index) => {
    const key = `${observation.category}\0${normalise(observation.text)}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, { value: observation, index });
      return;
    }
    const value = newer(current.value, observation);
    if (value === observation) selected.set(key, { value, index });
  });
  return [...selected.values()]
    .sort((a, b) => (b.value.touched ?? '').localeCompare(a.value.touched ?? '') || a.index - b.index)
    .map(({ value }) => value);
}

function dedupeRelations(relations: EntityRelation[]): EntityRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.type}\0${relation.target.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runEntityHousekeeping(today?: string): Promise<void> {
  const date = today ?? new Date().toISOString().slice(0, 10);
  let records = await listEntities();
  let archived = 0;
  let deduped = 0;
  const beforeBySlug = new Map(records.map((record) => [record.entity, serializeEntity(record)]));

  for (const record of records) {
    record.displayName = sanitizeEntityDisplayName(record.displayName) ?? record.entity;
    record.aliases = record.aliases
      .map(sanitizeEntityAlias)
      .filter((alias): alias is string => alias !== null);
    record.repos = record.repos.filter((repo) => /^[A-Za-z0-9._-]{1,64}$/.test(repo));
    record.summary = sanitizeEntitySummary(record.summary) ?? '';
    record.observations = record.observations.flatMap((observation) => {
      const clean = sanitizeEntityObservation(observation);
      return clean ? [{ ...clean, ...(observation.touched ? { touched: observation.touched } : {}) }] : [];
    });
    record.relations = record.relations.flatMap((relation) => {
      const clean = sanitizeEntityRelation(relation);
      return clean ? [clean] : [];
    });
    const before = record.observations.length + record.relations.length;
    record.observations = dedupeObservations(record.observations);
    record.relations = dedupeRelations(record.relations);
    record.aliases = dedupeStrings(record.aliases);
    record.repos = dedupeStrings(record.repos);
    deduped += before - record.observations.length - record.relations.length;
  }

  const reconciled = reconcileAliasCollisions(records);
  records = reconciled.records;

  for (const record of records) {
    if (record.status === 'active' && isFullyStale(record, getStalenessDays(), date)) {
      record.status = 'archived';
      archived++;
    }
  }

  const active = records.filter((record) => record.status === 'active');
  const overflow = Math.max(0, active.length - getEntityCap());
  const observationRecency = (record: EntityRecord): string => record.observations.reduce(
    (latest, observation) => observation.touched && observation.touched > latest ? observation.touched : latest,
    '',
  );
  const recency = (record: EntityRecord): string => record.lastTouched ?? observationRecency(record);
  active
    .sort((a, b) => recency(a).localeCompare(recency(b)) || a.entity.localeCompare(b.entity))
    .slice(0, overflow)
    .forEach((record) => {
      record.status = 'archived';
      archived++;
    });

  for (const slug of reconciled.canonicalSlugs) {
    const record = records.find((candidate) => candidate.entity === slug);
    if (record) await writeEntity(record);
  }
  for (const record of records) {
    if (reconciled.canonicalSlugs.has(record.entity)) continue;
    if (serializeEntity(record) !== beforeBySlug.get(record.entity)) await writeEntity(record);
  }
  for (const slug of reconciled.removedSlugs) {
    try {
      await unlink(getEntityPath(slug));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  if (records.length > 0) await rebuildIndex();
  logger.system(`[memory] entity housekeeping — removed ${deduped} duplicate(s), archived ${archived} stale`);
}

function reconcileAliasCollisions(records: EntityRecord[]): {
  records: EntityRecord[];
  canonicalSlugs: Set<string>;
  removedSlugs: Set<string>;
} {
  const sorted = [...records].sort((a, b) => a.entity.localeCompare(b.entity));
  const parent = new Map(sorted.map((record) => [record.entity, record.entity]));
  const find = (slug: string): string => {
    const current = parent.get(slug) ?? slug;
    if (current === slug) return slug;
    const root = find(current);
    parent.set(slug, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const left = find(a);
    const right = find(b);
    if (left === right) return;
    parent.set(left < right ? right : left, left < right ? left : right);
  };
  const ownerByKey = new Map<string, string>();
  for (const record of sorted) {
    for (const key of [record.entity, ...record.aliases].map((value) => value.toLowerCase())) {
      const owner = ownerByKey.get(key);
      if (owner) union(record.entity, owner);
      else ownerByKey.set(key, record.entity);
    }
  }

  const groups = new Map<string, EntityRecord[]>();
  for (const record of sorted) {
    const root = find(record.entity);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  }

  const removedSlugs = new Set<string>();
  const canonicalSlugs = new Set<string>();
  const replacement = new Map<string, string>();
  const survivors: EntityRecord[] = [];
  for (const group of groups.values()) {
    const canonical = group[0];
    survivors.push(canonical);
    if (group.length === 1) continue;
    canonicalSlugs.add(canonical.entity);
    for (const member of group) {
      for (const key of [member.entity, ...member.aliases]) {
        replacement.set(key.toLowerCase(), canonical.entity);
      }
    }
    for (const duplicate of group.slice(1)) {
      removedSlugs.add(duplicate.entity);
      canonical.aliases.push(duplicate.entity, ...duplicate.aliases);
      canonical.repos.push(...duplicate.repos);
      canonical.observations.push(...duplicate.observations);
      canonical.relations.push(...duplicate.relations);
      canonical.summary ||= duplicate.summary;
      canonical.domain ||= duplicate.domain;
      canonical.lastTouched = [canonical.lastTouched, duplicate.lastTouched].filter(Boolean).sort().at(-1);
      if (duplicate.status === 'active') canonical.status = 'active';
    }
    canonical.aliases = dedupeStrings(canonical.aliases)
      .filter((alias) => alias.toLowerCase() !== canonical.entity);
    canonical.repos = dedupeStrings(canonical.repos);
    canonical.observations = dedupeObservations(canonical.observations);
    canonical.relations = dedupeRelations(canonical.relations);
  }

  for (const record of survivors) {
    record.relations = dedupeRelations(record.relations.map((relation) => ({
      ...relation,
      target: replacement.get(relation.target.toLowerCase()) ?? relation.target,
    })));
  }
  return { records: survivors, canonicalSlugs, removedSlugs };
}

export interface BulletInfo {
  section: string | null;
  text: string;
  touched: string | null;
}

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
    const touchedMatch = TOUCHED_RE.exec(bulletMatch[1]);
    const text = bulletMatch[1].replace(TOUCHED_RE, '').trim();
    bullets.push({ section: currentSection, text, touched: touchedMatch?.[1] ?? null });
  }
  return bullets;
}

export function consolidateBullets(
  inputs: BulletInfo[],
  stalenessDays: number,
  today: string,
): BulletInfo[] {
  const selected = new Map<string, { value: BulletInfo; index: number }>();
  inputs.forEach((input, index) => {
    if (!input.section || input.section.length > 80 || /[<>\r\n]/.test(input.section)) return;
    if (input.touched && daysBetween(input.touched, today) > stalenessDays) return;
    // New writes use a closed section vocabulary, but housekeeping must not
    // erase safe data from older headings. Reuse the canonical section only to
    // run the same content, secret, and instruction checks.
    const clean = sanitizeUpdate({ action: 'add', section: 'Communication', content: input.text });
    if (!clean) return;
    const acceptedInput = input;

    const key = `${input.section}\0${normalise(clean.content)}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, { value: acceptedInput, index });
      return;
    }
    const currentTouched = current.value.touched ?? '';
    const candidateTouched = input.touched ?? '';
    if (candidateTouched > currentTouched) selected.set(key, { value: acceptedInput, index });
  });
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ value }) => value);
}

async function consolidateFile(label: string, path: string): Promise<void> {
  if (!existsSync(path)) return;
  const before = await readFile(path, 'utf-8');
  if (!before.trim()) return;
  const inputs = extractBullets(before);
  if (inputs.length === 0) return;

  const accepted = consolidateBullets(
    inputs,
    getStalenessDays(),
    new Date().toISOString().slice(0, 10),
  );
  const rebuilt = rebuildFile(before, accepted);
  if (rebuilt === before) return;
  await writeFile(path, rebuilt, 'utf-8');
  logger.system(`[memory] housekeeping consolidated ${label}: ${inputs.length} → ${accepted.length} bullet(s)`);
}

function rebuildFile(originalContent: string, accepted: BulletInfo[]): string {
  const lines = originalContent.split('\n');
  const bySection = new Map<string, BulletInfo[]>();
  for (const bullet of accepted) {
    if (!bullet.section) continue;
    const list = bySection.get(bullet.section) ?? [];
    list.push(bullet);
    bySection.set(bullet.section, list);
  }
  for (const list of bySection.values()) {
    list.sort((a, b) => (b.touched ?? '').localeCompare(a.touched ?? ''));
  }

  const out: string[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (sectionMatch && !lines[i].startsWith('### ')) {
      inSection = true;
      out.push(lines[i]);
      for (const bullet of bySection.get(sectionMatch[1]) ?? []) out.push(renderBullet(bullet));
      while (i + 1 < lines.length && !/^##\s+/.test(lines[i + 1])) {
        if (!/^-\s+/.test(lines[i + 1]) && lines[i + 1].trim()) out.push(lines[i + 1]);
        i++;
      }
      continue;
    }
    if (!inSection) out.push(lines[i]);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderBullet(bullet: BulletInfo): string {
  const touched = bullet.touched ? `  <!-- touched: ${bullet.touched} -->` : '';
  return `- ${bullet.text}${touched}`;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
