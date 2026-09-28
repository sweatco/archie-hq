import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { combine, draftArchie, importLongMemEval, inventory, syntheticCorpus } from './corpus.js';
import { authorizedVisibleEvents, checkpointKey, digest, permittedEvidence, validateCorpus, visibleAt, type Case, type Corpus, type History } from './schema.js';
import { PRICING } from './budget.js';
import { draftRealLabels } from './labels.js';
import { evidenceDiagnosis, retainedEvidence } from './diagnostics.js';
import { answerSuccess, oracleFor, readerExecution, retryableJudgeError, type ToolTrace } from './judgment.js';
import { selectedCases } from './selection.js';
import { retentionPrecondition } from './retention.js';
import { writeCalibrationPacket } from './calibration.js';

const command = process.argv[2] ?? 'help';
const root = resolve(process.env.ARCHIE_EVAL_HOME ?? '/Users/igorsova/Projects/achie-snapshots/memory-eval');
const corpusPath = join(root, 'corpus.json');
const repo = resolve(import.meta.dirname, '../..');
const keySource = process.env.ARCHIE_EVAL_ENV_FILE ?? '/Users/igorsova/Projects/archie-hq/.env';

async function loadCorpus(): Promise<Corpus> { return JSON.parse(await readFile(corpusPath, 'utf8')) as Corpus; }
async function savePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function sourceHash(path: string): Promise<string> { return digest(await readFile(path)); }
const ARCHIVE_SHA = 'eb5b2e4d66e2954979bebf41db89878bfc8a5c4b5390dfc12dcdc23ec4f24907';

async function withVerifiedSource<T>(use: (path: string) => Promise<T>): Promise<T> {
  const archive = process.env.ARCHIE_EVAL_ARCHIVE ?? '/Users/igorsova/Projects/achie-snapshots/archie-eval-source-20260926-022439Z.tgz';
  if (await sourceHash(archive) !== ARCHIVE_SHA) throw new Error('source archive SHA-256 mismatch');
  const extracted = join(root, `verified-source-${randomUUID()}`);
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  try {
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'pipe' });
    return await use(extracted);
  } finally { await rm(extracted, { recursive: true, force: true }); }
}

async function preflight(): Promise<void> {
  dotenv.config({ path: keySource, quiet: true });
  if (!process.env.ANTHROPIC_API_KEY) throw new Error(`ANTHROPIC_API_KEY missing from environment and ${keySource}`);
  const client = new Anthropic();
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) await client.models.retrieve(model);
}

async function worker(input: unknown, env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(repo, 'tools/memory-eval/worker.ts')], {
    cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(input));
  let output = '', error = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (x) => { output += x; });
  child.stderr.on('data', (x) => { error += x; });
  const exit = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  if (exit !== 0) throw new Error(`worker failed (${exit}): ${error.slice(-3000)}`);
  try { return JSON.parse(output.trim().split('\n').at(-1)!); }
  catch { throw new Error(`worker returned no JSON: ${output.slice(-1000)} ${error.slice(-1000)}`); }
}

async function resolvedIngestionConfig() {
  const paths = await import('../../src/memory/paths.js');
  return { memoryEnabled: true, housekeepingEnabled: paths.isHousekeepingEnabled(), userCap: paths.getUserCap(),
    sectionCap: paths.getSectionCap(), stalenessDays: paths.getStalenessDays(), entityCap: paths.getEntityCap(),
    extractor: 'claude-sonnet-5', housekeeper: 'claude-sonnet-5', pricing: PRICING };
}

async function configHash(): Promise<string> {
  const files = [
    'src/memory/extractor.ts', 'src/memory/lifecycle.ts', 'src/memory/sanitize.ts',
    'src/memory/store.ts', 'src/memory/entities.ts', 'src/memory/task-summaries.ts',
    'src/memory/housekeeping.ts', 'src/memory/paths.ts',
    'src/memory/clock.ts', 'src/memory/annotations.ts', 'src/memory/activity.ts',
    'src/memory/entity-index.ts', 'src/memory/pending-queue.ts', 'src/memory/task-authors.ts',
    'prompts/memory-extractor.md', 'prompts/memory-housekeeper.md',
    'tools/memory-eval/replay-format.ts', 'tools/memory-eval/schema.ts', 'tools/memory-eval/retention.ts',
    'tools/memory-eval/budget.ts', 'package-lock.json',
  ];
  const workerSource = await readFile(join(repo, 'tools/memory-eval/worker.ts'), 'utf8');
  const buildSource = workerSource.split('function responseText(')[0];
  if (buildSource === workerSource) throw new Error('replay worker build boundary missing');
  return digest(JSON.stringify({ files: await Promise.all(files.map((file) => sourceHash(join(repo, file)))),
    workerBuild: digest(buildSource), resolved: await resolvedIngestionConfig() }));
}

