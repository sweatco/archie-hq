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

function routineCases(corpus: Corpus): Case[] {
  const dev = corpus.cases.filter((c) => c.split === 'dev' && c.review !== 'quarantined');
  const selected: Case[] = [];
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const size = (c: Case) => histories.get(c.historyId)!.completions.filter((step) => step.at <= c.queryAt).length;
  const realFamilies = new Map<string, Case[]>();
  for (const c of dev.filter((item) => item.source === 'archie' && item.taskKind === 'future_task' && item.required.length > 0)) {
    realFamilies.set(c.family, [...(realFamilies.get(c.family) ?? []), c]);
  }
  selected.push(...[...realFamilies.values()].map((group) => group.sort((a, b) => size(a) - size(b))[0]).slice(0, 6));
  const syntheticIds = ['synthetic-decision-correction-1-future', 'synthetic-attribution-1-future', 'synthetic-scope-1-future',
    'synthetic-scope-3-future', 'synthetic-uncertainty-1-future', 'synthetic-irrelevance-4-future'];
  for (const id of syntheticIds) {
    const c = dev.find((item) => item.id === id);
    if (!c) throw new Error(`routine missing synthetic future-task case ${id}`);
    selected.push(c);
  }
  const publicCases = dev.filter((c) => c.source === 'longmemeval');
  for (const abstention of [false, true]) {
    const c = publicCases.filter((item) => item.id.endsWith('_abs') === abstention)
      .sort((a, b) => size(a) - size(b) || a.id.localeCompare(b.id))[0];
    if (!c) throw new Error(`routine missing public ${abstention ? 'abstention' : 'factual'} case`);
    selected.push(c);
  }
  return selected;
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
    'tools/memory-eval/replay-format.ts', 'tools/memory-eval/schema.ts', 'tools/memory-eval/budget.ts', 'package-lock.json',
  ];
  const workerSource = await readFile(join(repo, 'tools/memory-eval/worker.ts'), 'utf8');
  const buildSource = workerSource.split('function responseText(')[0];
  if (buildSource === workerSource) throw new Error('replay worker build boundary missing');
  return digest(JSON.stringify({ files: await Promise.all(files.map((file) => sourceHash(join(repo, file)))),
    workerBuild: digest(buildSource), resolved: await resolvedIngestionConfig() }));
}

