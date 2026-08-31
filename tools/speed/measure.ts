#!/usr/bin/env tsx
/**
 * measure.ts — extract speed metrics from task folders already on disk.
 *
 * Needs no live instance and no re-run: every number comes from records Archie
 * wrote while it worked. That makes a baseline available immediately, from
 * whatever sessions exist, and makes any arm re-readable later under a changed
 * rubric — the same reason the voice harness keeps offline re-grading.
 *
 *   collect   read task folders     -> a samples file (+ a printed roll-up)
 *   fold      read a campaign's runs  -> a samples file for one arm
 *   compare   two samples files       -> per-arm tables and a rank-sum verdict
 *   matrix    a campaign's runs dir    -> every arm against the baseline, one table
 *
 * Usage:
 *   tsx tools/speed/measure.ts collect [--sessions DIR] [--tasks a,b] [--since YYYY-MM-DD]
 *                                      [--label NAME] [--out FILE]
 *   tsx tools/speed/measure.ts fold --runs DIR --arm NAME [--out FILE]
 *   tsx tools/speed/measure.ts compare BEFORE.json AFTER.json
 *   tsx tools/speed/measure.ts matrix --runs DIR [--arms a,b,c] [--resample [DIR]] [--regrade [DIR]]
 */

import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTask, listTaskDirs } from './sources.js';
import { extractSample, type SpeedSample } from './metrics.js';
import { CORE_CASES, gradeCase, stimulusHash, withOverlay, validateCases, type SpeedCase } from './cases.js';
import { aggregate, compare, renderAggregate, renderComparison, armMatrix, renderMatrix, caseBreakdown, renderCaseBreakdown, renderWaterfall } from './report.js';

/** What a samples file holds. Versioned so a later rubric can refuse an old shape. */
export interface SamplesFile {
  schema: 'archie-speed-samples/v1';
  label: string;
  collectedAt: string;
  sessionsDir: string;
  samples: SpeedSample[];
  /** Per-task note on what was actually available, so a thin arm is visible. */
  coverage: Array<{ taskId: string; events: boolean; usage: boolean; transcripts: string[]; skippedLines: number }>;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._ = out._ === undefined ? a : `${out._},${a}`;
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/**
 * Task ids at or after a `YYYY-MM-DD` cutoff.
 *
 * Filters on the date embedded in the id rather than on file mtime — a folder
 * copied off a server carries a fresh mtime and would otherwise slip into an
 * arm it does not belong to.
 */
export function filterSince(taskIds: string[], since: string | undefined): string[] {
  if (!since) return taskIds;
  const cutoff = since.replace(/-/g, '');
  return taskIds.filter((id) => {
    const m = /^task-(\d{8})-/.exec(id);
    return m ? m[1] >= cutoff : false;
  });
}

async function collect(args: Record<string, string | boolean>): Promise<number> {
  const sessionsDir = resolve(
    String(args.sessions ?? process.env.ARCHIE_SESSIONS_DIR ?? join(process.env.ARCHIE_WORKDIR ?? 'workdir', 'sessions')),
  );
  const label = String(args.label ?? 'baseline');

  const explicit = typeof args.tasks === 'string' ? args.tasks.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const discovered = explicit ?? filterSince(await listTaskDirs(sessionsDir), typeof args.since === 'string' ? args.since : undefined);

  if (discovered.length === 0) {
    console.error(`No task folders found under ${sessionsDir}`);
    return 1;
  }

  const samples: SpeedSample[] = [];
  const coverage: SamplesFile['coverage'] = [];
  for (const taskId of discovered) {
    const loaded = await loadTask(join(sessionsDir, taskId), taskId);
    if (!loaded.found.events) continue; // Nothing measurable; not an error.
    samples.push(extractSample(loaded.sources));
    coverage.push({ taskId, ...loaded.found, skippedLines: loaded.skippedLines });
  }

  if (samples.length === 0) {
    console.error(`Found ${discovered.length} folder(s) under ${sessionsDir} but none had shared/events.jsonl`);
    return 1;
  }

  const file: SamplesFile = {
    schema: 'archie-speed-samples/v1',
    label,
    collectedAt: new Date().toISOString(),
    sessionsDir,
    samples,
    coverage,
  };

  const outPath = typeof args.out === 'string' ? resolve(args.out) : null;
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(file, null, 2));
  }

  console.log(renderAggregate(label, aggregate(samples)));

  const thin = coverage.filter((c) => c.transcripts.length === 0).length;
  if (thin > 0) {
    console.log(`\n  ${thin}/${coverage.length} task(s) had no transcript — round-trip metrics come from the rest.`);
  }
  const torn = coverage.reduce((a, c) => a + c.skippedLines, 0);
  if (torn > 0) console.log(`  ${torn} malformed JSONL line(s) skipped.`);
  if (outPath) console.log(`\n  wrote ${samples.length} sample(s) to ${outPath}`);
  return 0;
}

