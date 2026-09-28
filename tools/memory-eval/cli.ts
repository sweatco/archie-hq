import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { combine, draftArchie, importLongMemEval, inventory, syntheticCorpus } from './corpus.js';
import { checkpointKey, digest, permittedEvidence, validateCorpus, visibleAt, type Case, type Corpus, type History } from './schema.js';
import { PRICING } from './budget.js';
import { draftRealLabels } from './labels.js';

const command = process.argv[2] ?? 'help';
const root = resolve(process.env.ARCHIE_EVAL_HOME ?? '/Users/igorsova/Projects/achie-snapshots/memory-eval');
const source = join(root, 'source');
const corpusPath = join(root, 'corpus.json');
const repo = resolve(import.meta.dirname, '../..');
const keySource = process.env.ARCHIE_EVAL_ENV_FILE ?? '/Users/igorsova/Projects/archie-hq/.env';

async function loadCorpus(): Promise<Corpus> { return JSON.parse(await readFile(corpusPath, 'utf8')) as Corpus; }
async function savePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function sourceHash(path: string): Promise<string> { return digest(await readFile(path)); }

function routineCases(corpus: Corpus): Case[] {
  const dev = corpus.cases.filter((c) => c.split === 'dev' && c.review !== 'quarantined');
  const counts: Record<string, number> = { archie: 6, synthetic: 4, longmemeval: 2 };
  const selected: Case[] = [];
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const size = (c: Case) => histories.get(c.historyId)!.completions.filter((step) => step.at <= c.queryAt).length;
  for (const [source, n] of Object.entries(counts)) {
    const candidates = dev.filter((c) => c.source === source);
    const grouped = new Map<string, Case[]>();
    for (const c of candidates) grouped.set(c.family, [...(grouped.get(c.family) ?? []), c]);
    const unique = source === 'longmemeval'
      ? [
        candidates.filter((c) => !c.id.endsWith('_abs')).sort((a, b) => size(a) - size(b) || a.id.localeCompare(b.id))[0],
        candidates.filter((c) => c.id.endsWith('_abs')).sort((a, b) => size(a) - size(b) || a.id.localeCompare(b.id))[0],
      ].filter((c): c is Case => !!c)
      : [...grouped.values()].map((group) => source === 'archie'
        ? group.filter((c) => c.required.length > 0).sort((a, b) => size(a) - size(b) || a.id.localeCompare(b.id))[0] ?? group[0]
        : group[0].family === 'synthetic-irrelevance' ? group.find((c) => c.id.endsWith('-4')) ?? group[0] : group[0]);
    if (unique.length < n) throw new Error(`routine needs ${n} distinct ${source} dev families, found ${unique.length}`);
    selected.push(...unique.slice(0, n));
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

async function configHash(): Promise<string> {
  const files = [
    'src/memory/extractor.ts', 'src/memory/lifecycle.ts', 'src/memory/sanitize.ts',
    'src/memory/store.ts', 'src/memory/entities.ts', 'src/memory/task-summaries.ts',
    'src/memory/housekeeping.ts', 'src/memory/tools.ts', 'src/memory/context.ts',
    'src/memory/clock.ts', 'src/memory/annotations.ts', 'src/memory/activity.ts',
    'src/memory/entity-index.ts', 'src/memory/pending-queue.ts', 'src/memory/task-authors.ts',
    'prompts/memory-extractor.md', 'prompts/memory-housekeeper.md',
    'tools/memory-eval/worker.ts', 'tools/memory-eval/corpus.ts', 'tools/memory-eval/schema.ts',
  ];
  return digest((await Promise.all(files.map((file) => sourceHash(join(repo, file))))).join(':'));
}

async function checkpoint(history: History, cutoff: string): Promise<{ path: string; hash: string; built: boolean }> {
  const visible = { ...history, events: visibleAt(history, cutoff), completions: history.completions.filter((c) => c.at <= cutoff) };
  const hash = checkpointKey(history, cutoff, await configHash(), 'claude-sonnet-5', PRICING);
  const path = join(root, 'checkpoints', hash);
  try { await stat(join(path, 'manifest.json')); return { path, hash, built: false }; } catch { /* build */ }
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
    await savePrivate(join(staging, 'manifest.json'), { historyId: history.id, cutoff, hash, configHash: await configHash(), model: 'claude-sonnet-5', receipt });
    for (const name of await readdir(staging)) if (/^step-\d+$/.test(name)) await rm(join(staging, name), { recursive: true, force: true });
    await rename(staging, path);
  } catch (error) { await savePrivate(join(staging, 'last-error.txt'), String(error)); throw error; }
  return { path, hash, built: true };
}

function oracleFor(c: Case, h: History): string {
  return permittedEvidence(c, h)
    .map((e) => `[${e.at}] ${e.role}; task=${e.taskId ?? 'unknown'}; audience=${JSON.stringify(e.audience ?? h.scope)}: ${e.text}`).join('\n\n') || '(no supporting evidence)';
}

function deterministicScore(c: Case, answer: string) {
  if (c.required.length === 0 && c.forbidden.length === 0) return { status: 'unscored', requiredHit: null, forbiddenHit: null };
  const lower = answer.toLowerCase();
  const requiredHit = c.required.map((x) => lower.includes(x.toLowerCase()));
  const forbiddenHit = c.forbidden.map((x) => lower.includes(x.toLowerCase()));
  return { status: c.review === 'approved' ? 'gate' : 'advisory', requiredHit, forbiddenHit,
    allRequired: requiredHit.every(Boolean), anyForbidden: forbiddenHit.some(Boolean) };
}

function evidenceCoverage(c: Case, h: History, item: { injection?: string; toolTrace?: Array<{ output?: string }> }) {
  const sourceTaskIds = [...new Set(c.evidence.map((span) => h.events.find((e) => e.source.ref === span.ref && e.source.start === span.start)?.taskId).filter((id): id is string => !!id))];
  if (!sourceTaskIds.length) return { sourceTaskIds: [], surfacedTaskIds: [], allSurfaced: null };
  const seen = `${item.injection ?? ''}\n${(item.toolTrace ?? []).map((x) => x.output ?? '').join('\n')}`;
  const surfacedTaskIds = sourceTaskIds.filter((id) => seen.includes(id));
  return { sourceTaskIds, surfacedTaskIds, allSurfaced: surfacedTaskIds.length === sourceTaskIds.length };
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
    corpusHash: await sourceHash(corpusPath), configHash: await configHash(), cases: cases.map((c) => c.id),
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
      fixedRetrieval.push({ caseId: c.id, status: 'ok', result: fixed });
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
            evidence: oracleFor(c, h), ledger: join(reportPath, 'budget.json'), capUsd: 10 }, { ARCHIE_MEMORY: 'false' }); }
          catch (error) { semantic = { status: 'error', error: String(error) }; }
        }
        const record = { ...item as object, checkpoint: ckpt.hash, score: deterministicScore(c, String((item as { answer?: string }).answer ?? '')),
          evidenceCoverage: arm === 'candidate' ? evidenceCoverage(c, h, item as { injection?: string; toolTrace?: Array<{ output?: string }> }) : undefined,
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
  type Result = { caseId?: string; arm?: string; status?: string; toolCalls?: number; latencyMs?: number; costUsd?: number;
    semantic?: { status?: string; requiredMet?: boolean[]; forbiddenAsserted?: boolean[]; unsupportedClaims?: string[]; abstained?: boolean } };
  const rows = results as Result[];
  const success = (c: Case, r?: Result): boolean | null => {
    const s = r?.semantic;
    if (!r || r.status !== 'ok' || s?.status !== 'advisory' || !s.forbiddenAsserted || !s.unsupportedClaims) return null;
    if (c.id.endsWith('_abs')) return s.abstained === true && !s.forbiddenAsserted.some(Boolean);
    if (!s.requiredMet?.length) return null;
    return s.requiredMet.every(Boolean) && !s.forbiddenAsserted.some(Boolean) && s.unsupportedClaims.length === 0;
  };
  const breakdown: Record<string, { cases: number; armsOk: number; expectedArms: number; noMemorySuccess: number; candidateSuccess: number; oracleSuccess: number; pairedWins: number; pairedRegressions: number; pairedTies: number; pairUnscored: number; toolCalls: number; latencyMs: number; costUsd: number }> = {};
  for (const c of cases) {
    for (const key of [`source:${c.source}`, `workload:${c.workload}`, `ability:${c.ability}`, `split:${c.split}`]) {
      const row = breakdown[key] ??= { cases: 0, armsOk: 0, expectedArms: 0, noMemorySuccess: 0, candidateSuccess: 0, oracleSuccess: 0, pairedWins: 0, pairedRegressions: 0, pairedTies: 0, pairUnscored: 0, toolCalls: 0, latencyMs: 0, costUsd: 0 };
      row.cases++; row.expectedArms += 3;
      const arms = rows.filter((r) => r.caseId === c.id && r.arm);
      row.armsOk += arms.filter((r) => r.status === 'ok').length;
      row.toolCalls += arms.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0);
      row.latencyMs += arms.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0);
      row.costUsd += arms.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
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
  await savePrivate(join(reportPath, 'report.json'), { ...manifest, status: ok === expected ? 'complete' : 'incomplete', expectedArms: expected,
    completedArms: ok, missingOrFailedArms: expected - ok, fixedRetrievalCompleted: fixedRetrieval.filter((r) => (r as { status: string }).status === 'ok').length,
    breakdown, reviewState: 'provisional' });
  const sourceRows = Object.entries(breakdown).filter(([k]) => k.startsWith('source:'))
    .map(([k, r]) => `| ${k.slice(7)} | ${r.armsOk}/${r.expectedArms} | ${r.noMemorySuccess}/${r.cases} | ${r.candidateSuccess}/${r.cases} | ${r.oracleSuccess}/${r.cases} | ${r.pairedWins} | ${r.pairedRegressions} | ${r.pairUnscored} | $${r.costUsd.toFixed(4)} |`).join('\n');
  const md = `# Memory evaluation routine run\n\n- Run: ${runId}\n- Coverage: ${ok}/${expected} arm results completed\n- Fixed retrieval: ${fixedRetrieval.filter((r) => (r as { status: string }).status === 'ok').length}/${cases.length} completed\n- Status: ${ok === expected ? 'complete' : 'incomplete'}\n- Semantic labels: provisional; human calibration pending\n- Corpus SHA-256: ${manifest.corpusHash}\n- Config SHA-256: ${manifest.configHash}\n- Models: ${manifest.reader} reader, ${manifest.extractor} extractor\n\n| Source | Arms complete | No memory success | Candidate success | Oracle success | Candidate wins | Candidate regressions | Unscored pairs | Reader cost |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${sourceRows}\n\nResults: results.json; fixed retrieval: fixed-retrieval.json; full breakdown: report.json.\n`;
  await savePrivate(join(reportPath, 'report.md'), md);
  process.stdout.write(`${reportPath}\n`);
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
}

