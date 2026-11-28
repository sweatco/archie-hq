/**
 * Report the per-case change of each candidate arm against base, from the JSON
 * results of a paired promptfoo run:
 *
 *   npx tsx tools/evals/promptfoo/compare.ts <results.json> [--base <label>]
 *     [--baseline <results.json> --base-ref <commit>] [--out-dir <dir>]
 *
 * promptfoo shows the arms side by side but computes no change between them.
 * This groups the trials by case and arm and reports how the candidate's pass
 * rates and measures differ from base. The differences are raw: no noise floor
 * or tolerance is applied, and there is no pass mark.
 *
 * `--baseline` takes the base arm from an earlier run instead of running it
 * again. A case reuses those trials only when they ran on `--base-ref`, the
 * case and its assertions are unchanged, and the models and the SDK version
 * match the candidate's; otherwise the case is reported as needing a base run
 * and the command exits 3.
 *
 * The report holds counts, rates and the assertions' own text, never message
 * or tool text. It goes to `--out-dir`, by default the ignored eval-reports/
 * in this checkout, as JSON and Markdown; the Markdown is also printed.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { z } from 'zod';

const USAGE =
  'Usage: npx tsx tools/evals/promptfoo/compare.ts <results.json> [--base <label>] ' +
  '[--baseline <results.json> --base-ref <commit>] [--out-dir <dir>]';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'eval-reports');

/** Exit code when a baseline could not stand in for a base run. */
const EXIT_BASE_RUN_NEEDED = 3;

// ---- promptfoo results (the fields this script reads) ----

const assertionSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  threshold: z.number().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const resultSchema = z.object({
  provider: z.object({ id: z.string().optional(), label: z.string().optional() }),
  success: z.boolean(),
  cost: z.number().nullish(),
  testCase: z.object({
    description: z.string().optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    assert: z.array(z.unknown()).optional(),
  }),
  gradingResult: z
    .object({
      componentResults: z
        .array(z.object({ pass: z.boolean(), assertion: assertionSchema.nullish() }))
        .optional(),
    })
    .nullish(),
  response: z
    .object({
      metadata: z
        .object({
          record: z.object({
            terminalState: z.string(),
            toolCalls: z.array(z.unknown()),
            usage: z.object({ models: z.array(z.string()) }),
          }),
          measures: z.object({ replyCount: z.number(), wordCount: z.number() }),
          live: z.object({ ref: z.string(), sdkVersion: z.string() }).optional(),
        })
        .optional(),
    })
    .nullish(),
});

const resultsFileSchema = z.object({
  evalId: z.string().optional(),
  results: z.object({ results: z.array(resultSchema) }),
});

// ---- Trials ----

export interface Trial {
  arm: string;
  caseId: string;
  /** Changes when the case's vars or assertions change. */
  caseHash: string;
  /**
   * True when the provider returned a record, whether or not its assertions
   * passed. False for a trial that did not run or broke before it had one.
   * promptfoo sets `error` on a failed assertion too, so that field says nothing here.
   */
  graded: boolean;
  passed: boolean;
  checks: { name: string; pass: boolean }[];
  costUsd: number | null;
  replyCount?: number;
  wordCount?: number;
  toolCallCount?: number;
  terminalState?: string;
  ref?: string;
  sdkVersion?: string;
  models?: string[];
}

/** Read the trials out of promptfoo's JSON results text. */
export function readTrials(resultsJson: string): Trial[] {
  const file = resultsFileSchema.parse(JSON.parse(resultsJson));
  return file.results.results.map((result) => {
    const { vars = {}, assert = [], description } = result.testCase;
    const metadata = result.response?.metadata;
    const caseId = typeof vars.caseId === 'string' && vars.caseId ? vars.caseId : description;
    return {
      arm: result.provider.label ?? result.provider.id ?? 'unknown',
      caseId: caseId ?? 'unnamed case',
      caseHash: hashCase(vars, assert),
      graded: metadata !== undefined,
      passed: result.success,
      checks: (result.gradingResult?.componentResults ?? []).flatMap((component) =>
        component.assertion ? [{ name: nameCheck(component.assertion), pass: component.pass }] : [],
      ),
      costUsd: result.cost ?? null,
      ...(metadata && {
        replyCount: metadata.measures.replyCount,
        wordCount: metadata.measures.wordCount,
        toolCallCount: metadata.record.toolCalls.length,
        terminalState: metadata.record.terminalState,
        models: [...metadata.record.usage.models].sort(),
        ref: metadata.live?.ref,
        sdkVersion: metadata.live?.sdkVersion,
      }),
    };
  });
}

