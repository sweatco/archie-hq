import { describe, it, expect } from 'vitest';
import { stats, aggregate, rankSum, compare, renderComparison, renderAggregate, armMatrix, renderMatrix } from './report.js';
import type { SpeedSample } from './metrics.js';

const sample = (over: Partial<SpeedSample> = {}): SpeedSample => ({
  taskId: 't',
  exchanges: [],
  delegations: [],
  roundTrips: [],
  silentSetupRoundTrips: null,
  toolMix: {},
  mechanisms: { knowledgeLogFetches: 0, readWithPages: 0, toolSearches: 0, skillLoads: 0 },
  waterfall: null,
  usage: null,
  excluded: { overCap: 0, capMs: 300_000 },
  ...over,
});

const withTtfw = (msValue: number, tier = 'standard', model = 'claude-opus-5'): SpeedSample =>
  sample({
    exchanges: [{
      index: 0, from: 'u', promptPreview: 'p', promptAt: '2026-08-25T09:00:00.000Z',
      firstWordAt: '2026-08-25T09:00:01.000Z', timeToFirstWordMs: msValue, timeToCompletionMs: null,
    }],
    usage: {
      models: [model], speedTiers: [tier], outputTokens: 100,
      cacheCreationTokens: 10, cacheReadTokens: 20, costUSD: 0.1, costUnpricedRecords: 0,
    },
  });

describe('stats', () => {
  it('uses nearest-rank percentiles', () => {
    const s = stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s.p50).toBe(50);
    expect(s.p90).toBe(90);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(55);
  });

  it('survives an empty list without producing a number', () => {
    expect(stats([]).n).toBe(0);
    expect(Number.isNaN(stats([]).p50)).toBe(true);
  });

  it('drops non-finite values rather than poisoning the mean', () => {
    expect(stats([10, NaN, 30]).mean).toBe(20);
  });
});

describe('aggregate', () => {
  it('pools exchanges, trips, hops and tokens across samples', () => {
    const a = aggregate([
      sample({
        exchanges: [{ index: 0, from: 'u', promptPreview: '', promptAt: '', firstWordAt: '', timeToFirstWordMs: 20_000, timeToCompletionMs: 40_000 }],
        roundTrips: [
          { agentKey: 'pm', tools: ['Read'], roundTripMs: 6_000, ordinal: 0, atMs: 1, silentSetup: true },
          { agentKey: 'pm', tools: ['Skill'], roundTripMs: 8_000, ordinal: 1, atMs: 2, silentSetup: true },
        ],
        silentSetupRoundTrips: 2,
        delegations: [{ agent: 'archie-agent', dispatchedAt: '', dispatchToActiveMs: 0, activeToFirstOutputMs: 27_000 }],
        toolMix: { Read: 1, Skill: 1 },
      }),
      withTtfw(30_000),
    ]);
    expect(a.samples).toBe(2);
    expect(a.timeToFirstWordMs.n).toBe(2);
    // Nearest-rank on [20000, 30000]: ceil(0.5 * 2) = 1 -> the lower value.
    expect(a.timeToFirstWordMs.p50).toBe(20_000);
    expect(a.roundTripMs.n).toBe(2);
    // One sample delegated, one did not: [0, 1] -> nearest-rank p50 is 0.
    expect(a.delegationHops.p50).toBe(0);
    expect(a.delegationHops.max).toBe(1);
    expect(a.activeToFirstOutputMs.p50).toBe(27_000);
    expect(a.toolMix).toEqual({ Read: 1, Skill: 1 });
  });

  it('carries excluded round trips and unpriced records into the roll-up', () => {
    const a = aggregate([
      sample({ excluded: { overCap: 3, capMs: 300_000 } }),
      sample({ usage: { models: ['openai/x'], speedTiers: [], outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0, costUnpricedRecords: 2 } }),
    ]);
    expect(a.excludedOverCap).toBe(3);
    expect(a.unpricedRecords).toBe(2);
  });
});