async function reportExisting(): Promise<void> {
  const runId = process.argv[3] ?? (await (await import('node:fs/promises')).readdir(join(root, 'runs'))).sort().at(-1);
  if (!runId || runId.includes('/') || runId.includes('..')) throw new Error('invalid run ID');
  process.stdout.write(await readFile(join(root, 'runs', runId, 'report.md'), 'utf8'));
}

async function draft(): Promise<void> {
  const archive = '/Users/igorsova/Projects/achie-snapshots/archie-eval-source-20260926-022439Z.tgz';
  const actual = await sourceHash(archive);
  if (actual !== 'eb5b2e4d66e2954979bebf41db89878bfc8a5c4b5390dfc12dcdc23ec4f24907') throw new Error('archive SHA-256 mismatch');
  const longmem = join(root, 'public-source', 'longmemeval_s_cleaned.json');
  const oracle = join(root, 'public-source', 'longmemeval_oracle.json');
  const parts = [await draftArchie(source, root), syntheticCorpus(), await importLongMemEval(longmem, oracle)];
  const corpus = combine(parts, { archiveSha256: actual, publicSha256: await sourceHash(longmem), capture: '2026-09-26T02:24:39Z',
    oracleSha256: await sourceHash(oracle),
    note: 'Real-history scope is recorded current destination, not reconstructed historical authorization.' });
  try {
    const previous = await loadCorpus();
    const prior = new Map(previous.cases.map((c) => [c.id, c]));
    const pseudonyms = JSON.parse(await readFile(join(root, 'pseudonym-map.json'), 'utf8')) as Record<string, string>;
    const redact = (value: string) => Object.entries(pseudonyms).sort((a, b) => b[0].length - a[0].length)
      .reduce((text, [raw, alias]) => text.split(raw).join(alias), value);
    for (const c of corpus.cases) {
      const old = prior.get(c.id);
      if (old?.reason?.startsWith('Model-drafted') && JSON.stringify(old.evidence.map(({ ref, start, end }) => ({ ref, start, end }))) === JSON.stringify(c.evidence.map(({ ref, start, end }) => ({ ref, start, end })))) {
        c.question = redact(old.question); c.required = old.required.map(redact); c.forbidden = old.forbidden.map(redact); c.ability = old.ability; c.reason = old.reason;
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
  const take = (source: Case['source'], count: number) => corpus.cases.filter((c) => c.source === source).slice(0, count);
  const calibration = [...take('archie', 8), ...take('synthetic', 6), ...take('longmemeval', 6)];
  await savePrivate(join(root, 'calibration-sheet.md'), [
    '# Twenty-case human calibration set', '',
    'Review each case independently. Mark factual support, chronology, scope, required and forbidden claims. Do not mark semantic results as validated until this review is complete.', '',
    ...calibration.map((c) => `## ${c.id}\n\n- Question: ${c.question}\n- Required: ${c.required.join('; ') || '(draft needed)'}\n- Forbidden: ${c.forbidden.join('; ') || '(draft needed)'}\n- Source spans: ${c.evidence.map((s) => `${s.ref}:${s.start}-${s.end}`).join(', ') || '(none)'}\n- Decision: [ ] approve [ ] revise [ ] quarantine\n- Notes:\n`),
  ].join('\n'));
}

try {
  if (command === 'inventory') process.stdout.write(`${JSON.stringify(await inventory(source), null, 2)}\n`);
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