async function readerConfigHash(): Promise<string> {
  const files = ['tools/memory-eval/worker.ts', 'tools/memory-eval/cli.ts', 'tools/memory-eval/auth.ts',
    'tools/memory-eval/diagnostics.ts', 'tools/memory-eval/judgment.ts', 'tools/memory-eval/selection.ts',
    'src/memory/tools.ts', 'src/memory/context.ts', 'package-lock.json'];
  return digest(JSON.stringify({ files: await Promise.all(files.map((file) => sourceHash(join(repo, file)))), pricing: PRICING }));
}

async function checkpoint(history: History, cutoff: string): Promise<{ path: string; hash: string; built: boolean }> {
  const visible = { ...history, events: visibleAt(history, cutoff), completions: history.completions.filter((c) => c.at <= cutoff) };
  const hash = checkpointKey(history, cutoff, await configHash(), 'claude-sonnet-5', PRICING);
  const path = join(root, 'checkpoints', hash);
  try {
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as { hash?: string; historyId?: string; cutoff?: string; configHash?: string };
    if (manifest.hash !== hash || manifest.historyId !== history.id || manifest.cutoff !== cutoff || manifest.configHash !== await configHash()) {
      throw new Error(`checkpoint manifest mismatch: ${path}`);
    }
    return { path, hash, built: false };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = `${path}.partial`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const workdir = join(staging, 'workdir');
    let receipt: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        receipt = await worker({ mode: 'build', history: visible, cutoff, workdir, ledger: join(root, 'initial-budget.json'), capUsd: 100 }, {});
        break;
      } catch (error) {
        await savePrivate(join(staging, 'last-error.txt'), String(error));
        if (attempt === 3 || String(error).includes('budget stop')) throw error;
      }
    }
    await savePrivate(join(staging, 'manifest.json'), { historyId: history.id, cutoff, hash, configHash: await configHash(),
      resolvedIngestionConfig: await resolvedIngestionConfig(), model: 'claude-sonnet-5', pricing: PRICING, receipt });
    for (const name of await readdir(staging)) if (/^step-\d+$/.test(name)) await rm(join(staging, name), { recursive: true, force: true });
    await rename(staging, path);
  } catch (error) { await savePrivate(join(staging, 'last-error.txt'), String(error)); throw error; }
  return { path, hash, built: true };
}

function judgingEvidence(c: Case, h: History): string {
  const events = authorizedVisibleEvents(c, h).filter((event) => event.role !== 'system');
  const evidence = events.map((event) => JSON.stringify({ at: event.at, role: event.role,
    authoritativeForUserFacts: event.role === 'user', authorId: event.authorId, messageTs: event.messageTs,
    taskId: event.taskId, source: event.source.ref, audience: event.audience ?? h.scope, text: event.text })).join('\n');
  if (Buffer.byteLength(evidence) > 900_000) throw new Error(`judge evidence exceeds bounded full-history context for ${c.id}`);
  return evidence || '(no authorized original evidence)';
}

function deterministicScore(c: Case, answer: string) {
  if (c.required.length === 0 && c.forbidden.length === 0) return { status: 'unscored', requiredHit: null, forbiddenHit: null };
  const lower = answer.toLowerCase();
  const requiredHit = c.required.map((x) => lower.includes(x.toLowerCase()));
  const forbiddenHit = c.forbidden.map((x) => lower.includes(x.toLowerCase()));
  return { status: c.review === 'approved' ? 'gate' : 'advisory', requiredHit, forbiddenHit,
    allRequired: requiredHit.every(Boolean), anyForbidden: forbiddenHit.some(Boolean) };
}

type ProbeResult = { arm?: string; answer?: string; injection?: string; memoryToolsAvailable?: boolean;
  toolCalls?: number; toolTurns?: number; modelTurns?: number; toolTrace?: ToolTrace[] };