/**
 * Fold a campaign's per-run files into one arm's samples file.
 *
 * Only runs whose `arm` matches are taken, so a results directory holding both
 * arms of an interleaved campaign can be folded twice without cross-contaminating
 * them. Timed-out runs are KEPT: an arm that answers fast by not answering some
 * of the time is slower, not faster, and dropping those runs would hide it.
 */
export function foldRuns(
  runs: Array<{ arm?: string; timedOut?: boolean; sample?: SpeedSample; coverage?: LoadedCoverage }>,
  arm: string,
): { samples: SpeedSample[]; timedOut: number; coverage: SamplesFile['coverage'] } {
  const samples: SpeedSample[] = [];
  const coverage: SamplesFile['coverage'] = [];
  let timedOut = 0;
  for (const r of runs) {
    if (r.arm !== arm || !r.sample) continue;
    samples.push(r.sample);
    if (r.timedOut) timedOut++;
    coverage.push({
      taskId: r.sample.taskId,
      events: r.coverage?.events ?? true,
      usage: r.coverage?.usage ?? false,
      transcripts: r.coverage?.transcripts ?? [],
      skippedLines: 0,
    });
  }
  return { samples, timedOut, coverage };
}

interface LoadedCoverage { events: boolean; usage: boolean; transcripts: string[] }