function hashCase(vars: Record<string, unknown>, assertions: unknown[]): string {
  const canonical = JSON.stringify(sortKeys({ vars, assertions }));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** Key order must not change a hash, so objects are rebuilt with sorted keys. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
}

/**
 * `called(tool=get_order)`, `turnReply(turn=2, contains=[36])`, `contains 84.5`,
 * `cost <= 1`: enough to tell a case's checks apart.
 */
function nameCheck(assertion: z.infer<typeof assertionSchema>): string {
  const { type, value, threshold, config } = assertion;
  const grader = typeof value === 'string' ? /^file:\/\/.+:(\w+)$/.exec(value)?.[1] : undefined;
  const options = Object.entries(config ?? {})
    .map(([key, option]) => `${key}=${showValue(option)}`)
    .join(', ');
  if (grader) return `${grader}(${options})`;

  const isShown = typeof value === 'string' || typeof value === 'number' || Array.isArray(value);
  const limit = threshold === undefined ? '' : ` <= ${threshold}`;
  return `${type}${isShown ? ` ${showValue(value)}` : ''}${limit}`;
}

function showValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

// ---- Comparison ----

export interface ArmSummary {
  /** Graded trials. */
  trials: number;
  /** Trials with no record: not started (spend cap) or failed before grading. */
  notGraded: number;
  /** Graded trials in which every assertion passed. */
  passed: number;
  checks: { name: string; passed: number }[];
  meanCostUsd: number | null;
  meanReplies: number | null;
  meanWords: number | null;
  meanToolCalls: number | null;
  terminalStates: Record<string, number>;
  refs: string[];
  sdkVersions: string[];
  models: string[];
}

/** Candidate minus base; a rate is a share of graded trials, from -1 to 1. */
export interface Change {
  passRate: number;
  checks: { name: string; baseRate: number; candidateRate: number; change: number }[];
  meanCostUsd: number | null;
  meanReplies: number | null;
  meanWords: number | null;
  meanToolCalls: number | null;
}

export type CaseOutcome =
  | { status: 'compared'; change: Change }
  /** An arm has no graded trial of the case. */
  | { status: 'not_comparable'; reason: string }
  /** The baseline cannot stand in for a base run of the case. */
  | { status: 'base_run_needed'; reason: string };

export interface CaseComparison {
  caseId: string;
  candidate: string;
  base: ArmSummary;
  candidateArm: ArmSummary;
  outcome: CaseOutcome;
  /** Ways the two arms differ that the change itself may or may not intend. */
  notes: string[];
}

export interface Comparison {
  base: string;
  /** Where the base trials came from. */
  baseSource: 'same run' | 'baseline';
  cases: CaseComparison[];
  /** Graded trials and their recorded cost, per arm that ran in these results. */
  spend: { arm: string; trials: number; costUsd: number }[];
}

export interface CompareOptions {
  base: string;
  /** Base-arm trials of an earlier run, with the commit they must have run on. */
  baseline?: { trials: Trial[]; ref: string };
}

export function compareTrials(trials: Trial[], options: CompareOptions): Comparison {
  const { base, baseline } = options;
  const ownBase = trials.filter((trial) => trial.arm === base);
  if (baseline && ownBase.length > 0) {
    throw new Error(`the results already hold "${base}" trials; drop --baseline to use them`);
  }
  const baseTrials = baseline ? baseline.trials.filter((trial) => trial.arm === base) : ownBase;
  const candidateTrials = trials.filter((trial) => trial.arm !== base);
  const candidates = unique(candidateTrials.map((trial) => trial.arm));
  if (candidates.length === 0) throw new Error(`the results hold no arm besides "${base}"`);

  const cases: CaseComparison[] = [];
  for (const candidate of candidates) {
    const ofCandidate = candidateTrials.filter((trial) => trial.arm === candidate);
    for (const caseId of unique(ofCandidate.map((trial) => trial.caseId))) {
      cases.push(
        compareCase(
          caseId,
          candidate,
          baseTrials.filter((trial) => trial.caseId === caseId),
          ofCandidate.filter((trial) => trial.caseId === caseId),
          baseline?.ref,
        ),
      );
    }
  }

  // A reused baseline was paid for by its own run, so it is not part of this run's spend.
  const spent = baseline ? candidateTrials : [...ownBase, ...candidateTrials];
  return {
    base,
    baseSource: baseline ? 'baseline' : 'same run',
    cases,
    spend: unique(spent.map((trial) => trial.arm)).map((arm) => {
      const ofArm = spent.filter((trial) => trial.arm === arm);
      return {
        arm,
        trials: ofArm.filter((trial) => trial.graded).length,
        costUsd: ofArm.reduce((sum, trial) => sum + (trial.costUsd ?? 0), 0),
      };
    }),
  };
}