describe('rankSum', () => {
  it('finds a clear separation significant', () => {
    const slow = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39];
    const fast = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const r = rankSum(slow, fast)!;
    expect(r.p).toBeLessThan(0.001);
    expect(r.probBFaster).toBe(1);
    expect(r.reliable).toBe(true);
  });

  it('finds identical arms not significant', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const r = rankSum(xs, [...xs])!;
    expect(r.p).toBeGreaterThan(0.9);
    expect(r.probBFaster).toBeCloseTo(0.5, 5);
  });

  it('flags small arms as unreliable but still reports direction', () => {
    const r = rankSum([30, 31, 32], [10, 11, 12])!;
    expect(r.reliable).toBe(false);
    expect(r.probBFaster).toBe(1);
  });

  it('corrects for ties instead of overstating significance', () => {
    // Every value identical: no ranking information whatsoever.
    const r = rankSum([5, 5, 5, 5], [5, 5, 5, 5])!;
    expect(r.p).toBe(1);
    expect(r.probBFaster).toBe(0.5);
  });

  it('returns null when an arm is empty', () => {
    expect(rankSum([], [1, 2, 3])).toBeNull();
  });
});

describe('compare', () => {
  const mk = (values: number[], tier = 'standard', model = 'claude-opus-5'): SpeedSample[] =>
    values.map((v) => withTtfw(v, tier, model));

  it('refuses a comparison across serving tiers', () => {
    const b = mk([30_000, 31_000], 'standard');
    const a = mk([12_000, 13_000], 'fast');
    const c = compare(aggregate(b), aggregate(a), b, a);
    expect(c.blocking[0]).toMatch(/serving tier differs/);
    expect(c.timeToFirstWord).toBeNull();
    expect(renderComparison(c)).toMatch(/COMPARISON REFUSED/);
  });

  it('refuses a comparison across models', () => {
    const b = mk([30_000], 'standard', 'claude-opus-5');
    const a = mk([12_000], 'standard', 'openai/gpt-5.6-sol');
    expect(compare(aggregate(b), aggregate(a), b, a).blocking[0]).toMatch(/models differ/);
  });

  it('runs the test when tier and model match', () => {
    const b = mk(Array.from({ length: 10 }, (_, i) => 30_000 + i * 100));
    const a = mk(Array.from({ length: 10 }, (_, i) => 12_000 + i * 100));
    const c = compare(aggregate(b), aggregate(a), b, a);
    expect(c.blocking).toEqual([]);
    expect(c.timeToFirstWord!.p).toBeLessThan(0.001);
    expect(c.deltaP50.timeToFirstWordMs).toBeLessThan(0);
    expect(renderComparison(c)).toMatch(/faster/);
  });

  it('warns rather than blocks on an underpowered run', () => {
    const b = mk([30_000, 31_000]);
    const a = mk([12_000, 13_000]);
    const c = compare(aggregate(b), aggregate(a), b, a);
    expect(c.blocking).toEqual([]);
    expect(c.warnings.join(' ')).toMatch(/underpowered/);
  });

  it('warns when a tier is unknown so parity is not silently assumed', () => {
    const b = [sample({ exchanges: [{ index: 0, from: 'u', promptPreview: '', promptAt: '', firstWordAt: '', timeToFirstWordMs: 100, timeToCompletionMs: null }] })];
    const c = compare(aggregate(b), aggregate(b), b, b);
    expect(c.warnings.join(' ')).toMatch(/tier parity is unverified/);
  });

  it('surfaces excluded round trips in the warnings', () => {
    const b = [sample({ excluded: { overCap: 2, capMs: 300_000 } })];
    expect(compare(aggregate(b), aggregate(b), b, b).warnings.join(' ')).toMatch(/excluded as over the cap/);
  });
});

describe('renderAggregate', () => {
  it('says cost was omitted rather than implying zero for gateway models', () => {
    const a = aggregate([sample({
      usage: { models: ['openai/gpt-5.6-sol'], speedTiers: ['standard'], outputTokens: 5, cacheCreationTokens: 1, cacheReadTokens: 1, costUSD: 0, costUnpricedRecords: 3 },
    })]);
    expect(renderAggregate('arm', a)).toMatch(/cost omitted, not zero/);
  });

  it('prints an em dash for a metric with no measurements', () => {
    expect(renderAggregate('arm', aggregate([sample()]))).toMatch(/time to first word\s+0\s+—/);
  });
});

