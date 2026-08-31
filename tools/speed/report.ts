/**
 * report.ts — aggregation and arm-to-arm comparison. Pure, no I/O.
 *
 * A speed suite earns its keep by being hard to fool. Three rules are built in
 * rather than left to whoever reads the table:
 *
 *  1. Latency is skewed, so the mean is reported but never used to decide
 *     anything. Comparisons run on ranks (Mann–Whitney U), which makes no
 *     assumption about the shape of the distribution.
 *  2. A comparison across different models or different SERVING TIERS is not a
 *     comparison of the change under test. It is refused with a warning rather
 *     than rendered as a result.
 *  3. Nothing is dropped silently. Excluded round trips and underpowered arms
 *     appear in the output.
 */

import type { Mechanisms, SpeedSample } from './metrics.js';

export interface Stats {
  n: number;
  mean: number;
  /** Nearest-rank percentiles: the value at `ceil(p * n)`, 1-indexed. */
  p50: number;
  p90: number;
  min: number;
  max: number;
}

export const NO_STATS: Stats = { n: 0, mean: NaN, p50: NaN, p90: NaN, min: NaN, max: NaN };

export function stats(values: number[]): Stats {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NO_STATS;
  const nth = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return {
    n: v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    p50: nth(0.5),
    p90: nth(0.9),
    min: v[0],
    max: v[v.length - 1],
  };
}

export interface Aggregate {
  /** Number of SAMPLES (task runs), not of measurements within them. */
  samples: number;
  /** The headline: what a person waits for. One value per exchange. */
  timeToFirstWordMs: Stats;
  timeToCompletionMs: Stats;
  /** Leading indicator — moves before felt latency does. One value per sample. */
  silentSetupRoundTrips: Stats;
  /** Per model round trip, pooled across agents. */
  roundTripMs: Stats;
  /** Hops per sample. Zero is the target for self-answerable questions. */
  delegationHops: Stats;
  /** Per hop: what a fresh agent costs before it produces anything. */
  activeToFirstOutputMs: Stats;
  outputTokens: Stats;
  cacheCreationTokens: Stats;
  models: string[];
  speedTiers: string[];
  toolMix: Record<string, number>;
  /** Round trips excluded as too long to be one inference. */
  excludedOverCap: number;
  /** Samples whose usage records carried no usable price (gateway models). */
  unpricedRecords: number;
}

const uniqueSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

export function aggregate(samples: SpeedSample[]): Aggregate {
  const ttfw: number[] = [];
  const ttc: number[] = [];
  const setup: number[] = [];
  const trips: number[] = [];
  const hops: number[] = [];
  const spawn: number[] = [];
  const out: number[] = [];
  const cacheW: number[] = [];
  const models: string[] = [];
  const tiers: string[] = [];
  const toolMix: Record<string, number> = {};
  let excludedOverCap = 0;
  let unpricedRecords = 0;

  for (const s of samples) {
    for (const e of s.exchanges) {
      if (e.timeToFirstWordMs !== null) ttfw.push(e.timeToFirstWordMs);
      if (e.timeToCompletionMs !== null) ttc.push(e.timeToCompletionMs);
    }
    if (s.silentSetupRoundTrips !== null) setup.push(s.silentSetupRoundTrips);
    for (const r of s.roundTrips) trips.push(r.roundTripMs);
    hops.push(s.delegations.length);
    for (const d of s.delegations) {
      if (d.activeToFirstOutputMs !== null) spawn.push(d.activeToFirstOutputMs);
    }
    if (s.usage) {
      out.push(s.usage.outputTokens);
      cacheW.push(s.usage.cacheCreationTokens);
      models.push(...s.usage.models);
      tiers.push(...s.usage.speedTiers);
      unpricedRecords += s.usage.costUnpricedRecords;
    }
    for (const [name, count] of Object.entries(s.toolMix)) {
      toolMix[name] = (toolMix[name] ?? 0) + count;
    }
    excludedOverCap += s.excluded.overCap;
  }

  return {
    samples: samples.length,
    timeToFirstWordMs: stats(ttfw),
    timeToCompletionMs: stats(ttc),
    silentSetupRoundTrips: stats(setup),
    roundTripMs: stats(trips),
    delegationHops: stats(hops),
    activeToFirstOutputMs: stats(spawn),
    outputTokens: stats(out),
    cacheCreationTokens: stats(cacheW),
    models: uniqueSorted(models),
    speedTiers: uniqueSorted(tiers),
    toolMix,
    excludedOverCap,
    unpricedRecords,
  };
}