async function fold(args: Record<string, string | boolean>): Promise<number> {
  const runsDir = resolve(String(args.runs ?? join('tools', 'speed', 'results')));
  const arm = String(args.arm ?? '');
  if (!arm) {
    console.error('fold needs --arm NAME (the arm recorded in each run file)');
    return 1;
  }

  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.startsWith('run-') && n.endsWith('.json'));
  } catch {
    console.error(`Cannot read runs directory ${runsDir}`);
    return 1;
  }

  const runs = [];
  for (const n of names) {
    try {
      runs.push(JSON.parse(await readFile(join(runsDir, n), 'utf8')));
    } catch {
      console.error(`  skipped unreadable run file ${n}`);
    }
  }

  const folded = foldRuns(runs, arm);
  if (folded.samples.length === 0) {
    console.error(`No runs for arm "${arm}" in ${runsDir} (found ${runs.length} run file(s))`);
    return 1;
  }

  const file: SamplesFile = {
    schema: 'archie-speed-samples/v1',
    label: arm,
    collectedAt: new Date().toISOString(),
    sessionsDir: runsDir,
    samples: folded.samples,
    coverage: folded.coverage,
  };
  const outPath = typeof args.out === 'string' ? resolve(args.out) : join(runsDir, `samples-${arm}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(file, null, 2));

  console.log(renderAggregate(arm, aggregate(folded.samples)));
  if (folded.timedOut > 0) {
    console.log(`\n  ${folded.timedOut}/${folded.samples.length} run(s) TIMED OUT and are included — an arm that sometimes never answers is not a fast arm.`);
  }
  console.log(`\n  wrote ${folded.samples.length} sample(s) to ${outPath}`);
  return 0;
}

interface RunFile { arm?: string; caseId?: string; stimulus?: string; timedOut?: boolean; sample?: SpeedSample; coverage?: LoadedCoverage; verdict?: { pass?: boolean } }

/** Fraction of an arm's graded runs that passed. `null` when nothing graded. */
export function passRate(runs: RunFile[], arm: string): number | null {
  const graded = runs.filter((r) => r.arm === arm && r.verdict !== undefined);
  if (graded.length === 0) return null;
  return graded.filter((r) => r.verdict?.pass === true).length / graded.length;
}

async function readRunDir(runsDir: string): Promise<RunFile[]> {
  const names = (await readdir(runsDir)).filter((n) => n.startsWith('run-') && n.endsWith('.json'));
  const runs: RunFile[] = [];
  for (const n of names) {
    try {
      runs.push(JSON.parse(await readFile(join(runsDir, n), 'utf8')) as RunFile);
    } catch {
      console.error(`  skipped unreadable run file ${n}`);
    }
  }
  return runs;
}

/**
 * Re-grade stored runs against the CURRENT rubric.
 *
 * A verdict is baked into a run file at collection time, so a rubric bug is
 * frozen into the evidence alongside the behaviour it misjudged. This reads the
 * events back off disk and re-runs the grader, which is the only way to tell a
 * real regression from a bad detector after the fact — and the detectors were
 * wrong three times out of four on their first outing, failing replies that
 * were exemplary.
 *
 * Returns the runs with fresh verdicts plus a list of every verdict that
 * flipped, so a re-grade can never quietly rewrite history.
 */
export async function regradeRuns(
  runs: RunFile[],
  cases: SpeedCase[],
  sessionsDir: string,
  load = loadTask,
): Promise<{
  runs: RunFile[];
  flipped: Array<{ taskId: string; caseId: string; from: boolean; to: boolean }>;
  ungradable: number;
  staleStimulus: Record<string, number>;
}> {
  const out: RunFile[] = [];
  const flipped: Array<{ taskId: string; caseId: string; from: boolean; to: boolean }> = [];
  const staleStimulus: Record<string, number> = {};
  let ungradable = 0;

  for (const r of runs) {
    const c = cases.find((x) => x.id === r.caseId);
    const taskId = r.sample?.taskId;
    if (!c || !taskId) { out.push(r); ungradable++; continue; }

    // The case's prompt has changed since this run: the stored reply answers a
    // different question. Keep the run, keep its ORIGINAL verdict, and count it
    // — re-grading it would be scoring an answer to a question nobody asked.
    // A run predating the fingerprint cannot be verified either way. Treat that
    // as unverifiable rather than fine: the default that assumed "no hash means
    // no change" silently re-graded 15 runs of a re-worded case and turned a
    // void result into a clean pass.
    if (r.stimulus === undefined || r.stimulus !== stimulusHash(c)) {
      staleStimulus[c.id] = (staleStimulus[c.id] ?? 0) + 1;
      out.push(r);
      continue;
    }
    const loaded = await load(join(sessionsDir, taskId), taskId);
    if (!loaded.found.events) { out.push(r); ungradable++; continue; }

    const sample = extractSample(loaded.sources);
    const verdict = gradeCase(c, sample, loaded.sources.events);
    if (r.verdict?.pass !== undefined && r.verdict.pass !== verdict.pass) {
      flipped.push({ taskId, caseId: c.id, from: r.verdict.pass, to: verdict.pass });
    }
    out.push({ ...r, sample, coverage: loaded.found, verdict });
  }
  return { runs: out, flipped, ungradable, staleStimulus };
}

/**
 * Re-derive each run's sample by re-reading its task folder from disk.
 *
 * A run recorded against an unreadable sessions directory carries only
 * event-level metrics — no round trips, no tool mix, no tokens. The task folder
 * itself is still there, so the richer sample can be rebuilt after the fact
 * rather than the campaign being re-run. Also the way to re-read an old
 * campaign under a changed metric definition.
 *
 * A run whose folder has since been deleted keeps whatever sample it recorded,
 * and is counted in `missing` so a thin arm cannot pass for a complete one.
 */
export async function resampleRuns(
  runs: RunFile[],
  sessionsDir: string,
  load = loadTask,
): Promise<{ runs: RunFile[]; rebuilt: number; missing: string[] }> {
  const out: RunFile[] = [];
  const missing: string[] = [];
  let rebuilt = 0;
  for (const r of runs) {
    const taskId = r.sample?.taskId;
    if (!taskId) { out.push(r); continue; }
    const loaded = await load(join(sessionsDir, taskId), taskId);
    if (!loaded.found.events) { missing.push(taskId); out.push(r); continue; }
    out.push({ ...r, sample: extractSample(loaded.sources), coverage: loaded.found });
    rebuilt++;
  }
  return { runs: out, rebuilt, missing };
}

async function matrix(args: Record<string, string | boolean>): Promise<number> {
  const runsDir = resolve(String(args.runs ?? join('tools', 'speed', 'results')));
  let runs: RunFile[];
  try {
    runs = await readRunDir(runsDir);
  } catch {
    console.error(`Cannot read runs directory ${runsDir}`);
    return 1;
  }

  if (args.regrade) {
    const sessionsDir = resolve(String(
      typeof args.regrade === 'string' ? args.regrade
        : process.env.ARCHIE_SESSIONS_DIR ?? join(process.env.ARCHIE_WORKDIR ?? 'workdir', 'sessions'),
    ));
    const cases = await loadCasesFor(runsDir);
    const re = await regradeRuns(runs, cases, sessionsDir);
    runs = re.runs;
    console.log(`re-graded ${runs.length - re.ungradable}/${runs.length} run(s) against the current rubric`);
    if (re.ungradable > 0) console.log(`  ${re.ungradable} run(s) could not be re-graded (case gone, or task folder missing)`);
    const stale = Object.entries(re.staleStimulus);
    if (stale.length > 0) {
      console.log('  UNVERIFIED STIMULUS — the prompt these runs were given either changed');
      console.log('  since, or predates fingerprinting. Their stored verdicts are kept as-is');
      console.log('  and are NOT comparable with the rest. Re-run them:');
      for (const [k, v] of stale) console.log(`    ${k}: ${v} run(s)`);
    }
    if (re.flipped.length > 0) {
      const gained = re.flipped.filter((f) => f.to).length;
      console.log(`  ${re.flipped.length} verdict(s) changed: ${gained} now pass, ${re.flipped.length - gained} now fail`);
      const byCase: Record<string, number> = {};
      for (const f of re.flipped) byCase[f.caseId] = (byCase[f.caseId] ?? 0) + 1;
      for (const [k, v] of Object.entries(byCase).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
    }
    console.log('');
  }

  if (args.resample) {
    const sessionsDir = resolve(String(
      typeof args.resample === 'string' ? args.resample
        : process.env.ARCHIE_SESSIONS_DIR ?? join(process.env.ARCHIE_WORKDIR ?? 'workdir', 'sessions'),
    ));
    const re = await resampleRuns(runs, sessionsDir);
    runs = re.runs;
    console.log(`resampled ${re.rebuilt}/${runs.length} run(s) from ${sessionsDir}`);
    if (re.missing.length > 0) {
      console.log(`  ${re.missing.length} task folder(s) not found — those runs keep their original, thinner sample`);
    }
    console.log('');
  }
  if (runs.length === 0) {
    console.error(`No run files in ${runsDir}`);
    return 1;
  }

  // Explicit --arms fixes the ORDER, and the first is the baseline every other
  // arm is measured against. Discovered order would be alphabetical, which would
  // silently make whichever arm sorts first the reference.
  const named = typeof args.arms === 'string'
    ? args.arms.split(',').map((a) => a.trim()).filter(Boolean)
    : [...new Set(runs.map((r) => r.arm).filter((a): a is string => !!a))].sort();

  const arms = named.map((label) => ({ label, samples: foldRuns(runs, label).samples }));
  const rates = Object.fromEntries(named.map((label) => [label, passRate(runs, label)]));

  const missing = arms.filter((a) => a.samples.length === 0).map((a) => a.label);
  if (missing.length > 0) console.log(`(no samples yet for: ${missing.join(', ')})\n`);

  console.log(renderMatrix(armMatrix(arms.filter((a) => a.samples.length > 0), rates)));

  const present = arms.filter((a) => a.samples.length > 0).map((a) => a.label);
  console.log('');
  console.log(renderWaterfall(arms.filter((a) => a.samples.length > 0)));
  console.log('');
  console.log(renderCaseBreakdown(caseBreakdown(runs, present), present));

  const timedOut = runs.filter((r) => r.timedOut).length;
  if (timedOut > 0) console.log(`\n${timedOut} run(s) timed out and are included in the numbers above.`);
  console.log(`\n${runs.length} run file(s) in ${runsDir}`);
  return 0;
}

/** Core cases plus any local overlay beside cases.ts. */
async function loadCasesFor(_runsDir: string): Promise<SpeedCase[]> {
  const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
  try {
    const parsed = validateCases(JSON.parse(await readFile(join(here, 'cases.local.json'), 'utf8')));
    if (parsed.ok) return withOverlay(CORE_CASES, parsed.cases);
  } catch {
    // No overlay is the normal case.
  }
  return CORE_CASES;
}

async function readSamples(path: string): Promise<SamplesFile> {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as SamplesFile;
  if (parsed.schema !== 'archie-speed-samples/v1') {
    throw new Error(`${path}: unexpected schema "${parsed.schema}" (want archie-speed-samples/v1)`);
  }
  return parsed;
}

async function runCompare(paths: string[]): Promise<number> {
  if (paths.length !== 2) {
    console.error('compare needs exactly two samples files: compare BEFORE.json AFTER.json');
    return 1;
  }
  const [before, after] = await Promise.all(paths.map(readSamples));
  const c = compare(aggregate(before.samples), aggregate(after.samples), before.samples, after.samples);
  console.log(renderComparison(c, before.label, after.label));
  // A refused comparison is a failed run: it must not pass in CI as if it were
  // a clean result.
  return c.blocking.length > 0 ? 2 : 0;
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let code: number;
  if (mode === 'collect') code = await collect(args);
  else if (mode === 'fold') code = await fold(args);
  else if (mode === 'matrix') code = await matrix(args);
  else if (mode === 'compare') code = await runCompare(typeof args._ === 'string' ? args._.split(',') : []);
  else {
    console.error('Usage: measure.ts collect [--sessions DIR] [--tasks a,b] [--since YYYY-MM-DD] [--label NAME] [--out FILE]');
    console.error('       measure.ts fold --runs DIR --arm NAME [--out FILE]');
    console.error('       measure.ts matrix --runs DIR [--arms a,b,c] [--resample [DIR]] [--regrade [DIR]]');
    console.error('       measure.ts compare BEFORE.json AFTER.json');
    code = 1;
  }
  process.exit(code);
}

// Only run when invoked directly. `run.ts` imports `parseArgs` from here, so a
// guard that fired on any import would run this CLI's main() as a side effect
// of starting the other one.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