function compareCase(
  caseId: string,
  candidate: string,
  baseTrials: Trial[],
  candidateTrials: Trial[],
  baselineRef: string | undefined,
): CaseComparison {
  const base = summarizeArm(baseTrials);
  const candidateArm = summarizeArm(candidateTrials);
  const differences = describeDifferences(base, candidateArm);
  const arms = { caseId, candidate, base, candidateArm };

  if (baselineRef !== undefined) {
    const refusal = refuseBaseline(baseTrials, candidateTrials, base, baselineRef, differences);
    if (refusal) {
      return { ...arms, outcome: { status: 'base_run_needed', reason: refusal }, notes: [] };
    }
  }
  // In one run a difference may be the change under test, so it is noted, not refused.
  const notes = baselineRef === undefined ? differences : [];
  const emptyArm = base.trials === 0 ? 'base' : candidateArm.trials === 0 ? 'candidate' : undefined;
  if (emptyArm) {
    const reason = `no graded ${emptyArm} trial`;
    return { ...arms, outcome: { status: 'not_comparable', reason }, notes };
  }
  return {
    ...arms,
    outcome: { status: 'compared', change: measureChange(base, candidateArm) },
    notes,
  };
}

function measureChange(base: ArmSummary, candidate: ArmSummary): Change {
  const rate = (passed: number, arm: ArmSummary) => passed / arm.trials;
  const candidateChecks = new Map(candidate.checks.map((check) => [check.name, check.passed]));
  return {
    passRate: rate(candidate.passed, candidate) - rate(base.passed, base),
    checks: base.checks.flatMap((check) => {
      const candidatePassed = candidateChecks.get(check.name);
      if (candidatePassed === undefined) return [];
      const baseRate = rate(check.passed, base);
      const candidateRate = rate(candidatePassed, candidate);
      return [{ name: check.name, baseRate, candidateRate, change: candidateRate - baseRate }];
    }),
    meanCostUsd: difference(candidate.meanCostUsd, base.meanCostUsd),
    meanReplies: difference(candidate.meanReplies, base.meanReplies),
    meanWords: difference(candidate.meanWords, base.meanWords),
    meanToolCalls: difference(candidate.meanToolCalls, base.meanToolCalls),
  };
}

/** Why an earlier run's base trials cannot stand in for a base run of this case. */
function refuseBaseline(
  baseTrials: Trial[],
  candidateTrials: Trial[],
  base: ArmSummary,
  baselineRef: string,
  differences: string[],
): string | undefined {
  if (base.trials === 0) return 'the baseline has no graded trial of this case';
  if (base.refs.length !== 1 || base.refs[0] !== baselineRef) {
    return `the baseline ran on ${base.refs.join(', ') || 'an unknown ref'}, not ${baselineRef}`;
  }
  const caseHashes = unique([...baseTrials, ...candidateTrials].map((trial) => trial.caseHash));
  if (caseHashes.length !== 1) return 'the case or its assertions changed since the baseline';
  // Models and SDK version: a baseline is only a fair base if it ran with what runs today.
  return differences[0];
}

function describeDifferences(base: ArmSummary, candidate: ArmSummary): string[] {
  const differences: string[] = [];
  const list = (values: string[]) => values.join(', ') || 'unknown';
  if (list(base.models) !== list(candidate.models)) {
    differences.push(
      `models differ: base ${list(base.models)}, candidate ${list(candidate.models)}`,
    );
  }
  if (list(base.sdkVersions) !== list(candidate.sdkVersions)) {
    differences.push(
      `SDK versions differ: base ${list(base.sdkVersions)}, candidate ${list(candidate.sdkVersions)}`,
    );
  }
  return differences;
}