// ---- Rank-sum comparison --------------------------------------------------

export interface RankSum {
  /** Two-sided p-value from the normal approximation, tie-corrected. */
  p: number;
  /**
   * Probability a random draw from B is smaller (faster) than one from A.
   * 0.5 is no effect; above 0.5 means B is faster. Reported alongside p
   * because "significant" says nothing about how much.
   */
  probBFaster: number;
  /** False when the normal approximation is not trustworthy at this size. */
  reliable: boolean;
}

/**
 * Mann–Whitney U with tie correction and a continuity-corrected normal
 * approximation.
 *
 * Chosen over a t-test because response latency is heavy-tailed: one 80s
 * outlier moves a mean enough to invent or hide an effect, and moves a rank by
 * exactly one place. `reliable` is false below 8 per arm, where the normal
 * approximation stops holding — the numbers are still returned, flagged, rather
 * than suppressed, so a small pilot run can be read for direction.
 */
export function rankSum(a: number[], b: number[]): RankSum | null {
  const A = a.filter(Number.isFinite);
  const B = b.filter(Number.isFinite);
  if (A.length === 0 || B.length === 0) return null;

  const pooled = [...A.map((v) => ({ v, arm: 0 })), ...B.map((v) => ({ v, arm: 1 }))]
    .sort((x, y) => x.v - y.v);

  // Average ranks within each tie group, and collect group sizes for the
  // variance correction — without it, a suite where many runs land on the same
  // rounded millisecond reports a p-value that is too small.
  const ranks = new Array<number>(pooled.length);
  const tieGroups: number[] = [];
  for (let i = 0; i < pooled.length; ) {
    let j = i;
    while (j + 1 < pooled.length && pooled[j + 1].v === pooled[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }

  let rankSumA = 0;
  for (let i = 0; i < pooled.length; i++) if (pooled[i].arm === 0) rankSumA += ranks[i];

  const n1 = A.length, n2 = B.length, N = n1 + n2;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const tieTerm = tieGroups.reduce((acc, t) => acc + (t ** 3 - t), 0);
  const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm / (N * (N - 1)));

  // Every value identical across both arms: no ranking information at all.
  if (variance <= 0) return { p: 1, probBFaster: 0.5, reliable: false };

  const z = (Math.abs(u1 - mu) - 0.5) / Math.sqrt(variance);
  return {
    p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))),
    // u1 counts the pairs where A's value is the LARGER one — i.e. where A was
    // slower and B therefore faster. Normalised by the pair count, that IS the
    // probability a random draw from B beats a random draw from A.
    probBFaster: u1 / (n1 * n2),
    reliable: n1 >= 8 && n2 >= 8,
  };
}

/** Abramowitz & Stegun 7.1.26 error function; ~1e-7 absolute accuracy. */
function normalCdf(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-x * x);
  return 0.5 * (1 + (x >= 0 ? y : -y));
}

export interface Comparison {
  before: Aggregate;
  after: Aggregate;
  /** Rank-sum on the headline metric. `null` when the arms cannot be compared. */
  timeToFirstWord: RankSum | null;
  roundTripMs: RankSum | null;
  /**
   * Reasons this comparison is not trustworthy. A non-empty `blocking` means
   * the arms differ in something other than the change under test, and the
   * deltas below should not be read as a result.
   */
  blocking: string[];
  warnings: string[];
  /** Median deltas, in ms and in count. Negative is faster / fewer. */
  deltaP50: { timeToFirstWordMs: number; roundTripMs: number; silentSetupRoundTrips: number };
}