async function gradeAnswer(c: Case, h: History, item: ProbeResult, reportPath: string): Promise<unknown> {
  const arm = item.arm;
  if (arm !== 'no_memory' && arm !== 'candidate' && arm !== 'oracle') throw new Error('judge requires a recorded reader arm');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await worker({ mode: 'judge', case: c, answer: String(item.answer ?? ''), evidence: judgingEvidence(c, h),
        execution: readerExecution(arm, item, arm === 'oracle' ? oracleFor(c, h) : ''),
        ledger: join(reportPath, 'budget.json'), capUsd: 10 }, { ARCHIE_MEMORY: 'false' });
    } catch (error) {
      if (attempt === 2 || !retryableJudgeError(error)) throw error;
    }
  }
  throw new Error('judge retry exhausted');
}

async function run(): Promise<void> {
  const corpus = await loadCorpus();
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(`corpus invalid:\n${errors.join('\n')}`);
  const caseId = process.argv[3] === '--case' ? process.argv[4] : undefined;
  const cases = selectedCases(corpus, caseId);
  await preflight();
  const byId = new Map(corpus.histories.map((h) => [h.id, h]));
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const reportPath = join(root, 'runs', runId);
  await mkdir(reportPath, { recursive: true, mode: 0o700 });
  const manifest = { runId, revision: (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim(),
    corpusHash: await sourceHash(corpusPath), configHash: await configHash(), readerConfigHash: await readerConfigHash(),
    resolvedIngestionConfig: await resolvedIngestionConfig(), cases: cases.map((c) => c.id),
    pricing: PRICING, reader: 'claude-opus-5-5', extractor: 'claude-sonnet-5', capUsd: { initial: 100, routine: 10 } };
  await savePrivate(join(reportPath, 'manifest.json'), manifest);
  const results: unknown[] = [];
  const fixedRetrieval: unknown[] = [];
  for (const c of cases) {
    const h = byId.get(c.historyId)!;
    let ckpt: { path: string; hash: string; built: boolean };
    try { ckpt = await checkpoint(h, c.queryAt); }
    catch (error) {
      results.push({ caseId: c.id, status: 'build_failed', error: String(error) });
      await savePrivate(join(reportPath, 'results.json'), results);
      continue;
    }
    if (h.retentionCheck) {
      const saved = JSON.parse(await readFile(join(ckpt.path, 'manifest.json'), 'utf8')) as { receipt?: { receipts?: Array<{ retention?: import('./retention.js').RetentionSnapshot }> } };
      const precondition = retentionPrecondition(saved.receipt?.receipts ?? []);
      if (!precondition.met) {
        results.push({ caseId: c.id, status: 'precondition_failed', error: precondition.reason });
        fixedRetrieval.push({ caseId: c.id, status: 'precondition_failed', error: precondition.reason });
        await savePrivate(join(reportPath, 'results.json'), results);
        await savePrivate(join(reportPath, 'fixed-retrieval.json'), fixedRetrieval);
        continue;
      }
    }
    const retrievalWorkdir = join(reportPath, `retrieval-${c.id}`);
    try {
      await cp(join(ckpt.path, 'workdir'), retrievalWorkdir, { recursive: true, force: false });
      const fixed = await worker({ mode: 'retrieval', case: { ...c, required: [], forbidden: [], evidence: [] }, workdir: retrievalWorkdir }, {});
      const output = (fixed as { content?: Array<{ text?: string }> }).content?.map((block) => block.text ?? '').join('\n') ?? '';
      fixedRetrieval.push({ caseId: c.id, status: 'ok', result: fixed,
        evidence: evidenceDiagnosis(c, h, output), retained: await retainedEvidence(c, h, join(ckpt.path, 'workdir')) });
    } catch (error) { fixedRetrieval.push({ caseId: c.id, status: 'error', error: String(error) }); }
    finally { await rm(retrievalWorkdir, { recursive: true, force: true }); await savePrivate(join(reportPath, 'fixed-retrieval.json'), fixedRetrieval); }
    for (const arm of ['no_memory', 'candidate', 'oracle'] as const) {
      const temp = join(reportPath, `probe-${c.id}-${arm}`);
      try {
        if (arm === 'candidate') await cp(join(ckpt.path, 'workdir'), temp, { recursive: true, force: false });
        const safeCase = { ...c, required: [], forbidden: [], evidence: [], review: 'draft' as const };
        const item = await worker({ mode: 'probe', arm, case: safeCase,
          ...(arm === 'candidate' ? { workdir: temp } : {}),
          ...(arm === 'oracle' ? { oracleEvidence: oracleFor(c, h) } : {}),
          ledger: join(reportPath, 'budget.json'), capUsd: 10 },
        arm === 'candidate' ? {} : { ARCHIE_MEMORY: 'false', ARCHIE_WORKDIR: join(reportPath, `empty-${arm}-${c.id}`) });
        let semantic: unknown = { status: 'unscored' };
        if ((item as { status?: string }).status === 'ok' && (c.required.length || c.forbidden.length)) {
          try { semantic = await gradeAnswer(c, h, item as ProbeResult, reportPath); }
          catch (error) { semantic = { status: 'error', error: String(error) }; }
        }
        const record = { ...item as object, checkpoint: ckpt.hash, score: deterministicScore(c, String((item as { answer?: string }).answer ?? '')),
          evidenceCoverage: arm === 'candidate' ? evidenceDiagnosis(c, h, `${(item as { injection?: string }).injection ?? ''}\n${((item as { toolTrace?: Array<{ output?: string }> }).toolTrace ?? []).map((trace) => trace.output ?? '').join('\n')}`) : undefined,
          semantic, review: c.review };
        results.push(record); await savePrivate(join(reportPath, 'results.json'), results);
      } catch (error) {
        results.push({ caseId: c.id, arm, status: 'error', error: String(error) });
        await savePrivate(join(reportPath, 'results.json'), results);
      } finally { if (arm === 'candidate') await rm(temp, { recursive: true, force: true }); }
    }
  }
  await writeRunReport(cases, manifest, results, fixedRetrieval, reportPath, byId);
}

async function writeRunReport(cases: Case[], manifest: Record<string, unknown>, results: unknown[], fixedRetrieval: unknown[],
  reportPath: string, histories: Map<string, History>): Promise<void> {
  const runId = String(manifest.runId);
  const expected = cases.length * 3;
  const ok = results.filter((r) => (r as { status?: string }).status === 'ok').length;
  type Result = { caseId?: string; arm?: string; status?: string; toolCalls?: number; latencyMs?: number; costUsd?: number; inputTokens?: number; outputTokens?: number;
    evidenceCoverage?: { expectedEvidence: number; referenceSurfaced: number; factualOverlapAtHalf: number; leakMarkers: string[] };
    semantic?: { status?: string; requiredMet?: boolean[]; forbiddenAsserted?: boolean[]; unsupportedClaims?: string[];
      contradictedClaims?: string[]; unverifiableClaims?: string[]; abstained?: boolean; costUsd?: number } };
  const rows = results as Result[];
  const success = (c: Case, r?: Result): boolean | null => r?.status === 'ok' ? answerSuccess(c, r.semantic) : null;
  type Breakdown = { cases: number; armsOk: number; expectedArms: number; judgedArms: number; noMemorySuccess: number; candidateSuccess: number; oracleSuccess: number;
    pairedWins: number; pairedRegressions: number; pairedTies: number; pairUnscored: number; candidateAbstentions: number; candidateUnsupported: number;
    candidateContradicted: number; candidateUnverifiable: number; candidateStale: number; candidateLeakMarkers: number;
    expectedEvidence: number; retainedCanonical: number; retainedFactualOverlap: number; fixedReferenceSurfaced: number; fixedFactualOverlap: number;
    candidateReferenceSurfaced: number; candidateFactualOverlap: number; toolCalls: number; inputTokens: number; outputTokens: number; latencyMs: number;
    readerCostUsd: number; judgeCostUsd: number };
  const blank = (): Breakdown => ({ cases: 0, armsOk: 0, expectedArms: 0, judgedArms: 0, noMemorySuccess: 0, candidateSuccess: 0, oracleSuccess: 0,
    pairedWins: 0, pairedRegressions: 0, pairedTies: 0, pairUnscored: 0, candidateAbstentions: 0, candidateUnsupported: 0,
    candidateContradicted: 0, candidateUnverifiable: 0, candidateStale: 0, candidateLeakMarkers: 0,
    expectedEvidence: 0, retainedCanonical: 0, retainedFactualOverlap: 0, fixedReferenceSurfaced: 0, fixedFactualOverlap: 0,
    candidateReferenceSurfaced: 0, candidateFactualOverlap: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0,
    readerCostUsd: 0, judgeCostUsd: 0 });
  const breakdown: Record<string, Breakdown> = {};
  type Fixed = { caseId: string; status: string; evidence?: { expectedEvidence: number; referenceSurfaced: number; factualOverlapAtHalf: number };
    retained?: { canonicalPresent: number; factualOverlapAtHalf: number } };
  for (const c of cases) {
    for (const key of [`source:${c.source}`, `workload:${c.workload}`, `ability:${c.ability}`, `taskKind:${c.taskKind ?? 'recall'}`, `split:${c.split}`]) {
      const row = breakdown[key] ??= blank();
      row.cases++; row.expectedArms += 3;
      const arms = rows.filter((r) => r.caseId === c.id && r.arm);
      row.armsOk += arms.filter((r) => r.status === 'ok').length;
      row.judgedArms += arms.filter((r) => r.semantic?.status === 'advisory').length;
      row.toolCalls += arms.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0);
      row.inputTokens += arms.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
      row.outputTokens += arms.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
      row.latencyMs += arms.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0);
      row.readerCostUsd += arms.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      row.judgeCostUsd += arms.reduce((sum, r) => sum + (r.semantic?.costUsd ?? 0), 0);
      const candidateArm = arms.find((r) => r.arm === 'candidate');
      const judge = candidateArm?.semantic;
      if (judge?.abstained) row.candidateAbstentions++;
      row.candidateUnsupported += judge?.unsupportedClaims?.length ?? 0;
      row.candidateContradicted += judge?.contradictedClaims?.length ?? 0;
      row.candidateUnverifiable += judge?.unverifiableClaims?.length ?? 0;
      row.candidateStale += judge?.forbiddenAsserted?.filter(Boolean).length ?? 0;
      row.candidateLeakMarkers += candidateArm?.evidenceCoverage?.leakMarkers.length ?? 0;
      const fixed = (fixedRetrieval as Fixed[]).find((result) => result.caseId === c.id);
      row.expectedEvidence += fixed?.evidence?.expectedEvidence ?? 0;
      row.retainedCanonical += fixed?.retained?.canonicalPresent ?? 0;
      row.retainedFactualOverlap += fixed?.retained?.factualOverlapAtHalf ?? 0;
      row.fixedReferenceSurfaced += fixed?.evidence?.referenceSurfaced ?? 0;
      row.fixedFactualOverlap += fixed?.evidence?.factualOverlapAtHalf ?? 0;
      row.candidateReferenceSurfaced += candidateArm?.evidenceCoverage?.referenceSurfaced ?? 0;
      row.candidateFactualOverlap += candidateArm?.evidenceCoverage?.factualOverlapAtHalf ?? 0;
      const no = success(c, arms.find((r) => r.arm === 'no_memory'));
      const candidate = success(c, arms.find((r) => r.arm === 'candidate'));
      const oracle = success(c, arms.find((r) => r.arm === 'oracle'));
      if (no) row.noMemorySuccess++;
      if (candidate) row.candidateSuccess++;
      if (oracle) row.oracleSuccess++;
      if (no === null || candidate === null) row.pairUnscored++;
      else if (candidate && !no) row.pairedWins++;
      else if (!candidate && no) row.pairedRegressions++;
      else row.pairedTies++;
    }
  }
  const fixedOk = fixedRetrieval.filter((result) => (result as { status: string }).status === 'ok').length;
  const judged = rows.filter((result) => result.semantic?.status === 'advisory').length;
  const executionStatus = ok === expected && fixedOk === cases.length ? 'complete' : 'incomplete';
  const gradingStatus = judged === expected ? 'complete' : 'incomplete';
  const reviewStatus = cases.every((c) => c.review === 'approved') ? 'calibration_pending' : 'human_review_pending';
  const status = executionStatus === 'complete' && gradingStatus === 'complete' ? 'provisional' : 'incomplete';
  let ledgerCostUsd: number | null = null;
  try { ledgerCostUsd = (JSON.parse(await readFile(join(reportPath, 'budget.json'), 'utf8')) as { committedUsd: number }).committedUsd; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await savePrivate(join(reportPath, 'report.json'), { ...manifest, status, executionStatus, gradingStatus, reviewStatus,
    qualityOutcome: 'not_gated', expectedArms: expected, completedArms: ok, judgedArms: judged,
    missingOrFailedArms: expected - ok, fixedRetrievalCompleted: fixedOk, fixedRetrievalExpected: cases.length, ledgerCostUsd, breakdown });
  const sourceRows = Object.entries(breakdown).filter(([k]) => k.startsWith('source:'))
    .map(([k, r]) => `| ${k.slice(7)} | ${r.armsOk}/${r.expectedArms} | ${r.judgedArms}/${r.expectedArms} | ${r.noMemorySuccess}/${r.cases} | ${r.candidateSuccess}/${r.cases} | ${r.oracleSuccess}/${r.cases} | ${r.pairedWins} | ${r.pairedRegressions} | ${r.pairUnscored} | ${r.candidateUnsupported}/${r.candidateContradicted}/${r.candidateUnverifiable} | ${r.retainedCanonical}/${r.expectedEvidence} | ${r.fixedReferenceSurfaced}/${r.expectedEvidence} | ${r.fixedFactualOverlap}/${r.expectedEvidence} | $${(r.readerCostUsd + r.judgeCostUsd).toFixed(4)} |`).join('\n');
  const repairs = Array.isArray(manifest.gradingRepairs) ? manifest.gradingRepairs.length : 0;
  const md = `# Memory evaluation routine run\n\n- Run: ${runId}\n- Execution: ${executionStatus}; ${ok}/${expected} answer arms, ${fixedOk}/${cases.length} fixed retrieval calls\n- Grading: ${gradingStatus}; ${judged}/${expected} semantic verdicts\n- Grade-only repairs: ${repairs}; repaired verdicts use saved answers and the same run ledger, with judge hashes in manifest.json\n- Run ledger: ${ledgerCostUsd === null ? 'not opened' : `$${ledgerCostUsd.toFixed(4)}`} against $10 cap; source rows exclude failed-verdict charges\n- Review: ${reviewStatus}; quality outcome not gated\n- Overall status: ${status}\n- Corpus SHA-256: ${manifest.corpusHash}\n- Config SHA-256: ${manifest.configHash}\n- Models: ${manifest.reader} reader, ${manifest.extractor} extractor\n\n| Source | Arms | Judged | No memory | Candidate | Oracle | Wins | Regressions | Unscored | Candidate unsupported/contradicted/unverifiable | Canonical retained | Fixed references | Fixed lexical evidence | Reader + judge cost |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${sourceRows}\n\nReference surfacing and lexical overlap are diagnostics, not proof of factual correctness. Abstention success requires both appropriate refusal and a supported explanation. Full slices, tool traces, tokens, latency, and leak markers are in report.json, results.json, and fixed-retrieval.json.\n`;
  await savePrivate(join(reportPath, 'report.md'), md);
  await writeCalibrationPacket(reportPath, cases, histories, rows, judgingEvidence);
  process.stdout.write(`${reportPath}\n`);
  if (status === 'incomplete') process.exitCode = 1;
}

