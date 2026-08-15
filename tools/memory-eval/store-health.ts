/**
 * memory:eval — store-health metrics (mechanical tier).
 *
 * Pure over a set of parsed entity records; no filesystem access. The
 * near-duplicate metric is versioned so a later semantic upgrade cannot
 * silently rebase the trend the dedupe phase is judged by.
 */

import { serializeEntity } from '../../src/memory/entities.js';
import { tokenize, lastTouched } from '../../src/memory/entity-index.js';
import type { EntityRecord } from './types.js';

/** Bump when the near-duplicate definition changes — trends only compare within a version. */
export const DUP_METRIC_VERSION = 'dup-lex-2 (jaccard>=0.6 over name+aliases+L0 tokens; rate = pairs / active entities)';
const DUP_JACCARD_THRESHOLD = 0.6;

export interface Distribution {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

export interface StoreHealth {
  entityCount: number;
  entityCap: number;
  activeCount: number;
  archivedCount: number;
  observationsPerPage: Distribution;
  pageBytes: Distribution;
  /** Buckets of days-since-last-touch: fresh (<30), aging (30–90), stale (90–180), dead (>180 or undated). */
  staleness: { fresh: number; aging: number; stale: number; dead: number };
  dupMetricVersion: string;
  nearDuplicatePairs: Array<[string, string]>;
  /** pairs / entityCount — the dedupe trend number. */
  nearDuplicateRate: number;
}

export interface StoreHealthDelta {
  entityCountDelta: number;
  archivedDelta: number;
  nearDuplicateRateDelta: number;
  /** Slugs present now but not in the previous report, and vice versa. */
  added: string[];
  removed: string[];
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p90: 0 };
  const s = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile: ceil(p/100·n)−1. floor(p·n/100) would index one
  // rank high at every integer boundary (p50 of [1,100] → 100), inflating
  // every reported distribution.
  const pct = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  return {
    min: s[0],
    max: s[s.length - 1],
    mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10,
    p50: pct(50),
    p90: pct(90),
  };
}

function dupTokens(r: EntityRecord): Set<string> {
  return tokenize([r.entity.replace(/-/g, ' '), r.displayName, r.summary, ...r.aliases].join(' '));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function nearDuplicatePairs(records: EntityRecord[]): Array<[string, string]> {
  const active = records.filter((r) => r.status !== 'archived');
  const tokens = active.map((r) => dupTokens(r));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (jaccard(tokens[i], tokens[j]) >= DUP_JACCARD_THRESHOLD) {
        pairs.push([active[i].entity, active[j].entity]);
      }
    }
  }
  return pairs;
}

export function computeStoreHealth(
  records: EntityRecord[],
  opts: { entityCap: number; today?: string },
): StoreHealth {
  const today = opts.today ? new Date(opts.today) : new Date();
  const active = records.filter((r) => r.status !== 'archived');

  const staleness = { fresh: 0, aging: 0, stale: 0, dead: 0 };
  for (const r of active) {
    const t = lastTouched(r);
    if (!t) {
      staleness.dead++;
      continue;
    }
    const days = Math.floor((today.getTime() - new Date(t).getTime()) / 86_400_000);
    if (days < 30) staleness.fresh++;
    else if (days < 90) staleness.aging++;
    else if (days < 180) staleness.stale++;
    else staleness.dead++;
  }

  const pairs = nearDuplicatePairs(records);
  return {
    entityCount: records.length,
    entityCap: opts.entityCap,
    activeCount: active.length,
    archivedCount: records.length - active.length,
    observationsPerPage: distribution(active.map((r) => r.observations.length)),
    pageBytes: distribution(active.map((r) => serializeEntity(r).length)),
    staleness,
    dupMetricVersion: DUP_METRIC_VERSION,
    nearDuplicatePairs: pairs,
    // Pairs are computed over active entities, so the denominator must be the
    // active count too — dividing by all records would move the trend when
    // unrelated pages get archived.
    nearDuplicateRate: active.length === 0 ? 0 : Math.round((pairs.length / active.length) * 1000) / 1000,
  };
}

export function computeDelta(
  current: StoreHealth & { slugs: string[] },
  prev: { entityCount: number; archivedCount: number; nearDuplicateRate: number; slugs?: string[] },
): StoreHealthDelta {
  const prevSlugs = new Set(prev.slugs ?? []);
  const nowSlugs = new Set(current.slugs);
  return {
    entityCountDelta: current.entityCount - prev.entityCount,
    archivedDelta: current.archivedCount - prev.archivedCount,
    nearDuplicateRateDelta: Math.round((current.nearDuplicateRate - prev.nearDuplicateRate) * 1000) / 1000,
    added: current.slugs.filter((s) => !prevSlugs.has(s)),
    removed: [...prevSlugs].filter((s) => !nowSlugs.has(s)),
  };
}