export function compare(
  before: Aggregate,
  after: Aggregate,
  beforeSamples: SpeedSample[],
  afterSamples: SpeedSample[],
): Comparison {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const sameSet = (x: string[], y: string[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);

  // The two mismatches that make a latency number mean something else entirely.
  if (before.speedTiers.length > 0 && after.speedTiers.length > 0 && !sameSet(before.speedTiers, after.speedTiers)) {
    blocking.push(
      `serving tier differs (before=[${before.speedTiers}] after=[${after.speedTiers}]) — ` +
      `this measures the tier, not the change`,
    );
  }
  if (before.models.length > 0 && after.models.length > 0 && !sameSet(before.models, after.models)) {
    blocking.push(`models differ (before=[${before.models}] after=[${after.models}])`);
  }

  if (before.samples < 8 || after.samples < 8) {
    warnings.push(`underpowered: ${before.samples} vs ${after.samples} samples (want >= 8 per arm)`);
  }
  if (before.speedTiers.length === 0 || after.speedTiers.length === 0) {
    warnings.push('serving tier unknown for at least one arm (no usage.jsonl) — tier parity is unverified');
  }
  if (before.excludedOverCap + after.excludedOverCap > 0) {
    warnings.push(
      `${before.excludedOverCap + after.excludedOverCap} round trip(s) excluded as over the cap ` +
      `(agent parked, not thinking)`,
    );
  }

  const ttfwOf = (ss: SpeedSample[]): number[] =>
    ss.flatMap((s) => s.exchanges.map((e) => e.timeToFirstWordMs).filter((v): v is number => v !== null));
  const tripsOf = (ss: SpeedSample[]): number[] => ss.flatMap((s) => s.roundTrips.map((r) => r.roundTripMs));

  return {
    before,
    after,
    timeToFirstWord: blocking.length === 0 ? rankSum(ttfwOf(beforeSamples), ttfwOf(afterSamples)) : null,
    roundTripMs: blocking.length === 0 ? rankSum(tripsOf(beforeSamples), tripsOf(afterSamples)) : null,
    blocking,
    warnings,
    deltaP50: {
      timeToFirstWordMs: after.timeToFirstWordMs.p50 - before.timeToFirstWordMs.p50,
      roundTripMs: after.roundTripMs.p50 - before.roundTripMs.p50,
      silentSetupRoundTrips: after.silentSetupRoundTrips.p50 - before.silentSetupRoundTrips.p50,
    },
  };
}

// ---- Rendering ------------------------------------------------------------

const secs = (v: number): string => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '—');
const num = (v: number, dp = 1): string => (Number.isFinite(v) ? v.toFixed(dp) : '—');
const pad = (s: string, w: number): string => s.padEnd(w);

const ROWS: Array<{ label: string; key: keyof Aggregate; fmt: 'ms' | 'n' }> = [
  { label: 'time to first word', key: 'timeToFirstWordMs', fmt: 'ms' },
  { label: 'time to completion', key: 'timeToCompletionMs', fmt: 'ms' },
  { label: 'silent setup trips', key: 'silentSetupRoundTrips', fmt: 'n' },
  { label: 'round trip', key: 'roundTripMs', fmt: 'ms' },
  { label: 'delegation hops', key: 'delegationHops', fmt: 'n' },
  { label: 'agent spawn->output', key: 'activeToFirstOutputMs', fmt: 'ms' },
  { label: 'output tokens', key: 'outputTokens', fmt: 'n' },
  { label: 'cache creation tok', key: 'cacheCreationTokens', fmt: 'n' },
];