async function readerConfigHash(): Promise<string> {
  const files = ['tools/memory-eval/worker.ts', 'tools/memory-eval/cli.ts', 'tools/memory-eval/auth.ts',
    'tools/memory-eval/diagnostics.ts', 'src/memory/tools.ts', 'src/memory/context.ts', 'package-lock.json'];
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

function oracleFor(c: Case, h: History): string {
  return permittedEvidence(c, h)
    .map((e) => `[${e.at}] ${e.role}; task=${e.taskId ?? 'unknown'}; audience=${JSON.stringify(e.audience ?? h.scope)}: ${e.text}`).join('\n\n') || '(no supporting evidence)';
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

async function run(): Promise<void> {
  const corpus = await loadCorpus();
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(`corpus invalid:\n${errors.join('\n')}`);
  await preflight();
  const caseId = process.argv[3] === '--case' ? process.argv[4] : undefined;
  const cases = caseId ? corpus.cases.filter((c) => c.id === caseId) : routineCases(corpus);
  if (!cases.length) throw new Error(`case not found: ${caseId}`);
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
          try { semantic = await worker({ mode: 'judge', case: c, answer: String((item as { answer?: string }).answer ?? ''),
            evidence: judgingEvidence(c, h), ledger: join(reportPath, 'budget.json'), capUsd: 10 }, { ARCHIE_MEMORY: 'false' }); }
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
  const expected = cases.length * 3;
  const ok = results.filter((r) => (r as { status?: string }).status === 'ok').length;
  type Result = { caseId?: string; arm?: string; status?: string; toolCalls?: number; latencyMs?: number; costUsd?: number; inputTokens?: number; outputTokens?: number;
    evidenceCoverage?: { expectedEvidence: number; referenceSurfaced: number; factualOverlapAtHalf: number; leakMarkers: string[] };
    semantic?: { status?: string; requiredMet?: boolean[]; forbiddenAsserted?: boolean[]; unsupportedClaims?: string[];
      contradictedClaims?: string[]; unverifiableClaims?: string[]; abstained?: boolean; costUsd?: number } };
  const rows = results as Result[];
  const success = (c: Case, r?: Result): boolean | null => {
    const s = r?.semantic;
    if (!r || r.status !== 'ok' || s?.status !== 'advisory' || !s.forbiddenAsserted || !s.unsupportedClaims
      || !s.contradictedClaims || !s.unverifiableClaims) return null;
    const explanationSupported = s.unsupportedClaims.length === 0 && s.contradictedClaims.length === 0 && s.unverifiableClaims.length === 0;
    if (c.id.endsWith('_abs')) return s.abstained === true && !s.forbiddenAsserted.some(Boolean) && explanationSupported;
    if (!s.requiredMet?.length) return null;
    return s.requiredMet.every(Boolean) && !s.forbiddenAsserted.some(Boolean) && explanationSupported;
  };
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
  await savePrivate(join(reportPath, 'report.json'), { ...manifest, status, executionStatus, gradingStatus, reviewStatus,
    qualityOutcome: 'not_gated', expectedArms: expected, completedArms: ok, judgedArms: judged,
    missingOrFailedArms: expected - ok, fixedRetrievalCompleted: fixedOk, fixedRetrievalExpected: cases.length, breakdown });
  const sourceRows = Object.entries(breakdown).filter(([k]) => k.startsWith('source:'))
    .map(([k, r]) => `| ${k.slice(7)} | ${r.armsOk}/${r.expectedArms} | ${r.judgedArms}/${r.expectedArms} | ${r.noMemorySuccess}/${r.cases} | ${r.candidateSuccess}/${r.cases} | ${r.oracleSuccess}/${r.cases} | ${r.pairedWins} | ${r.pairedRegressions} | ${r.pairUnscored} | ${r.candidateUnsupported}/${r.candidateContradicted}/${r.candidateUnverifiable} | ${r.retainedCanonical}/${r.expectedEvidence} | ${r.fixedReferenceSurfaced}/${r.expectedEvidence} | ${r.fixedFactualOverlap}/${r.expectedEvidence} | $${(r.readerCostUsd + r.judgeCostUsd).toFixed(4)} |`).join('\n');
  const md = `# Memory evaluation routine run\n\n- Run: ${runId}\n- Execution: ${executionStatus}; ${ok}/${expected} answer arms, ${fixedOk}/${cases.length} fixed retrieval calls\n- Grading: ${gradingStatus}; ${judged}/${expected} semantic verdicts\n- Review: ${reviewStatus}; quality outcome not gated\n- Overall status: ${status}\n- Corpus SHA-256: ${manifest.corpusHash}\n- Config SHA-256: ${manifest.configHash}\n- Models: ${manifest.reader} reader, ${manifest.extractor} extractor\n\n| Source | Arms | Judged | No memory | Candidate | Oracle | Wins | Regressions | Unscored | Candidate unsupported/contradicted/unverifiable | Canonical retained | Fixed references | Fixed lexical evidence | Reader + judge cost |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${sourceRows}\n\nReference surfacing and lexical overlap are diagnostics, not proof of factual correctness. Abstention success requires both appropriate refusal and a supported explanation. Full slices, tool traces, tokens, latency, and leak markers are in report.json, results.json, and fixed-retrieval.json.\n`;
  await savePrivate(join(reportPath, 'report.md'), md);
  await writeCalibrationPacket(reportPath, cases, byId, rows);
  process.stdout.write(`${reportPath}\n`);
  if (status === 'incomplete') process.exitCode = 1;
}

async function writeCalibrationPacket(reportPath: string, cases: Case[], histories: Map<string, History>,
  rows: Array<{ caseId?: string; arm?: string; status?: string; answer?: string; semantic?: unknown }>): Promise<void> {
  const chosen = cases.flatMap((c) => {
    const arms = ['candidate', 'no_memory', 'oracle'].filter((arm) =>
      arm !== 'oracle' || c.source === 'longmemeval' || c.ability.includes('scope'));
    return arms.map((arm) => ({ c, arm, result: rows.find((r) => r.caseId === c.id && r.arm === arm) }));
  }).filter(({ result }) => result?.status === 'ok');
  const reviewer = ['# Independent answer calibration', '',
    'Judge each answer using the original evidence below. Record claim-level findings before opening `calibration-model-verdicts.json`. The answers are anonymous with respect to evaluation arm.',
    'A missing or failed answer arm is absent from this packet and remains a failure in the run report.', ''];
  const verdicts: unknown[] = [];
  for (const [index, { c, arm, result }] of chosen.entries()) {
    const id = `sample-${String(index + 1).padStart(2, '0')}`;
    const h = histories.get(c.historyId)!;
    reviewer.push(`## ${id}`, '', `- Case: ${c.id}`, `- Source/workload/ability: ${c.source} / ${c.workload} / ${c.ability}`,
      `- Current task context: ${c.currentContext || '(none)'}`, `- Question: ${c.question}`, `- Required claims: ${c.required.join('; ') || '(none)'}`,
      `- Forbidden claims: ${c.forbidden.join('; ') || '(none)'}`, `- Answer: ${JSON.stringify(result!.answer ?? '')}`,
      '- Required claims supported and answered (one decision per claim):', '- Forbidden claims asserted (one decision per claim):',
      '- Unsupported answer claims:', '- Contradicted answer claims:', '- Unverifiable answer claims:',
      '- Appropriate abstention, if applicable: [ ] yes [ ] no [ ] not applicable',
      '- Useful for the new task: [ ] yes [ ] no [ ] unclear', '- Notes:', '',
      '### Complete authorized original evidence', '', '```text', judgingEvidence(c, h), '```', '');
    verdicts.push({ sampleId: id, caseId: c.id, arm, modelVerdict: result!.semantic });
  }
  await savePrivate(join(reportPath, 'calibration-review.md'), reviewer.join('\n'));
  await savePrivate(join(reportPath, 'calibration-model-verdicts.json'), verdicts);
  await savePrivate(join(reportPath, 'calibration-disagreements.md'),
    '# Calibration disagreement report\n\nComplete after independent human review. Compare each claim-level decision with `calibration-model-verdicts.json`.\n\n| Sample | Required | Forbidden | Unsupported | Contradicted | Unverifiable | Abstention | Task usefulness | Resolution |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n\nDo not promote advisory scores to quality gates until disagreements and source-label decisions are resolved.\n');
}

async function buildOnly(): Promise<void> {
  const corpus = await loadCorpus();
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(errors.join('\n'));
  await preflight();
  const caseId = process.argv[3] === '--case' ? process.argv[4] : undefined;
  const cases = caseId ? corpus.cases.filter((c) => c.id === caseId) : routineCases(corpus);
  if (!cases.length) throw new Error(`case not found: ${caseId}`);
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

async function draft(): Promise<void> {
  const longmem = join(root, 'public-source', 'longmemeval_s_cleaned.json');
  const oracle = join(root, 'public-source', 'longmemeval_oracle.json');
  const archie = await withVerifiedSource((path) => draftArchie(path, root));
  const parts = [archie, syntheticCorpus(), await importLongMemEval(longmem, oracle)];
  const corpus = combine(parts, { archiveSha256: ARCHIVE_SHA, publicSha256: await sourceHash(longmem), capture: '2026-09-26T02:24:39Z',
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
      if (old?.reason?.startsWith('Model-drafted') && JSON.stringify(old.evidence.map(({ ref, start, end }) => ({ ref, start, end }))) === JSON.stringify(c.evidence.map(({ ref, start, end }) => ({ ref, start, end })))) {
        c.question = redact(old.question); c.required = old.required.map(redact); c.forbidden = old.forbidden.map(redact); c.ability = old.ability;
        c.reason = `${old.reason}; historical authorization unverified`;
      }
    }
    for (const c of corpus.cases.filter((item) => item.source === 'archie' && item.taskKind === 'future_task')) {
      const anchor = corpus.cases.find((item) => item.historyId === c.historyId && item.taskKind !== 'future_task' && item.required.length > 0);
      if (anchor) { c.required = [...anchor.required]; c.forbidden = [...anchor.forbidden]; }
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
  else if (command === 'report') await reportExisting();
  else process.stdout.write('Usage: npm run memory:eval -- inventory|import|draft|labels|validate|build|run [--case ID]|report [RUN_ID]\n');
} catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