describe('armMatrix / renderMatrix', () => {
  const mk = (
    label: string, ttfw: number[], mech: Partial<SpeedSample['mechanisms']>,
  ): { label: string; samples: SpeedSample[] } => ({
    label,
    samples: ttfw.map((v) => sample({
      exchanges: [{ index: 0, from: 'u', promptPreview: '', promptAt: '', firstWordAt: '', timeToFirstWordMs: v, timeToCompletionMs: null }],
      silentSetupRoundTrips: 3,
      mechanisms: { knowledgeLogFetches: 0, readWithPages: 0, toolSearches: 0, skillLoads: 0, ...mech },
      usage: { models: ['claude-opus-5'], speedTiers: ['standard'], outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 1, costUSD: 0, costUnpricedRecords: 0 },
    })),
  });

  const slow = Array.from({ length: 10 }, (_, i) => 30_000 + i * 100);
  const fast = Array.from({ length: 10 }, (_, i) => 20_000 + i * 100);
  const base = mk('baseline', slow, { toolSearches: 1, knowledgeLogFetches: 1 });

  it('calls a real, significant improvement a WIN and names the mechanism', () => {
    const out = renderMatrix(armMatrix([base, mk('t2-alwaysload', fast, { toolSearches: 0, knowledgeLogFetches: 1 })]));
    expect(out).toMatch(/t2-alwaysload\s+WIN — 10\.0s faster/);
    expect(out).toMatch(/toolSearches 1\.00 -> 0\.00/);
  });

  it('separates a fired-but-useless tweak from one whose flag never took', () => {
    const fired = armMatrix([base, mk('t2-alwaysload', slow, { toolSearches: 0, knowledgeLogFetches: 1 })]);
    expect(renderMatrix(fired)).toMatch(/NO MEASURABLE WIN — toolSearches 1\.00 -> 0\.00, but latency did not move/);

    const inert = armMatrix([base, mk('t2-alwaysload', slow, { toolSearches: 1, knowledgeLogFetches: 1 })]);
    expect(renderMatrix(inert)).toMatch(/MECHANISM DID NOT FIRE/);
  });

  it('refuses to score an arm whose target behaviour is absent from the baseline', () => {
    // This is the first campaign round: zero Read-with-pages anywhere, because
    // the PM reaches for `Bash cat`. Scoring that as a negative would retire a
    // fix for a bug that simply is not on this build.
    const rows = armMatrix([base, mk('t1-pages', fast, { readWithPages: 0, toolSearches: 1 })]);
    const out = renderMatrix(rows);
    expect(out).toMatch(/t1-pages\s+NO TARGET/);
    expect(out).toMatch(/Not a negative result/);
  });

  it('calls a significant slowdown a REGRESSION', () => {
    const rows = armMatrix([base, mk('t5-lean', slow.map((v) => v + 15_000), {})]);
    expect(renderMatrix(rows)).toMatch(/t5-lean\s+REGRESSION/);
  });

  it('scores an arm with no declared mechanism on latency alone', () => {
    const rows = armMatrix([base, mk('t3-effort', fast, {})]);
    expect(renderMatrix(rows)).toMatch(/t3-effort\s+WIN .*no declared mechanism/);
  });

  it('flags an arm that got faster by breaking cases', () => {
    const rows = armMatrix([base, mk('t3-effort', fast, {})], { baseline: 1, 't3-effort': 0.5 });
    expect(renderMatrix(rows)).toMatch(/pass rate fell 100% -> 50%/);
  });

  it('marks an arm invalid rather than scoring it when the tier differs', () => {
    const other = mk('t3-effort', fast, {});
    other.samples.forEach((s) => { s.usage!.speedTiers = ['fast']; });
    expect(renderMatrix(armMatrix([base, other]))).toMatch(/t3-effort\s+INVALID — serving tier differs/);
  });

  it('averages mechanism counts per sample so arms of different size compare', () => {
    const rows = armMatrix([base, mk('t4-knowledge', fast, { knowledgeLogFetches: 0, toolSearches: 1 })]);
    expect(rows[0].mechanisms.knowledgeLogFetches).toBe(1);
    expect(rows[1].mechanisms.knowledgeLogFetches).toBe(0);
  });
});
