import { describe, expect, it } from 'vitest';
import { expectDefined } from '../../../src/test-support/assertions.js';
import {
  compareTrials,
  parseInvocation,
  readTrials,
  renderMarkdown,
  type CaseComparison,
  type Change,
} from './compare.js';

interface TrialSpec {
  arm: string;
  caseId?: string;
  /** Whether the `called` check passed; the terminal-state check always passes. */
  called?: boolean;
  costUsd?: number;
  words?: number;
  toolCalls?: number;
  ref?: string;
  models?: string[];
  sdkVersion?: string;
  /** A provider error: the trial has no record. */
  providerError?: string;
  /** Extra assertion, to change the case's hash. */
  extraAssertion?: boolean;
}

const TERMINAL_STATE = {
  type: 'javascript',
  value: 'file://assertions.ts:terminalState',
  config: { state: 'completed' },
};
const CALLED = {
  type: 'javascript',
  value: 'file://assertions.ts:called',
  config: { tool: 'get_order' },
};

/**
 * One row of promptfoo 0.125.1's JSON results. A pass has no `error` and
 * `failureReason` 0; a failed assertion has its reason in `error`,
 * `failureReason` 1 and the response; a provider error has `failureReason` 2
 * and no response or grading.
 */
function result(spec: TrialSpec): unknown {
  const called = spec.called ?? true;
  const caseId = spec.caseId ?? 'orders-lookup';
  const testCase = {
    description: 'Order lookup',
    vars: { caseId, turns: [{ message: 'Look up FH-1001' }] },
    assert: [
      TERMINAL_STATE,
      CALLED,
      ...(spec.extraAssertion ? [{ type: 'cost', threshold: 1 }] : []),
    ],
  };
  const provider = { id: `archie-live:${spec.arm}`, label: spec.arm };
  if (spec.providerError) {
    return {
      provider,
      success: false,
      score: 0,
      cost: 0,
      error: spec.providerError,
      failureReason: 2,
      gradingResult: null,
      testCase,
    };
  }

  const calledReason = called ? 'get_order called 1 time(s)' : 'get_order called 0 time(s)';
  return {
    provider,
    success: called,
    score: called ? 1 : 0,
    cost: spec.costUsd ?? 0.2,
    ...(called ? { failureReason: 0 } : { error: calledReason, failureReason: 1 }),
    testCase,
    gradingResult: {
      pass: called,
      score: called ? 1 : 0,
      reason: called ? 'All assertions passed' : calledReason,
      componentResults: [
        { pass: true, score: 1, reason: 'ended completed', assertion: TERMINAL_STATE },
        { pass: called, score: called ? 1 : 0, reason: calledReason, assertion: CALLED },
      ],
    },
    response: {
      metadata: {
        record: {
          terminalState: 'completed',
          toolCalls: Array.from({ length: spec.toolCalls ?? 2 }, () => ({})),
          usage: { models: spec.models ?? ['claude-opus-5-5'] },
        },
        measures: { replyCount: 1, wordCount: spec.words ?? 40 },
        live: { ref: spec.ref ?? 'aaa1111', sdkVersion: spec.sdkVersion ?? '0.3.321' },
      },
    },
  };
}

function trials(...specs: TrialSpec[]) {
  return readTrials(JSON.stringify({ evalId: 'eval-1', results: { results: specs.map(result) } }));
}

function onlyCase(cases: CaseComparison[]): CaseComparison {
  expect(cases).toHaveLength(1);
  return expectDefined(cases[0]);
}

function changeOf(item: CaseComparison): Change {
  if (item.outcome.status !== 'compared') throw new Error(`not compared: ${item.outcome.reason}`);
  return item.outcome.change;
}