async function repairGrades(): Promise<void> {
  const runId = process.argv[3];
  if (!runId || runId.includes('/') || runId.includes('..')) throw new Error('repair requires a saved run ID');
  const reportPath = join(root, 'runs', runId);
  const manifest = JSON.parse(await readFile(join(reportPath, 'manifest.json'), 'utf8')) as Record<string, unknown> &
    { cases: string[]; corpusHash: string; configHash: string; gradingRepairs?: unknown[] };
  const corpus = await loadCorpus();
  const validation = validateCorpus(corpus);
  if (validation.length) throw new Error(validation.join('\n'));
  if (manifest.corpusHash !== await sourceHash(corpusPath) || manifest.configHash !== await configHash()) {
    throw new Error('saved run corpus or ingestion configuration differs from current inputs');
  }
  const byCase = new Map(corpus.cases.map((c) => [c.id, c]));
  const byId = new Map(corpus.histories.map((h) => [h.id, h]));
  const cases = manifest.cases.map((id) => {
    const c = byCase.get(id);
    if (!c || c.review === 'quarantined') throw new Error(`saved run case unavailable or quarantined: ${id}`);
    return c;
  });
  const results = JSON.parse(await readFile(join(reportPath, 'results.json'), 'utf8')) as Array<Record<string, unknown>>;
  const fixedRetrieval = JSON.parse(await readFile(join(reportPath, 'fixed-retrieval.json'), 'utf8')) as unknown[];
  const failed = results.filter((row) => row.status === 'ok' && (row.semantic as { status?: string } | undefined)?.status === 'error');
  if (!failed.length) throw new Error('saved run has no failed semantic grades to repair');
  await preflight();
  for (const row of failed) {
    const c = byCase.get(String(row.caseId))!;
    const h = byId.get(c.historyId)!;
    try {
      row.semantic = await gradeAnswer(c, h, row as ProbeResult, reportPath);
      manifest.gradingRepairs = [...(manifest.gradingRepairs ?? []), { at: new Date().toISOString(), caseId: c.id,
        arm: row.arm, judgeCodeHash: await readerConfigHash() }];
    } catch (error) { row.semantic = { status: 'error', error: String(error) }; }
    await savePrivate(join(reportPath, 'results.json'), results);
    await savePrivate(join(reportPath, 'manifest.json'), manifest);
  }
  await writeRunReport(cases, manifest, results, fixedRetrieval, reportPath, byId);
}

