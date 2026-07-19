/**
 * memory:eval — entry point.
 *
 *   ARCHIE_WORKDIR=<extracted-snapshot> npx tsx scripts/memory-eval.ts [flags]
 *
 * The snapshot location comes from ARCHIE_WORKDIR ONLY — `WORKDIR` binds at
 * module load (src/system/workdir.ts), so this file validates the env var and
 * refuses to run BEFORE dynamically importing anything that binds it. It can
 * therefore never silently read the developer's live workdir.
 *
 * Read-only over the snapshot: reports/goldens/questions are written OUTSIDE
 * it (default ~/archie-snapshots/{reports,golden,questions}); the production
 * context builder is only ever called without a taskId, so the selection
 * sensor's gate keeps the replay from writing telemetry into the snapshot.
 *
 * Modes / flags:
 *   (default)                  mechanical report: store health + telemetry + bound
 *   --report                   add the store-review reading list (enablement gate)
 *   --prev <report.json>       deltas vs a previous run's JSON sidecar
 *   --golden <file.json>       selection-regression over a golden set
 *   --harvest-golden           write a golden set from the snapshot's selection records
 *   --questions <file.json>    functional tier over a question set (reader+judge calls)
 *   --context-only             functional tier without model calls (recall/precision only)
 *   --max-questions <n>        cap functional questions (cost control)
 *   --benchmark-ingest <file> --into <dir>   build a throwaway store + questions from a
 *                              LongMemEval-style file (then run eval with ARCHIE_WORKDIR=<dir>)
 *   --synthesize-questions <n> generate a prod question set from the snapshot (LLM)
 *   --validate-judge <sample.json>  compute Cohen's κ + position bias for the judge
 *   --judge-validation <file.json>  stamp a previous validation into this run's report
 *   --out <dir>                output root (default ~/archie-snapshots)
 *   --json                     also print the JSON sidecar to stdout
 */

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';

interface Args {
  report: boolean;
  prev?: string;
  golden?: string;
  harvestGolden: boolean;
  questions?: string;
  contextOnly: boolean;
  maxQuestions?: number;
  benchmarkIngest?: string;
  into?: string;
  synthesizeQuestions?: number;
  validateJudge?: string;
  judgeValidation?: string;
  out: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { report: false, harvestGolden: false, contextOnly: false, out: join(homedir(), 'archie-snapshots'), json: false };
  // A numeric flag that doesn't parse to a positive integer is an error, never
  // a silent no-op: `--synthesize-questions ten` skipping synthesis (or
  // `--max-questions 0` running UNCAPPED) is exactly the failure a cost/mode
  // flag must not have.
  const positiveInt = (flag: string, raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`${flag} expects a positive integer, got ${JSON.stringify(raw)}`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--report': a.report = true; break;
      case '--prev': a.prev = next(); break;
      case '--golden': a.golden = next(); break;
      case '--harvest-golden': a.harvestGolden = true; break;
      case '--questions': a.questions = next(); break;
      case '--context-only': a.contextOnly = true; break;
      case '--max-questions': a.maxQuestions = positiveInt('--max-questions', next()); break;
      case '--benchmark-ingest': a.benchmarkIngest = next(); break;
      case '--into': a.into = next(); break;
      case '--synthesize-questions': a.synthesizeQuestions = positiveInt('--synthesize-questions', next()); break;
      case '--validate-judge': a.validateJudge = next(); break;
      case '--judge-validation': a.judgeValidation = next(); break;
      case '--out': a.out = resolve(next()); break;
      case '--json': a.json = true; break;
      default:
        console.error(`Unknown flag: ${argv[i]}`);
        process.exit(2);
    }
  }
  // The side-effect modes are exclusive commands; combining one with report
  // flags would silently discard the report-side work (a computed regression's
  // exit gate, most damagingly). Reject the combination instead.
  const exclusive = [
    flagName(a.benchmarkIngest, '--benchmark-ingest'),
    flagName(a.harvestGolden || undefined, '--harvest-golden'),
    flagName(a.validateJudge, '--validate-judge'),
    flagName(a.synthesizeQuestions, '--synthesize-questions'),
  ].filter((n): n is string => !!n);
  const reportish = [
    flagName(a.golden, '--golden'),
    flagName(a.questions, '--questions'),
    flagName(a.report || undefined, '--report'),
    flagName(a.prev, '--prev'),
  ].filter((n): n is string => !!n);
  if (exclusive.length > 1) {
    console.error(`${exclusive.join(' and ')} are exclusive modes — run them separately.`);
    process.exit(2);
  }
  if (exclusive.length === 1 && reportish.length > 0) {
    console.error(`${exclusive[0]} is an exclusive mode and ignores ${reportish.join(', ')} — run them separately.`);
    process.exit(2);
  }
  return a;
}