function summarizeArm(trials: Trial[]): ArmSummary {
  const graded = trials.filter((trial) => trial.graded);
  const checkNames = unique(graded.flatMap((trial) => trial.checks.map((check) => check.name)));
  const terminalStates: Record<string, number> = {};
  for (const trial of graded) {
    const state = trial.terminalState ?? 'unknown';
    terminalStates[state] = (terminalStates[state] ?? 0) + 1;
  }
  return {
    trials: graded.length,
    notGraded: trials.length - graded.length,
    passed: graded.filter((trial) => trial.passed).length,
    checks: checkNames.map((name) => ({
      name,
      passed: graded.filter((trial) => trial.checks.some((c) => c.name === name && c.pass)).length,
    })),
    meanCostUsd: mean(graded.map((trial) => trial.costUsd)),
    meanReplies: mean(graded.map((trial) => trial.replyCount)),
    meanWords: mean(graded.map((trial) => trial.wordCount)),
    meanToolCalls: mean(graded.map((trial) => trial.toolCallCount)),
    terminalStates,
    refs: unique(graded.flatMap((trial) => trial.ref ?? [])).sort(),
    sdkVersions: unique(graded.flatMap((trial) => trial.sdkVersion ?? [])).sort(),
    models: unique(graded.flatMap((trial) => trial.models ?? [])).sort(),
  };
}

/** Mean of the measured values; null when none was measured, so a gap never reads as zero. */
function mean(values: (number | null | undefined)[]): number | null {
  const measured = values.filter((value) => typeof value === 'number');
  if (measured.length === 0) return null;
  return measured.reduce((sum, value) => sum + value, 0) / measured.length;
}