describe('compareTrials', () => {
  it('reports the candidate minus base for pass rates and measures, per case', () => {
    const comparison = compareTrials(
      trials(
        { arm: 'base', costUsd: 0.2, words: 40, toolCalls: 2 },
        { arm: 'base', costUsd: 0.3, words: 60, toolCalls: 2 },
        { arm: 'candidate', called: false, costUsd: 0.1, words: 20, toolCalls: 1, ref: 'bbb2222' },
        { arm: 'candidate', costUsd: 0.2, words: 30, toolCalls: 2, ref: 'bbb2222' },
      ),
      { base: 'base' },
    );

    const item = onlyCase(comparison.cases);
    expect(item).toMatchObject({
      caseId: 'orders-lookup',
      candidate: 'candidate',
      base: { trials: 2, passed: 2, refs: ['aaa1111'] },
      candidateArm: { trials: 2, passed: 1, refs: ['bbb2222'] },
      notes: [],
    });
    const change = changeOf(item);
    expect(change.passRate).toBe(-0.5);
    expect(change.checks).toEqual([
      { name: 'terminalState(state=completed)', baseRate: 1, candidateRate: 1, change: 0 },
      { name: 'called(tool=get_order)', baseRate: 1, candidateRate: 0.5, change: -0.5 },
    ]);
    expect(change.meanCostUsd).toBeCloseTo(-0.1, 10);
    expect(change.meanWords).toBe(-25);
    expect(change.meanToolCalls).toBe(-0.5);
    expect(comparison.baseSource).toBe('same run');
    expect(comparison.spend.map((arm) => [arm.arm, arm.trials])).toEqual([
      ['base', 2],
      ['candidate', 2],
    ]);
  });

  it('counts trials whose assertions failed as graded, so a pass rate can drop', () => {
    const comparison = compareTrials(
      trials(
        { arm: 'base' },
        { arm: 'base' },
        { arm: 'base' },
        { arm: 'candidate' },
        { arm: 'candidate', called: false },
        { arm: 'candidate', called: false },
      ),
      { base: 'base' },
    );

    const item = onlyCase(comparison.cases);
    expect(item.base).toMatchObject({ trials: 3, notGraded: 0, passed: 3 });
    expect(item.candidateArm).toMatchObject({ trials: 3, notGraded: 0, passed: 1 });
    const change = changeOf(item);
    expect(change.passRate).toBeCloseTo(-2 / 3, 10);
    expect(change.checks.map((check) => [check.name, check.candidateRate])).toEqual([
      ['terminalState(state=completed)', 1],
      ['called(tool=get_order)', 1 / 3],
    ]);
  });

  it('compares a case in which every candidate trial failed', () => {
    const comparison = compareTrials(
      trials(
        { arm: 'base' },
        { arm: 'candidate', called: false },
        { arm: 'candidate', called: false },
      ),
      { base: 'base' },
    );

    const item = onlyCase(comparison.cases);
    expect(item.candidateArm).toMatchObject({ trials: 2, notGraded: 0, passed: 0 });
    expect(changeOf(item).passRate).toBe(-1);
  });

  it('leaves trials without a record out of the rates and counts them', () => {
    const comparison = compareTrials(
      trials(
        { arm: 'base' },
        { arm: 'candidate' },
        { arm: 'candidate', providerError: 'spend cap reached' },
      ),
      { base: 'base' },
    );

    const item = onlyCase(comparison.cases);
    expect(item.candidateArm).toMatchObject({ trials: 1, notGraded: 1, passed: 1 });
    expect(changeOf(item).passRate).toBe(0);
  });

  it('states no change for a case with no graded trial in an arm', () => {
    const comparison = compareTrials(
      trials({ arm: 'base', providerError: 'spend cap reached' }, { arm: 'candidate' }),
      { base: 'base' },
    );

    expect(onlyCase(comparison.cases).outcome).toEqual({
      status: 'not_comparable',
      reason: 'no graded base trial',
    });
  });

  it('notes arms that ran different models or SDK versions in one run', () => {
    const comparison = compareTrials(
      trials(
        { arm: 'base' },
        { arm: 'candidate', models: ['claude-sonnet-5-5'], sdkVersion: '0.3.400' },
      ),
      { base: 'base' },
    );

    const item = onlyCase(comparison.cases);
    expect(item.outcome.status).toBe('compared');
    expect(item.notes).toEqual([
      'models differ: base claude-opus-5-5, candidate claude-sonnet-5-5',
      'SDK versions differ: base 0.3.321, candidate 0.3.400',
    ]);
  });

  it('needs an arm besides base', () => {
    expect(() => compareTrials(trials({ arm: 'base' }), { base: 'base' })).toThrow(
      'the results hold no arm besides "base"',
    );
  });
});