async function buildOnly(): Promise<void> {
  const corpus = await loadCorpus();
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(errors.join('\n'));
  const caseId = process.argv[3] === '--case' ? process.argv[4] : undefined;
  const cases = selectedCases(corpus, caseId);
  await preflight();
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const output: unknown[] = [];
  for (const c of cases) {
    try { output.push({ caseId: c.id, ...await checkpoint(histories.get(c.historyId)!, c.queryAt) }); }
    catch (error) { output.push({ caseId: c.id, status: 'failed', error: String(error) }); }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.some((item) => (item as { status?: string }).status === 'failed')) process.exitCode = 1;
}

async function reportExisting(): Promise<void> {
  const runId = process.argv[3] ?? (await (await import('node:fs/promises')).readdir(join(root, 'runs'))).sort().at(-1);
  if (!runId || runId.includes('/') || runId.includes('..')) throw new Error('invalid run ID');
  process.stdout.write(await readFile(join(root, 'runs', runId, 'report.md'), 'utf8'));
}

async function packetExisting(): Promise<void> {
  const runId = process.argv[3];
  if (!runId || runId.includes('/') || runId.includes('..')) throw new Error('packet requires a saved run ID');
  const reportPath = join(root, 'runs', runId);
  const manifest = JSON.parse(await readFile(join(reportPath, 'manifest.json'), 'utf8')) as { cases: string[]; corpusHash: string };
  if (manifest.corpusHash !== await sourceHash(corpusPath)) throw new Error('saved run corpus differs from current inputs');
  const corpus = await loadCorpus();
  const byCase = new Map(corpus.cases.map((c) => [c.id, c]));
  const cases = manifest.cases.map((id) => {
    const c = byCase.get(id);
    if (!c) throw new Error(`saved run case unavailable: ${id}`);
    return c;
  });
  const rows = JSON.parse(await readFile(join(reportPath, 'results.json'), 'utf8')) as Array<Record<string, unknown>>;
  const status = await writeCalibrationPacket(reportPath, cases, new Map(corpus.histories.map((h) => [h.id, h])), rows, judgingEvidence);
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

async function draft(): Promise<void> {
  const longmem = join(root, 'public-source', 'longmemeval_s_cleaned.json');
  const oracle = join(root, 'public-source', 'longmemeval_oracle.json');
  const futureRecipePath = join(root, 'real-future-drafts.json');
  const archie = await withVerifiedSource((path) => draftArchie(path, root, ARCHIVE_SHA));
  const parts = [archie, syntheticCorpus(), await importLongMemEval(longmem, oracle)];
  const corpus = combine(parts, { archiveSha256: ARCHIVE_SHA, realFutureRecipeSha256: await sourceHash(futureRecipePath),
    publicSha256: await sourceHash(longmem), capture: '2026-09-26T02:24:39Z',
    oracleSha256: await sourceHash(oracle),
    note: 'Real-history channel properties are absent from the archive; real cases remain quarantined until historical authorization is verified.' });
  try {
    const previous = await loadCorpus();
    const prior = new Map(previous.cases.map((c) => [c.id, c]));
    const pseudonyms = JSON.parse(await readFile(join(root, 'pseudonym-map.json'), 'utf8')) as Record<string, string>;
    const redact = (value: string) => Object.entries(pseudonyms).sort((a, b) => b[0].length - a[0].length)
      .reduce((text, [raw, alias]) => text.split(raw).join(alias), value);
    for (const c of corpus.cases) {
      const old = prior.get(c.id);
      if (c.taskKind !== 'future_task' && old?.reason?.startsWith('Model-drafted') && JSON.stringify(old.evidence.map(({ ref, start, end }) => ({ ref, start, end }))) === JSON.stringify(c.evidence.map(({ ref, start, end }) => ({ ref, start, end })))) {
        c.question = redact(old.question); c.required = old.required.map(redact); c.forbidden = old.forbidden.map(redact); c.ability = old.ability;
        c.reason = `${old.reason}; historical authorization unverified`;
      }
    }
  } catch { /* no earlier corpus */ }
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(errors.join('\n'));
  await savePrivate(corpusPath, corpus);
  await writeReviewSheets(corpus);
  process.stdout.write(`${corpus.cases.length} cases, ${corpus.histories.length} histories; ${corpusPath}\n`);
}

async function writeReviewSheets(corpus: Corpus): Promise<void> {
  const sheet = [
    '# Memory evaluation review sheet', '',
    'Cases are drafts. Review original user evidence, chronology, scope, and atomic required/forbidden claims. Assistant statements alone are insufficient.', '',
    ...corpus.cases.map((c) => `## ${c.id}\n\n- Source/workload/ability: ${c.source} / ${c.workload} / ${c.ability}\n- Split: ${c.split}\n- Query time: ${c.queryAt}\n- Audience: ${c.audience.kind} ${c.audience.channelId}\n- Question: ${c.question}\n- Evidence: ${c.evidence.map((s) => `${s.ref}:${s.start}-${s.end}`).join(', ') || '(none; abstention)'}\n- Evidence excerpt: ${c.evidence.map((s) => JSON.stringify(s.quote)).join('; ') || '(none)'}\n- Required: ${c.required.join('; ') || '(draft needed)'}\n- Forbidden: ${c.forbidden.join('; ') || '(draft needed)'}\n- Review: ${c.review}\n- Reviewer decision: [ ] accept [ ] revise [ ] quarantine\n`),
  ].join('\n');
  await savePrivate(join(root, 'review-sheet.md'), sheet);
  const real = corpus.histories.filter((history) => history.source === 'archie');
  const authorization = [
    '# Historical authorization and future-task review', '',
    'All Archie cases remain quarantined. The archive records destinations and messages, but does not establish historical Slack channel type, app access, or requester membership. Supply a timestamped Slack audit/export or a responsible human review; do not infer these properties from channel ID prefixes.', '',
    'For every completion below, verify the channel kind, app access, and destination at that time. For each proposed query, verify requester access at the query time. For DMs, verify the exact participants. Mark unknown, revoked, external, or conflicting evidence as quarantined. Then select relevant original user-message spans and review the independent task outcomes and chronology. The case can be unquarantined only after all applicable event and completion scopes are recorded as verified.', '',
    ...real.flatMap((history) => {
      const futures = corpus.cases.filter((c) => c.historyId === history.id && c.taskKind === 'future_task');
      return [`## ${history.id}`, '', `- Workload: ${history.workload}`, `- Event author IDs verified from message metadata: ${history.events.filter((e) => e.authorId && e.messageTs).length}/${history.events.filter((e) => e.role === 'user').length} user events`,
        '- Completion scopes needing historical verification:',
        ...history.completions.map((completion) => `  - ${completion.at} / ${completion.taskId} / recorded destination ${completion.audience?.channelId ?? history.scope.channelId}: kind [ ] public [ ] private [ ] DM [ ] unknown; app access [ ] yes [ ] no [ ] unknown`),
        ...futures.flatMap((c) => [`- Future query ${c.queryAt}; requester ${c.requester}; destination ${c.audience.channelId}: requester access [ ] yes [ ] no [ ] unknown`,
          `- New-task input: ${c.currentContext}`, `- Useful outcome draft: ${c.required.join('; ')}`, '- Relevant earlier user-message spans (with timestamps and approval state):', '- Reviewer decision: [ ] verify and revise labels [ ] keep quarantined', '']),
      ];
    }),
  ].join('\n');
  await savePrivate(join(root, 'real-authorization-review.md'), authorization);
}

try {
  if (command === 'inventory') process.stdout.write(`${JSON.stringify(await withVerifiedSource(inventory), null, 2)}\n`);
  else if (command === 'draft' || command === 'import') await draft();
  else if (command === 'labels') {
    await preflight();
    const corpus = await loadCorpus();
    const result = await draftRealLabels(corpus, join(root, 'initial-budget.json'));
    await savePrivate(corpusPath, corpus);
    await writeReviewSheets(corpus);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  else if (command === 'validate') {
    const corpus = await loadCorpus(); const errors = validateCorpus(corpus);
    if (errors.length) throw new Error(errors.join('\n'));
    process.stdout.write(`valid: ${corpus.cases.length} cases, ${corpus.histories.length} histories\n`);
  } else if (command === 'build') await buildOnly();
  else if (command === 'run') await run();
  else if (command === 'repair') await repairGrades();
  else if (command === 'packet') await packetExisting();
  else if (command === 'report') await reportExisting();
  else process.stdout.write('Usage: npm run memory:eval -- inventory|import|draft|labels|validate|build|run [--case ID]|repair RUN_ID|packet RUN_ID|report [RUN_ID]\n');
} catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