function flagName(value: unknown, name: string): string | null {
  return value !== undefined && value !== false ? name : null;
}

/**
 * The snapshot's capture date (YYYY-MM-DD): from an `archie-memory-YYYYMMDD`
 * segment in its path when present (snapshot-memory.sh's naming), else the
 * memory/ tree's mtime. Never the eval run's wall clock — that would key
 * golden drift checks and report filenames to when the eval ran, not to which
 * store it saw.
 */
async function deriveSnapshotDate(snapshot: string): Promise<string> {
  const m = snapshot.match(/archie-memory-(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  try {
    const { stat } = await import('fs/promises');
    const s = await stat(join(snapshot, 'memory'));
    return s.mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Benchmark ingest needs no snapshot — it CREATES one.
  if (args.benchmarkIngest) {
    if (!args.into) {
      console.error('--benchmark-ingest requires --into <dir>');
      process.exit(2);
    }
    const { ingestBenchmark } = await import('../tools/memory-eval/benchmark.js');
    const r = await ingestBenchmark(args.benchmarkIngest, resolve(args.into));
    console.log(`Ingested ${r.sessions} session(s) → ${r.storeDir}/memory/entities, ${r.questions} question(s) → ${r.questionsPath}`);
    console.log(`Run: ARCHIE_WORKDIR=${r.storeDir} npx tsx scripts/memory-eval.ts --questions ${r.questionsPath} --context-only`);
    return;
  }

  // ---- Snapshot guard, BEFORE any src import binds WORKDIR ----
  const workdir = process.env.ARCHIE_WORKDIR;
  if (!workdir) {
    console.error('ARCHIE_WORKDIR must point at an extracted snapshot (refusing to default to the local ./workdir).');
    process.exit(2);
  }
  const snapshot = resolve(workdir);
  if (!existsSync(join(snapshot, 'memory'))) {
    console.error(`ARCHIE_WORKDIR=${snapshot} has no memory/ subtree — not a snapshot. Refusing to run.`);
    process.exit(2);
  }
  if (args.out.startsWith(snapshot + '/') || args.out === snapshot) {
    console.error(`--out ${args.out} is inside the snapshot — reports must be written outside it.`);
    process.exit(2);
  }

  // Everything below binds WORKDIR to the snapshot on first import.
  const { listEntities } = await import('../src/memory/entities.js');
  const { readIndexMarkdown } = await import('../src/memory/entity-index.js');
  const { listUserFiles } = await import('../src/memory/store.js');
  const { getEntityCap, getTasksDir, getRecentActivityPath } = await import('../src/memory/paths.js');
  const { computeStoreHealth, computeDelta } = await import('../tools/memory-eval/store-health.js');
  const { readAllTelemetry, aggregateSelection, aggregatePull, aggregateExtractionSkips, aggregatePrefsOnly, aggregateUserUpdateDrops } = await import('../tools/memory-eval/telemetry-agg.js');
  const { harvestGoldens, runRegression } = await import('../tools/memory-eval/golden.js');
  const { computeWorstCaseBound } = await import('../tools/memory-eval/bound.js');
  const { buildReadingList } = await import('../tools/memory-eval/reading-list.js');
  const { renderReportMarkdown, reportSidecar } = await import('../tools/memory-eval/report.js');

  const records = await listEntities();
  const today = new Date().toISOString();
  const notes: string[] = [];

  // Users + activity + index (for the bound and reading list). Same guarded
  // reader the pull tools use — one home for the filename decode and
  // frontmatter parse (src/memory/store.ts).
  const users = await listUserFiles();
  let recentActivity = '';
  try { recentActivity = await readFile(getRecentActivityPath(), 'utf-8'); } catch { /* absent */ }
  const indexMd = await readIndexMarkdown();

  const storeHealth = { ...computeStoreHealth(records, { entityCap: getEntityCap() }), slugs: records.map((r) => r.entity) };
  let delta = null;
  if (args.prev) {
    const prev = JSON.parse(await readFile(args.prev, 'utf-8'));
    if (prev.dupMetricVersion && prev.dupMetricVersion !== storeHealth.dupMetricVersion) {
      notes.push(`prev report used duplicate metric "${prev.dupMetricVersion}" — trend not comparable`);
    } else {
      delta = computeDelta(storeHealth, prev);
    }
  }

  const telemetry = await readAllTelemetry(getTasksDir());
  const selection = aggregateSelection(telemetry.selection);
  const pull = aggregatePull(telemetry.pull);
  const extractionSkips = aggregateExtractionSkips(telemetry.extractionSkips);
  const extractionPrefsOnly = aggregatePrefsOnly(telemetry.extractionPrefsOnly);
  const userUpdateDrops = aggregateUserUpdateDrops(telemetry.userUpdateDrops);

  // ---- Golden harvest / regression ----
  // Snapshot identity, not wall clock: goldens pin the STORE they were
  // harvested against, and the drift warning compares store identities. Parse
  // the capture date from the snapshot path (snapshot-memory.sh names dirs/
  // tarballs archie-memory-YYYYMMDD), else fall back to memory/'s mtime; the
  // run date would warn spuriously on tomorrow's replay of the same snapshot
  // and stay silent on a different snapshot evaluated today.
  const snapshotDate = await deriveSnapshotDate(snapshot);
  if (args.harvestGolden) {
    if (telemetry.selection.length === 0) {
      console.error('No selection records in this snapshot — nothing to harvest (goldens come from live telemetry, post-enablement).');
      process.exit(1);
    }
    const goldens = harvestGoldens(telemetry.selection, snapshotDate);
    const dir = join(args.out, 'golden');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `golden-${snapshotDate}.json`);
    await writeFile(path, JSON.stringify(goldens, null, 2), 'utf-8');
    console.log(`Harvested ${goldens.length} golden case(s) → ${path}`);
    return;
  }
  let regression = null;
  if (args.golden) {
    const goldens = JSON.parse(await readFile(args.golden, 'utf-8'));
    for (const g of goldens) {
      if (g.snapshot_date && g.snapshot_date !== snapshotDate) {
        notes.push(`golden set pinned to snapshot ${g.snapshot_date}, running against ${snapshotDate} — diffs may be store drift, not selector change`);
        break;
      }
    }
    regression = runRegression(goldens, records);
  }

  // ---- Judge validation mode ----
  if (args.validateJudge) {
    const { createAnthropicLlm, DEFAULT_JUDGE_MODEL } = await import('../tools/memory-eval/llm.js');
    const { validateJudge } = await import('../tools/memory-eval/judge.js');
    const samples = JSON.parse(await readFile(args.validateJudge, 'utf-8'));
    const validation = await validateJudge(createAnthropicLlm(), DEFAULT_JUDGE_MODEL, samples);
    const dir = join(args.out, 'reports');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `judge-validation-${snapshotDate}.json`);
    await writeFile(path, JSON.stringify({ judgeModel: DEFAULT_JUDGE_MODEL, ...validation }, null, 2), 'utf-8');
    console.log(`Judge validation: κ=${validation.kappa}, position bias=${validation.positionBias} (n=${validation.sampleSize}) → ${path}`);
    return;
  }

  // ---- Question synthesis ----
  if (args.synthesizeQuestions) {
    const { createAnthropicLlm, DEFAULT_JUDGE_MODEL } = await import('../tools/memory-eval/llm.js');
    const { synthesizeQuestions } = await import('../tools/memory-eval/synthesize.js');
    const r = await synthesizeQuestions(records, createAnthropicLlm(), DEFAULT_JUDGE_MODEL, args.synthesizeQuestions, snapshotDate);
    const dir = join(args.out, 'questions');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `prod-questions-${snapshotDate}.json`);
    await writeFile(path, JSON.stringify(r.set, null, 2), 'utf-8');
    const worklist = join(dir, `prod-questions-${snapshotDate}.validation-worklist.md`);
    await writeFile(worklist, `# Human validation worklist (the label sample is the trust anchor)\n\n${r.validationWorklist.map((w) => `- ${w}`).join('\n')}\n`, 'utf-8');
    console.log(`Synthesized ${r.set.questions.length} question(s) (${r.failures} failure(s)) → ${path}\nValidate a sample: ${worklist}`);
    return;
  }

  // ---- Functional tier ----
  let functional = null;
  let judgeStamp = null;
  if (args.questions) {
    const { loadQuestionSet } = await import('../tools/memory-eval/questions.js');
    const { runFunctional } = await import('../tools/memory-eval/functional.js');
    const { buildJudgeStamp } = await import('../tools/memory-eval/judge.js');
    const { createAnthropicLlm, DEFAULT_READER_MODEL, DEFAULT_JUDGE_MODEL } = await import('../tools/memory-eval/llm.js');

    const set = await loadQuestionSet(args.questions);
    let questions = set.questions;
    if (args.maxQuestions && questions.length > args.maxQuestions) {
      notes.push(`functional tier capped at ${args.maxQuestions} of ${questions.length} questions (--max-questions)`);
      questions = questions.slice(0, args.maxQuestions);
    }
    let validation = null;
    if (args.judgeValidation) {
      validation = JSON.parse(await readFile(args.judgeValidation, 'utf-8'));
    }
    judgeStamp = buildJudgeStamp(DEFAULT_READER_MODEL, DEFAULT_JUDGE_MODEL, validation);
    functional = await runFunctional(questions, records, {
      llm: args.contextOnly ? async () => '' : createAnthropicLlm(),
      readerModel: DEFAULT_READER_MODEL,
      judgeModel: DEFAULT_JUDGE_MODEL,
      contextOnly: args.contextOnly,
    });
    if (args.contextOnly) notes.push('functional tier ran context-only (no reader/judge calls)');
  }

  // ---- Bound + reading list + report ----
  const bound = computeWorstCaseBound(records, users, indexMd, recentActivity);
  const readingList = args.report
    ? buildReadingList(records, [
        ...users.map((u) => ({ file: `users/${u.id}.md`, text: u.text })),
        ...(recentActivity ? [{ file: 'recent-activity.md', text: recentActivity }] : []),
        ...(indexMd ? [{ file: 'entities/index.md', text: indexMd }] : []),
      ])
    : null;

  const inputs = {
    generatedAt: today,
    snapshotPath: snapshot,
    storeHealth,
    delta,
    selection,
    pull,
    extractionSkips,
    extractionPrefsOnly,
    userUpdateDrops,
    telemetrySkipped: telemetry.skipped,
    regression,
    bound,
    readingList,
    functional,
    judge: judgeStamp,
    notes,
  };

  const dir = join(args.out, 'reports');
  await mkdir(dir, { recursive: true });
  const base = `memory-eval-${snapshotDate}`;
  const mdPath = join(dir, `${base}.md`);
  const jsonPath = join(dir, `${base}.json`);
  await writeFile(mdPath, renderReportMarkdown(inputs), 'utf-8');
  await writeFile(jsonPath, JSON.stringify(reportSidecar(inputs), null, 2), 'utf-8');
  console.log(`Report → ${mdPath}\nSidecar → ${jsonPath}`);
  if (args.json) console.log(JSON.stringify(reportSidecar(inputs), null, 2));
  if (regression && regression.diffs.length > 0) {
    console.error(`Selection regression: ${regression.diffs.length} case(s) diverged.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