describe('compareTrials with a baseline', () => {
  const candidateRun = trials({ arm: 'candidate', called: false, ref: 'bbb2222' });
  const withBaseline = (...baseline: TrialSpec[]) =>
    onlyCase(
      compareTrials(candidateRun, {
        base: 'base',
        baseline: { trials: trials(...baseline), ref: 'aaa1111' },
      }).cases,
    );

  it('reuses base trials that ran on the base ref with the same case, models and SDK', () => {
    const comparison = compareTrials(candidateRun, {
      base: 'base',
      baseline: {
        trials: trials({ arm: 'base' }, { arm: 'candidate', ref: 'ccc3333' }),
        ref: 'aaa1111',
      },
    });

    expect(comparison.baseSource).toBe('baseline');
    expect(changeOf(onlyCase(comparison.cases)).passRate).toBe(-1);
    // The baseline's own run paid for its trials.
    expect(comparison.spend.map((arm) => arm.arm)).toEqual(['candidate']);
  });

  it.each([
    [{ ref: 'old0000' }, 'the baseline ran on old0000, not aaa1111'],
    [{ ref: 'aaa1111-dirty' }, 'the baseline ran on aaa1111-dirty, not aaa1111'],
    [{ extraAssertion: true }, 'the case or its assertions changed since the baseline'],
    [
      { models: ['claude-opus-5-1'] },
      'models differ: base claude-opus-5-1, candidate claude-opus-5-5',
    ],
    [{ sdkVersion: '0.3.300' }, 'SDK versions differ: base 0.3.300, candidate 0.3.321'],
    [{ caseId: 'another-case' }, 'the baseline has no graded trial of this case'],
  ])('asks for a base run when the baseline differs: %o', (difference, reason) => {
    expect(withBaseline({ arm: 'base', ...difference }).outcome).toEqual({
      status: 'base_run_needed',
      reason,
    });
  });

  it('refuses a baseline when the results already hold base trials', () => {
    expect(() =>
      compareTrials(trials({ arm: 'base' }, { arm: 'candidate' }), {
        base: 'base',
        baseline: { trials: trials({ arm: 'base' }), ref: 'aaa1111' },
      }),
    ).toThrow('the results already hold "base" trials');
  });
});

describe('renderMarkdown', () => {
  it('shows the change per case, the checks that moved, and the run', () => {
    const markdown = renderMarkdown(
      compareTrials(
        trials(
          { arm: 'base', costUsd: 0.2 },
          { arm: 'candidate', called: false, costUsd: 0.1, ref: 'bbb2222' },
          { arm: 'candidate', providerError: 'spend cap reached' },
        ),
        { base: 'base' },
      ),
    );

    expect(markdown).toContain(
      '| orders-lookup | candidate | 1, 1 | 1, 0 | -100 pp | -0.100 USD | 0.0 | 0.0 | 0.0 |',
    );
    expect(markdown).toContain(
      '| orders-lookup | candidate | `called(tool=get_order)` | 100% | 0% | -100 pp |',
    );
    expect(markdown).toContain('- orders-lookup (candidate): 1 candidate trial(s) not graded');
    expect(markdown).toContain('- `candidate`: ref bbb2222; SDK 0.3.321; models claude-opus-5-5');
    expect(markdown).toContain('- Spend: $0.30 (base $0.20 over 1 trial(s), candidate $0.10');
  });

  it('prints a difference that rounds to nothing as zero', () => {
    const markdown = renderMarkdown(
      compareTrials(
        trials({ arm: 'base', costUsd: 0.2341 }, { arm: 'candidate', costUsd: 0.2339 }),
        { base: 'base' },
      ),
    );
    expect(markdown).toContain('| 1, 1 | 1, 1 | 0 pp | 0.000 USD | 0.0 | 0.0 | 0.0 |');
  });

  it('says so when no check moved and when a base run is needed', () => {
    const unchanged = renderMarkdown(
      compareTrials(trials({ arm: 'base' }, { arm: 'candidate' }), { base: 'base' }),
    );
    expect(unchanged).toContain('## Checks whose pass rate changed\n\nNone.');

    const stale = renderMarkdown(
      compareTrials(trials({ arm: 'candidate' }), {
        base: 'base',
        baseline: { trials: trials({ arm: 'base', ref: 'old0000' }), ref: 'aaa1111' },
      }),
    );
    expect(stale).toContain('base run needed: the baseline ran on old0000, not aaa1111');
    expect(stale).toContain('Base trials come from an earlier run.');
  });
});

describe('parseInvocation', () => {
  it('defaults the base label and takes a baseline with its ref', () => {
    expect(parseInvocation(['results.json'])).toMatchObject({ base: 'base' });
    expect(
      parseInvocation(['results.json', '--baseline', '/b/results.json', '--base-ref', 'aaa1111']),
    ).toMatchObject({ baseline: { path: '/b/results.json', ref: 'aaa1111' } });
  });

  it('refuses a baseline without the ref it must have run on', () => {
    expect(() => parseInvocation(['results.json', '--baseline', 'b.json'])).toThrow(
      '--baseline and --base-ref go together',
    );
    expect(() => parseInvocation([])).toThrow('expected exactly one results file');
  });
});