export function renderAggregate(title: string, a: Aggregate): string {
  const lines = [
    `${title}  (${a.samples} sample${a.samples === 1 ? '' : 's'})`,
    `  models: ${a.models.join(', ') || 'unknown'}   serving tier: ${a.speedTiers.join(', ') || 'unknown'}`,
    '',
    `  ${pad('metric', 22)}${pad('n', 6)}${pad('mean', 10)}${pad('p50', 10)}${pad('p90', 10)}max`,
  ];
  for (const r of ROWS) {
    const s = a[r.key] as Stats;
    const f = r.fmt === 'ms' ? secs : (v: number) => num(v, r.key === 'outputTokens' || r.key === 'cacheCreationTokens' ? 0 : 1);
    lines.push(`  ${pad(r.label, 22)}${pad(String(s.n), 6)}${pad(f(s.mean), 10)}${pad(f(s.p50), 10)}${pad(f(s.p90), 10)}${f(s.max)}`);
  }
  const top = Object.entries(a.toolMix).sort((x, y) => y[1] - x[1]).slice(0, 8);
  if (top.length > 0) {
    lines.push('', `  tool mix: ${top.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  if (a.excludedOverCap > 0) lines.push(`  excluded (over cap): ${a.excludedOverCap} round trip(s)`);
  if (a.unpricedRecords > 0) lines.push(`  unpriced usage records (gateway models): ${a.unpricedRecords} — cost omitted, not zero`);
  return lines.join('\n');
}

export function renderComparison(c: Comparison, beforeName = 'before', afterName = 'after'): string {
  const parts = [renderAggregate(beforeName, c.before), '', renderAggregate(afterName, c.after), ''];

  if (c.blocking.length > 0) {
    parts.push('COMPARISON REFUSED — the arms differ in more than the change under test:');
    for (const b of c.blocking) parts.push(`  ! ${b}`);
    parts.push('', 'Fix the mismatch and re-run. The per-arm tables above still stand on their own.');
    return parts.join('\n');
  }

  const verdict = (r: ReturnType<typeof rankSum>, label: string, delta: number, unit: 'ms' | 'n'): string => {
    if (!r) return `  ${pad(label, 22)}no data`;
    const d = unit === 'ms' ? secs(delta) : num(delta, 2);
    const dir = delta < 0 ? 'faster' : delta > 0 ? 'slower' : 'unchanged';
    const sig = r.p < 0.05 ? `p=${r.p.toFixed(4)}` : `p=${r.p.toFixed(3)} (not significant)`;
    const flag = r.reliable ? '' : '  [n too small for the approximation]';
    return `  ${pad(label, 22)}${pad(`${d} ${dir}`, 22)}${pad(`P(${afterName} faster)=${r.probBFaster.toFixed(2)}`, 26)}${sig}${flag}`;
  };

  parts.push(`${beforeName} -> ${afterName}  (median delta; rank-sum on pooled measurements)`);
  parts.push(verdict(c.timeToFirstWord, 'time to first word', c.deltaP50.timeToFirstWordMs, 'ms'));
  parts.push(verdict(c.roundTripMs, 'round trip', c.deltaP50.roundTripMs, 'ms'));
  parts.push(`  ${pad('silent setup trips', 22)}${num(c.deltaP50.silentSetupRoundTrips, 2)} (median delta; no test applied)`);

  if (c.warnings.length > 0) {
    parts.push('', 'warnings:');
    for (const w of c.warnings) parts.push(`  - ${w}`);
  }
  return parts.join('\n');
}

// ---- Arm matrix ------------------------------------------------------------

/**
 * One arm's row in the matrix.
 *
 * `mechanismDelta` is what separates "this tweak did nothing" from "this tweak
 * never ran". A tweak whose structural effect is visible in the tool mix but
 * whose latency did not move is a real negative result worth acting on; a tweak
 * whose structural effect is ABSENT was not exercised, and reporting it as a
 * negative would retire a good idea for the wrong reason.
 */
export interface ArmRow {
  arm: string;
  samples: number;
  passRate: number | null;
  timeToFirstWordP50: number;
  deltaP50Ms: number;
  rank: RankSum | null;
  roundTripP50: number;
  silentSetupP50: number;
  delegationHopsMean: number;
  /** Mechanism counters averaged per sample, so arms of different size compare. */
  mechanisms: Mechanisms;
  blocking: string[];
}

/**
 * Which counter each arm is supposed to move, and in which direction.
 *
 * Declared per arm rather than inferred, because the generic version of this
 * check — "did anything about the arm look different?" — reads ordinary
 * run-to-run wobble as proof the tweak fired. It did exactly that on the first
 * campaign round: an arm whose target behaviour never occurred at all was
 * scored a measured no-op because an unrelated counter drifted by one.
 *
 * An arm with no entry here is scored on latency alone and says so.
 */
export const ARM_MECHANISM: Record<string, keyof Mechanisms> = {
  't1-pages': 'readWithPages',
  't2-alwaysload': 'toolSearches',
  't4-knowledge': 'knowledgeLogFetches',
};

const meanMechanisms = (samples: SpeedSample[]): Mechanisms => {
  const keys: Array<keyof Mechanisms> = ['knowledgeLogFetches', 'readWithPages', 'toolSearches', 'skillLoads'];
  const out = { knowledgeLogFetches: 0, readWithPages: 0, toolSearches: 0, skillLoads: 0 } as Mechanisms;
  if (samples.length === 0) return out;
  for (const k of keys) out[k] = samples.reduce((a, s) => a + (s.mechanisms?.[k] ?? 0), 0) / samples.length;
  return out;
};

/**
 * Compare every arm against the first (the baseline).
 *
 * `passRates` is keyed by arm and supplied by the caller from the graded run
 * files, because grading lives in `cases.ts` and this module stays pure stats.
 */
export function armMatrix(
  arms: Array<{ label: string; samples: SpeedSample[] }>,
  passRates: Record<string, number | null> = {},
): ArmRow[] {
  if (arms.length === 0) return [];
  const base = arms[0];
  const baseAgg = aggregate(base.samples);

  return arms.map(({ label, samples }) => {
    const agg = aggregate(samples);
    const c = compare(baseAgg, agg, base.samples, samples);
    return {
      arm: label,
      samples: agg.samples,
      passRate: passRates[label] ?? null,
      timeToFirstWordP50: agg.timeToFirstWordMs.p50,
      deltaP50Ms: label === base.label ? 0 : c.deltaP50.timeToFirstWordMs,
      rank: label === base.label ? null : c.timeToFirstWord,
      roundTripP50: agg.roundTripMs.p50,
      silentSetupP50: agg.silentSetupRoundTrips.p50,
      delegationHopsMean: agg.delegationHops.mean,
      mechanisms: meanMechanisms(samples),
      blocking: label === base.label ? [] : c.blocking,
    };
  });
}

const sec = (v: number): string => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '—');
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');

/**
 * Render the matrix, then a verdict line per arm.
 *
 * The verdict deliberately distinguishes three outcomes rather than two:
 * a win, a measured no-op, and "not exercised" — the last being a harness
 * problem masquerading as a negative result.
 */
export function renderMatrix(rows: ArmRow[]): string {
  if (rows.length === 0) return 'no arms to report';
  const w = Math.max(14, ...rows.map((r) => r.arm.length + 1));
  const head = `${pad('arm', w)}${pad('n', 5)}${pad('pass', 7)}${pad('ttfw p50', 11)}${pad('delta', 11)}` +
    `${pad('p', 10)}${pad('rt p50', 9)}${pad('setup', 7)}${pad('hops', 6)}${pad('log-get', 9)}${pad('toolsrch', 10)}${pad('rd+pages', 10)}skill`;
  const out = [head, '-'.repeat(head.length)];

  for (const r of rows) {
    out.push(
      pad(r.arm, w) +
      pad(String(r.samples), 5) +
      pad(r.passRate === null ? '—' : `${Math.round(r.passRate * 100)}%`, 7) +
      pad(sec(r.timeToFirstWordP50), 11) +
      pad(r.deltaP50Ms === 0 ? '—' : `${r.deltaP50Ms > 0 ? '+' : ''}${sec(r.deltaP50Ms)}`, 11) +
      pad(r.rank ? (r.rank.p < 0.05 ? r.rank.p.toFixed(4) : r.rank.p.toFixed(3)) : '—', 10) +
      pad(sec(r.roundTripP50), 9) +
      pad(f1(r.silentSetupP50), 7) +
      pad(f2(r.delegationHopsMean), 6) +
      pad(f2(r.mechanisms.knowledgeLogFetches), 9) +
      pad(f2(r.mechanisms.toolSearches), 10) +
      pad(f2(r.mechanisms.readWithPages), 10) +
      f2(r.mechanisms.skillLoads),
    );
  }

  out.push('', 'verdicts (vs baseline):');
  const base = rows[0];
  for (const r of rows.slice(1)) {
    if (r.blocking.length > 0) {
      out.push(`  ${pad(r.arm, w)}INVALID — ${r.blocking[0]}`);
      continue;
    }
    if (r.samples === 0) {
      out.push(`  ${pad(r.arm, w)}NOT EXERCISED — no samples collected`);
      continue;
    }
    // The arm's own declared target: was the behaviour there to remove, and did
    // it go away? Checked before latency, because an arm with no target cannot
    // have a latency result worth reading either way.
    const key = ARM_MECHANISM[r.arm];
    const baseCount = key ? base.mechanisms[key] : NaN;
    const armCount = key ? r.mechanisms[key] : NaN;

    if (key && baseCount < 0.25) {
      out.push(
        `  ${pad(r.arm, w)}NO TARGET — baseline shows ${baseCount.toFixed(2)} ${key}/sample, so there is ` +
        `nothing for this tweak to remove on these cases. Not a negative result.`,
      );
      continue;
    }
    if (key && armCount >= baseCount * 0.75) {
      out.push(
        `  ${pad(r.arm, w)}MECHANISM DID NOT FIRE — ${key} ${baseCount.toFixed(2)} -> ${armCount.toFixed(2)} ` +
        `per sample; check the flag reached the instance before reading the latency.`,
      );
      continue;
    }

    const sig = r.rank && r.rank.p < 0.05;
    const faster = r.deltaP50Ms < 0;
    const fired = key ? `${key} ${baseCount.toFixed(2)} -> ${armCount.toFixed(2)}` : 'no declared mechanism';
    let verdict: string;
    if (sig && faster) verdict = `WIN — ${sec(-r.deltaP50Ms)} faster at p50, p=${r.rank!.p.toFixed(4)} (${fired})`;
    else if (sig && !faster) verdict = `REGRESSION — ${sec(r.deltaP50Ms)} slower at p50, p=${r.rank!.p.toFixed(4)} (${fired})`;
    else verdict = `NO MEASURABLE WIN — ${fired}, but latency did not move (p=${r.rank ? r.rank.p.toFixed(3) : '—'})`;

    const unreliable = r.rank && !r.rank.reliable ? '  [n too small for the approximation]' : '';
    // Compare the ROUNDED figures the message prints. Flagging 94.7% vs 95.0%
    // as a fall renders as "fell 95% -> 95%", which reads as a bug in the tool.
    const pct = (v: number): number => Math.round(v * 100);
    const broke = r.passRate !== null && base.passRate !== null && pct(r.passRate) < pct(base.passRate)
      ? `  [!] pass rate fell ${pct(base.passRate)}% -> ${pct(r.passRate)}%` : '';
    out.push(`  ${pad(r.arm, w)}${verdict}${unreliable}${broke}`);
  }
  return out.join('\n');
}

// ---- Per-case breakdown ----------------------------------------------------

/**
 * The pooled matrix mixes cases with very different floors — a greeting and a
 * two-turn recall question do not cost the same — so between-case spread ends
 * up in the variance of every arm and swamps a real but modest effect.
 *
 * This stratifies by case: within one case, arms are directly comparable. The
 * rank-sum stays on the pooled numbers (the honest whole-suite answer); this
 * view is for seeing WHERE an effect lives, and for noticing an arm that helps
 * one case and hurts another — which the pooled median would net to nothing.
 */
export interface CaseRow {
  caseId: string;
  /** arm -> p50 time-to-first-word for that case, in ms. */
  p50ByArm: Record<string, number>;
  /** arm -> samples contributing. Small numbers here are the point, not a bug. */
  nByArm: Record<string, number>;
}

export function caseBreakdown(
  runs: Array<{ arm?: string; caseId?: string; sample?: SpeedSample }>,
  arms: string[],
): CaseRow[] {
  const byCase = new Map<string, Map<string, number[]>>();
  for (const r of runs) {
    if (!r.caseId || !r.arm || !r.sample) continue;
    if (!arms.includes(r.arm)) continue;
    const perArm = byCase.get(r.caseId) ?? new Map<string, number[]>();
    const vals = perArm.get(r.arm) ?? [];
    for (const e of r.sample.exchanges) {
      if (e.timeToFirstWordMs !== null) vals.push(e.timeToFirstWordMs);
    }
    perArm.set(r.arm, vals);
    byCase.set(r.caseId, perArm);
  }

  return [...byCase.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([caseId, perArm]) => ({
    caseId,
    p50ByArm: Object.fromEntries(arms.map((a) => [a, stats(perArm.get(a) ?? []).p50])),
    nByArm: Object.fromEntries(arms.map((a) => [a, (perArm.get(a) ?? []).length])),
  }));
}

export function renderCaseBreakdown(rows: CaseRow[], arms: string[]): string {
  if (rows.length === 0) return 'no per-case data';
  // Width from the rendered label, not the bare id — the `(n=…)` suffix
  // overflows the column otherwise and shunts every arm one cell right.
  const label = (r: CaseRow): string => `${r.caseId} (n=${r.nByArm[arms[0]] ?? 0})`;
  const w = Math.max(20, ...rows.map((r) => label(r).length + 2));
  const colw = Math.max(10, ...arms.map((a) => a.length + 2));
  const out = [
    'time to first word, p50 by case (delta vs the first arm in brackets)',
    pad('case', w) + arms.map((a) => pad(a, colw)).join(''),
    '-'.repeat(w + colw * arms.length),
  ];
  const base = arms[0];
  for (const r of rows) {
    let line = pad(label(r), w);
    for (const a of arms) {
      const v = r.p50ByArm[a];
      if (!Number.isFinite(v)) { line += pad('—', colw); continue; }
      const cell = a === base
        ? `${(v / 1000).toFixed(1)}s`
        : `${(v / 1000).toFixed(1)}s[${v - r.p50ByArm[base] > 0 ? '+' : ''}${((v - r.p50ByArm[base]) / 1000).toFixed(1)}]`;
      line += pad(cell, colw);
    }
    out.push(line);
  }

  // Sign summary: in how many cases did each arm beat the baseline? With five
  // cases this is weak evidence on its own, but a 5/5 or 0/5 split says
  // something a single pooled median cannot.
  out.push('', 'cases where the arm beat the baseline:');
  for (const a of arms.slice(1)) {
    const compared = rows.filter((r) => Number.isFinite(r.p50ByArm[a]) && Number.isFinite(r.p50ByArm[base]));
    const wins = compared.filter((r) => r.p50ByArm[a] < r.p50ByArm[base]).length;
    out.push(`  ${pad(a, colw)}${wins}/${compared.length}`);
  }
  return out.join('\n');
}

// ---- Waterfall ------------------------------------------------------------

/**
 * Where the wait goes, averaged per sample, per arm.
 *
 * Means rather than medians here on purpose: the phases are being presented as
 * a budget that adds up to the whole, and medians of components do not sum to
 * the median of the total. The p50 in the matrix is the number to quote for
 * "how long does it take"; this table is for "what is it made of".
 */
export function renderWaterfall(arms: Array<{ label: string; samples: SpeedSample[] }>): string {
  const rows = arms.map(({ label, samples }) => {
    const w = samples.map((s) => s.waterfall).filter((x): x is NonNullable<typeof x> => x !== null);
    const mean = (pick: (x: NonNullable<SpeedSample['waterfall']>) => number): number =>
      w.length ? w.reduce((a, x) => a + pick(x), 0) / w.length : NaN;
    return {
      label,
      n: w.length,
      dispatch: mean((x) => x.dispatchMs),
      ttft: mean((x) => x.ttftMs),
      generate: mean((x) => x.generateMs),
      tool: mean((x) => x.toolMs),
      unaccounted: mean((x) => x.unaccountedMs),
      inferences: mean((x) => x.inferences),
    };
  });

  const w = Math.max(14, ...rows.map((r) => r.label.length + 1));
  const out = [
    'where the wait goes (mean seconds per sample, first exchange)',
    pad('arm', w) + pad('n', 5) + pad('dispatch', 10) + pad('think/ttft', 12) + pad('stream', 9) +
      pad('tools', 8) + pad('other', 8) + pad('total', 9) + 'inferences',
    '-'.repeat(w + 61),
  ];
  for (const r of rows) {
    const total = r.dispatch + r.ttft + r.generate + r.tool + r.unaccounted;
    out.push(
      pad(r.label, w) + pad(String(r.n), 5) +
      pad(sec(r.dispatch), 10) + pad(sec(r.ttft), 12) + pad(sec(r.generate), 9) +
      pad(sec(r.tool), 8) + pad(sec(r.unaccounted), 8) + pad(sec(total), 9) + f1(r.inferences),
    );
  }

  const base = rows[0];
  if (base && Number.isFinite(base.ttft)) {
    const total = base.dispatch + base.ttft + base.generate + base.tool + base.unaccounted;
    const pct = (v: number): string => `${Math.round((v / total) * 100)}%`;
    out.push('', `${base.label} share: think/ttft ${pct(base.ttft)}, stream ${pct(base.generate)}, ` +
      `dispatch ${pct(base.dispatch)}, tools ${pct(base.tool)}, other ${pct(base.unaccounted)}`);
  }
  return out.join('\n');
}
