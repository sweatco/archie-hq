import { describe, it, expect } from 'vitest';
import { parseArgs, filterSince, foldRuns } from './measure.js';
import type { SpeedSample } from './metrics.js';

const sample = (taskId: string): SpeedSample => ({
  taskId, exchanges: [], delegations: [], roundTrips: [],
  silentSetupRoundTrips: null, toolMix: {}, usage: null,
  mechanisms: { knowledgeLogFetches: 0, readWithPages: 0, toolSearches: 0, skillLoads: 0 },
  waterfall: null,
  excluded: { overCap: 0, capMs: 300_000 },
});

describe('parseArgs', () => {
  it('reads flags with values and bare flags', () => {
    expect(parseArgs(['--label', 'before', '--json'])).toEqual({ label: 'before', json: true });
  });

  it('treats a flag followed by another flag as a bare flag', () => {
    expect(parseArgs(['--list', '--arm', 'a'])).toEqual({ list: true, arm: 'a' });
  });

  it('collects positionals under _', () => {
    expect(parseArgs(['a.json', 'b.json'])._).toBe('a.json,b.json');
  });
});

describe('filterSince', () => {
  const ids = ['task-20260817-1422-aaa', 'task-20260825-0902-bbb', 'task-20260830-1000-ccc'];

  it('keeps tasks at or after the cutoff date', () => {
    expect(filterSince(ids, '2026-08-25')).toEqual(['task-20260825-0902-bbb', 'task-20260830-1000-ccc']);
  });

  it('returns everything with no cutoff', () => {
    expect(filterSince(ids, undefined)).toEqual(ids);
  });

  it('drops ids that carry no parseable date rather than guessing', () => {
    expect(filterSince(['task-weird'], '2026-01-01')).toEqual([]);
  });
});

describe('foldRuns', () => {
  const runs = [
    { arm: 'before', sample: sample('t1'), coverage: { events: true, usage: true, transcripts: ['pm'] } },
    { arm: 'after', sample: sample('t2'), coverage: { events: true, usage: true, transcripts: ['pm'] } },
    { arm: 'before', timedOut: true, sample: sample('t3'), coverage: { events: true, usage: false, transcripts: [] } },
  ];

  it('takes only the named arm so one directory can hold both', () => {
    expect(foldRuns(runs, 'before').samples.map((s) => s.taskId)).toEqual(['t1', 't3']);
    expect(foldRuns(runs, 'after').samples.map((s) => s.taskId)).toEqual(['t2']);
  });

  it('keeps timed-out runs and counts them', () => {
    // An arm that answers fast by sometimes not answering is not a fast arm.
    const f = foldRuns(runs, 'before');
    expect(f.samples).toHaveLength(2);
    expect(f.timedOut).toBe(1);
  });

  it('ignores run files with no sample', () => {
    expect(foldRuns([{ arm: 'before' }], 'before').samples).toEqual([]);
  });

  it('carries per-run coverage so a thin arm stays visible', () => {
    expect(foldRuns(runs, 'before').coverage.map((c) => c.transcripts)).toEqual([['pm'], []]);
  });
});