function difference(candidate: number | null, base: number | null): number | null {
  return candidate === null || base === null ? null : candidate - base;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ---- Report ----

export function renderMarkdown(comparison: Comparison): string {
  const reused =
    comparison.baseSource === 'baseline' ? ' Base trials come from an earlier run.' : '';
  const lines = [
    `# Change against \`${comparison.base}\``,
    '',
    `Candidate minus base, per case. Differences are raw: no noise floor is applied and there is no pass mark.${reused}`,
    '',
    '| Case | Arm | Trials (base, candidate) | Passed (base, candidate) | Pass rate | Cost | Replies | Words | Tool calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of comparison.cases) {
    const { base, candidateArm, outcome } = item;
    const cells =
      outcome.status === 'compared'
        ? [
            signed(outcome.change.passRate * 100, 0, ' pp'),
            signed(outcome.change.meanCostUsd, 3, ' USD'),
            signed(outcome.change.meanReplies, 1),
            signed(outcome.change.meanWords, 1),
            signed(outcome.change.meanToolCalls, 1),
          ]
        : [
            outcome.status === 'base_run_needed'
              ? `base run needed: ${outcome.reason}`
              : outcome.reason,
            '',
            '',
            '',
            '',
          ];
    lines.push(
      `| ${[
        item.caseId,
        item.candidate,
        `${base.trials}, ${candidateArm.trials}`,
        `${base.passed}, ${candidateArm.passed}`,
        ...cells,
      ].join(' | ')} |`,
    );
  }

  const movedChecks = comparison.cases.flatMap((item) =>
    (item.outcome.status === 'compared' ? item.outcome.change.checks : [])
      .filter((check) => check.change !== 0)
      .map(
        (check) =>
          // A regex check's name holds `|`, which would end the table cell even inside a code span.
          `| ${item.caseId} | ${item.candidate} | \`${check.name.replaceAll('|', '\\|')}\` | ${percent(check.baseRate)} | ${percent(check.candidateRate)} | ${signed(check.change * 100, 0, ' pp')} |`,
      ),
  );
  lines.push('', '## Checks whose pass rate changed', '');
  if (movedChecks.length === 0) lines.push('None.');
  else {
    lines.push(
      '| Case | Arm | Check | Base | Candidate | Change |',
      '| --- | --- | --- | --- | --- | --- |',
      ...movedChecks,
    );
  }

  const notes = comparison.cases.flatMap((item) => {
    const skipped = [
      item.base.notGraded > 0 ? `${item.base.notGraded} base trial(s) not graded` : '',
      item.candidateArm.notGraded > 0
        ? `${item.candidateArm.notGraded} candidate trial(s) not graded`
        : '',
    ].filter(Boolean);
    return [...item.notes, ...skipped].map(
      (note) => `- ${item.caseId} (${item.candidate}): ${note}`,
    );
  });
  if (notes.length > 0) lines.push('', '## Notes', '', ...unique(notes));

  lines.push('', '## Run', '');
  for (const arm of describeArms(comparison)) lines.push(`- ${arm}`);
  const totalUsd = comparison.spend.reduce((sum, arm) => sum + arm.costUsd, 0);
  const perArm = comparison.spend
    .map((arm) => `${arm.arm} $${arm.costUsd.toFixed(2)} over ${arm.trials} trial(s)`)
    .join(', ');
  lines.push(`- Spend: $${totalUsd.toFixed(2)} (${perArm})`);
  return `${lines.join('\n')}\n`;
}

function describeArms(comparison: Comparison): string[] {
  const arms = new Map<string, ArmSummary[]>();
  for (const item of comparison.cases) {
    arms.set(comparison.base, [...(arms.get(comparison.base) ?? []), item.base]);
    arms.set(item.candidate, [...(arms.get(item.candidate) ?? []), item.candidateArm]);
  }
  return [...arms].map(([arm, summaries]) => {
    const list = (pick: (summary: ArmSummary) => string[]) =>
      unique(summaries.flatMap(pick)).sort().join(', ') || 'unknown';
    return `\`${arm}\`: ref ${list((s) => s.refs)}; SDK ${list((s) => s.sdkVersions)}; models ${list((s) => s.models)}`;
  });
}

function signed(value: number | null, digits: number, unit = ''): string {
  if (value === null) return 'n/a';
  const rounded = value.toFixed(digits);
  // A difference that rounds to nothing prints as zero, not as "-0.000".
  if (Number(rounded) === 0) return `${(0).toFixed(digits)}${unit}`;
  return `${Number(rounded) > 0 ? '+' : ''}${rounded}${unit}`;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

// ---- CLI ----

interface Invocation {
  resultsPath: string;
  base: string;
  baseline?: { path: string; ref: string };
  outDir: string;
}

export function parseInvocation(argv: string[]): Invocation {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string', default: 'base' },
      baseline: { type: 'string' },
      'base-ref': { type: 'string' },
      'out-dir': { type: 'string' },
    },
  });
  const [resultsPath, ...extra] = positionals;
  if (!resultsPath || extra.length > 0) throw new Error('expected exactly one results file');
  if ((values.baseline === undefined) !== (values['base-ref'] === undefined)) {
    throw new Error('--baseline and --base-ref go together');
  }
  return {
    resultsPath: resolve(resultsPath),
    base: values.base,
    ...(values.baseline && values['base-ref']
      ? { baseline: { path: resolve(values.baseline), ref: values['base-ref'] } }
      : {}),
    outDir: resolve(values['out-dir'] ?? DEFAULT_OUT_DIR),
  };
}

async function main(): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2));
  } catch (error) {
    console.error(`compare: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { resultsPath, base, baseline, outDir } = invocation;

  const comparison = compareTrials(readTrials(await readFile(resultsPath, 'utf8')), {
    base,
    ...(baseline && {
      baseline: {
        trials: readTrials(await readFile(baseline.path, 'utf8')),
        ref: baseline.ref,
      },
    }),
  });
  const markdown = renderMarkdown(comparison);

  const name = basename(resultsPath, '.json').replace(/^results-/, 'comparison-');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(join(outDir, `${name}.md`), markdown);
  console.log(markdown);
  console.error(`compare: wrote ${join(outDir, name)}.json and .md`);

  const baseRunNeeded = comparison.cases.filter(
    (item) => item.outcome.status === 'base_run_needed',
  );
  if (baseRunNeeded.length > 0) {
    console.error(`compare: ${baseRunNeeded.length} case(s) need a base run; see the report`);
    return EXIT_BASE_RUN_NEEDED;
  }
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`compare: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
