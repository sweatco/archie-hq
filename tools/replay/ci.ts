// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const environmentName = 'production-replay';
const corpusFile = '.github/replay/corpus.enc';
const envelope = Buffer.from('archie-replay/v1\n');
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function requireThat(condition: unknown): asserts condition { if (!condition) throw new Error('Replay CI validation failed'); }
type Json = Record<string, any>;
export type Api = (path: string, body?: Json) => Promise<any>;
export interface Plan {
  repo: string; pr: number; base: string; head: string; headRepo: string; harness: string; corpus: string; encrypted: string; config: Json; configHash: string;
  environment: number; run: number; upstream: number;
}

export function githubApi(repository: string, token: string): Api {
  requireThat(/^[\w.-]+\/[\w.-]+$/.test(repository));
  return async (path, body) => {
    requireThat(path.startsWith('/') && !path.includes('..'));
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireThat(response.ok);
    return response.json();
  };
}

async function pages(api: Api, path: string): Promise<any[]> {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const rows = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    requireThat(Array.isArray(rows));
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error('Replay CI validation failed');
}

async function protectedEnvironment(api: Api) {
  const environment = await api(`/environments/${environmentName}`);
  requireThat(Number.isSafeInteger(environment.id) && environment.name === environmentName
    && environment.can_admins_bypass !== true
    && environment.protection_rules?.some((rule: Json) => rule.type === 'required_reviewers' && rule.reviewers?.length > 0));
  return environment.id as number;
}

function validConfig(value: Json) {
  requireThat(Object.keys(value).sort().join(',') === 'effort,maxTurns,model,sample,timeoutMs'
    && typeof value.model === 'string' && /^[\w.-]{1,100}$/.test(value.model) && ['low', 'medium', 'high'].includes(value.effort)
    && Number.isInteger(value.maxTurns) && value.maxTurns >= 1 && value.maxTurns <= 100
    && Number.isInteger(value.timeoutMs) && value.timeoutMs >= 1000 && value.timeoutMs <= 1800000
    && Number.isInteger(value.sample) && value.sample >= 1 && value.sample <= 100);
  return value;
}

function validPlan(plan: Plan) {
  requireThat(/^[\w.-]+\/[\w.-]+$/.test(plan.repo) && /^[\w.-]+\/[\w.-]+$/.test(plan.headRepo) && Number.isSafeInteger(plan.pr) && plan.pr > 0
    && [plan.base, plan.head, plan.harness].every((value) => sha.test(value)) && digest.test(plan.corpus) && digest.test(plan.encrypted)
    && [plan.environment, plan.run, plan.upstream].every((value) => Number.isSafeInteger(value) && value > 0)
    && hash(JSON.stringify(validConfig(plan.config))) === plan.configHash);
  return plan;
}

function matches(pr: Json, run: Json, repository: string) {
  return pr.state === 'open' && pr.base?.repo?.full_name === repository && sha.test(pr.base.sha)
    && pr.head?.sha === run.head_sha && pr.head?.repo?.full_name === run.head_repository?.full_name
    && pr.head?.ref === run.head_branch;
}

export async function prepare(api: Api, event: Json, context: { repo: string; harness: string; corpus: string; encrypted: string; config: Json; run: number; attempt: number }): Promise<Plan> {
  requireThat(context.attempt === 1 && event.action === 'completed' && event.repository?.full_name === context.repo);
  const run = await api(`/actions/runs/${event.workflow_run?.id}`);
  const workflow = await api('/actions/workflows/replay-pr.yml');
  requireThat(run.id === event.workflow_run.id && run.workflow_id === workflow.id && workflow.path === '.github/workflows/replay-pr.yml'
    && run.repository?.full_name === context.repo && run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success'
    && run.head_sha === event.workflow_run.head_sha && sha.test(run.head_sha));
  const numbers = run.pull_requests?.map((pr: Json) => pr.number) ?? [];
  const candidates = numbers.length ? await Promise.all(numbers.map((number: number) => api(`/pulls/${number}`)))
    : await pages(api, '/pulls?state=open');
  const eligible = candidates.filter((pr: Json) => matches(pr, run, context.repo));
  requireThat(eligible.length === 1);
  const pr = await api(`/pulls/${eligible[0].number}`);
  requireThat(matches(pr, run, context.repo));
  return validPlan({ repo: context.repo, pr: pr.number, base: pr.base.sha, head: pr.head.sha, headRepo: pr.head.repo.full_name, harness: context.harness,
    corpus: context.corpus, encrypted: context.encrypted, config: context.config, configHash: hash(JSON.stringify(context.config)),
    environment: await protectedEnvironment(api), run: context.run, upstream: run.id });
}

export async function current(api: Api, plan: Plan) {
  validPlan(plan);
  const pr = await api(`/pulls/${plan.pr}`);
  requireThat(pr.state === 'open' && pr.base?.repo?.full_name === plan.repo && pr.head?.repo?.full_name === plan.headRepo
    && pr.head?.sha === plan.head && pr.base?.sha === plan.base);
}

export async function verify(api: Api, plan: Plan, context: { repo: string; harness: string; encrypted: string; config: Json; run: number; attempt: number }) {
  validPlan(plan);
  requireThat(context.attempt === 1 && context.repo === plan.repo && context.harness === plan.harness && context.run === plan.run && context.encrypted === plan.encrypted
    && hash(JSON.stringify(context.config)) === plan.configHash && await protectedEnvironment(api) === plan.environment);
  await current(api, plan);
  const history = await pages(api, `/actions/runs/${plan.run}/approvals`);
  const reviews = history.filter((review: Json) => review.environments?.some((environment: Json) => environment.id === plan.environment));
  requireThat(reviews.length > 0 && reviews.every((review: Json) => review.state === 'approved'));
  let maintainer = false;
  for (const review of reviews) {
    requireThat(review.user?.type === 'User' && /^[\w-]+$/.test(review.user.login));
    const permission = await api(`/collaborators/${encodeURIComponent(review.user.login)}/permission`);
    if (['admin', 'maintain'].includes(permission.role_name)) maintainer = true;
  }
  requireThat(maintainer);
}

function capture(bytes: Buffer) {
  requireThat(bytes.length <= 64 * 1024 * 1024);
  const capture = JSON.parse(bytes.toString());
  requireThat(capture.schema === 'archie-session-capture/v1' && Array.isArray(capture.sessions) && capture.sessions.length > 0);
  return capture;
}

export function encryptCorpus(bytes: Buffer, key: Buffer): Buffer {
  capture(bytes); requireThat(key.length === 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(envelope);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(bytes)), cipher.final()]);
  return Buffer.concat([envelope, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decodeCorpus(encrypted: Buffer, encodedKey: string, expected: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64'), offset = envelope.length;
  requireThat(key.length === 32 && key.toString('base64') === encodedKey && encrypted.length > offset + 28 && encrypted.subarray(0, offset).equals(envelope));
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(offset, offset + 12));
  decipher.setAAD(envelope); decipher.setAuthTag(encrypted.subarray(offset + 12, offset + 28));
  const compressed = Buffer.concat([decipher.update(encrypted.subarray(offset + 28)), decipher.final()]);
  const bytes = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  requireThat(hash(bytes) === expected); capture(bytes);
  return bytes;
}

const number = (value: unknown) => { requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER); return value; };
const count = (value: unknown) => { const result = number(value); requireThat(Number.isSafeInteger(result)); return result; };

export function project(summary: Json, rows: Json[], expected: number, session: boolean) {
  requireThat(Array.isArray(rows) && summary.expectedResults === expected && summary.savedResults === rows.length);
  const arms = (['baseline', 'candidate'] as const).map((variant) => {
    const selected = rows.filter((row) => row.variant === variant);
    let usd: number | null = 0;
    const aggregate = { completed: selected.length, passed: 0, words: 0, elapsedMs: 0, sdkUsd: usd, recordedExpected: 0, recordedConsumed: 0 };
    for (const row of selected) {
      requireThat(row.checks && Object.keys(row.checks).length > 0 && Object.values(row.checks).every((check) => typeof check === 'boolean'));
      aggregate.passed += Number(Object.values(row.checks).every(Boolean));
      aggregate.words += count(row.result.words); aggregate.elapsedMs += number(row.result.elapsedMs);
      usd = usd === null || row.result.usage.sdkUsd === null ? null : usd + number(row.result.usage.sdkUsd);
      if (session) {
        aggregate.recordedExpected += count(row.result.recordings?.expected);
        aggregate.recordedConsumed += count(row.result.recordings?.consumed);
        requireThat(typeof row.result.recordings.complete === 'boolean' && row.checks.recordings === row.result.recordings.complete);
      }
    }
    return { ...aggregate, sdkUsd: usd };
  });
  const ids = rows.map((row) => `${row.episode.id}:${row.variant}`);
  const baselineIds = rows.filter((row) => row.variant === 'baseline').map((row) => row.episode.id).sort();
  const candidateIds = rows.filter((row) => row.variant === 'candidate').map((row) => row.episode.id).sort();
  const complete = summary.complete === true && rows.length === expected && new Set(ids).size === expected
    && JSON.stringify(baselineIds) === JSON.stringify(candidateIds) && arms.every((arm) => arm.completed * 2 === expected);
  const passed = complete && summary.passed === true && summary.runnerExit === 0 && summary.runnerSignal === null
    && summary.runnerError === null && summary.reportError === null && Array.isArray(summary.failed) && summary.failed.length === 0
    && arms.every((arm) => arm.passed === arm.completed && (!session || arm.recordedExpected === arm.recordedConsumed));
  return { status: passed ? 'passed' : 'failed', expected: count(expected), completed: rows.length, baseline: arms[0], candidate: arms[1] };
}

export function publicProjection(value: Json) {
  requireThat(['passed', 'failed', 'unsupported', 'error'].includes(value.status));
  const clean: Json = { status: value.status };
  for (const name of ['corpusSessions', 'sampleSessions']) if (value[name] !== undefined) clean[name] = count(value[name]);
  for (const name of ['components', 'sessions']) if (value[name]) {
    const source = value[name];
    requireThat(['passed', 'failed'].includes(source.status));
    const section: Json = { status: source.status, expected: count(source.expected), completed: count(source.completed) };
    for (const arm of ['baseline', 'candidate']) {
      section[arm] = {};
      for (const key of ['completed', 'passed', 'words', 'recordedExpected', 'recordedConsumed']) section[arm][key] = count(source[arm][key]);
      section[arm].elapsedMs = number(source[arm].elapsedMs);
      section[arm].sdkUsd = source[arm].sdkUsd === null ? null : number(source[arm].sdkUsd);
    }
    clean[name] = section;
  }
  requireThat(value.status !== 'passed' || clean.components?.status === 'passed' && clean.sessions?.status === 'passed');
  return clean;
}

function privateCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string) {
  const fd = openSync(log, 'a', 0o600);
  try { return spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout: 115 * 60 * 1000 }).status === 0; }
  finally { closeSync(fd); }
}

async function evaluate(api: Api, plan: Plan, context: Parameters<typeof verify>[2]) {
  const harness = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workspace = dirname(harness);
  const roots = [harness, join(workspace, 'baseline'), join(workspace, 'candidate')];
  const temporary = mkdtempSync(join(tmpdir(), 'archie-replay-ci-'));
  let projection: Json = { status: 'error' };
  try {
    await verify(api, plan, context);
    const log = join(temporary, 'private.log');
    const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, CI: 'true', NO_COLOR: '1' };
    for (let i = 0; i < roots.length; i++) {
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: roots[i], env, encoding: 'utf8' });
      requireThat(revision.status === 0 && revision.stdout.trim() === [plan.harness, plan.base, plan.head][i]);
    }
    const required = ['src/tasks/task.ts', 'src/agents/task-usage.ts', 'src/proactivity/store.ts', 'src/proactivity/service.ts',
      'src/proactivity/recall.ts', 'src/memory/store.ts', 'src/memory/context.ts', 'src/memory/task-authors.ts'];
    if (roots.slice(1).some((root) => required.some((file) => !existsSync(join(root, file))))) return { status: 'unsupported' };
    for (const root of roots) requireThat(privateCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, env, log));
    const run = (args: string[], extra: NodeJS.ProcessEnv, expected: number, sessions: boolean) => {
      const before = new Set(existsSync(join(harness, '.replay')) ? readdirSync(join(harness, '.replay')) : []);
      const success = privateCommand(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', ...args], harness, { ...env, REPLAY_CONFIG: JSON.stringify(plan.config), ...extra }, log);
      const created = readdirSync(join(harness, '.replay')).filter((name) => !before.has(name));
      requireThat(created.length === 1);
      const output = join(harness, '.replay', created[0]);
      const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
      const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
      requireThat(manifest.revision === plan.harness && digest.test(manifest.sourceHash) && digest.test(manifest.datasetHash) && manifest.runtimeSources?.length === 2
        && new Set(manifest.runtimeSources.map((arm: Json) => arm.name)).size === 2
        && manifest.runtimeSources.every((arm: Json) => digest.test(arm.sourceHash) && arm.revision === (arm.name === 'baseline' ? plan.base : arm.name === 'candidate' ? plan.head : null))
        && manifest.config.model === plan.config.model && manifest.config.effort === plan.config.effort
        && (!sessions || manifest.config.maxTurns === plan.config.maxTurns && manifest.config.timeoutMs === plan.config.timeoutMs && manifest.config.sample === plan.config.sample));
      const rows = readFileSync(join(output, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const section = project(summary, rows, expected, sessions);
      if (!success) section.status = 'failed';
      return section;
    };
    projection.components = run(['compare-components', roots[1], roots[2]], {}, 20, false);
    if (projection.components.status !== 'passed') return { ...projection, status: 'failed' };
    // Recheck immediately before opening the corpus or making model calls; installs may have taken minutes.
    await verify(api, plan, context);
    const encrypted = readFileSync(join(harness, corpusFile));
    requireThat(hash(encrypted) === plan.encrypted);
    const bytes = decodeCorpus(encrypted, process.env.REPLAY_CORPUS_KEY ?? '', plan.corpus);
    projection.corpusSessions = capture(bytes).sessions.length;
    projection.sampleSessions = Math.min(projection.corpusSessions, plan.config.sample);
    requireThat(Boolean(process.env.ANTHROPIC_API_KEY));
    const snapshot = join(temporary, 'snapshot.json');
    writeFileSync(snapshot, bytes, { mode: 0o600 });
    projection.sessions = run(['compare', snapshot, roots[1], roots[2]], { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      projection.sampleSessions * 2, true);
    projection.status = projection.sessions.status;
    return projection;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(join(harness, '.replay'), { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'encrypt') {
    const [input, encryptedPath, keyPath] = process.argv.slice(3);
    requireThat(input && encryptedPath && keyPath && resolve(encryptedPath) !== resolve(keyPath) && !existsSync(encryptedPath) && !existsSync(keyPath));
    const key = randomBytes(32), encrypted = encryptCorpus(readFileSync(input), key);
    writeFileSync(encryptedPath, encrypted, { mode: 0o600, flag: 'wx' });
    try { writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { rmSync(encryptedPath); throw error; }
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY!;
  const api = githubApi(repo, process.env.GH_TOKEN!);
  const context = { repo, harness: process.env.REPLAY_HARNESS!, encrypted: hash(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', corpusFile))),
    config: validConfig(JSON.parse(process.env.REPLAY_CONFIG!)), run: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  const output = (name: string, value: unknown) => appendFileSync(process.env.GITHUB_OUTPUT!, `${name}=${JSON.stringify(value)}\n`);
  const summary = (value: unknown) => appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `${JSON.stringify(value, null, 2)}\n`);
  if (command === 'plan') {
    const plan = await prepare(api, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8')), { ...context, corpus: process.env.REPLAY_CORPUS_SHA256! });
    output('plan', plan); output('pr', plan.pr);
    summary({ approval: 'required', ...plan });
    return;
  }
  const plan = validPlan(JSON.parse(process.env.REPLAY_PLAN!));
  requireThat(plan.repo === repo && plan.harness === context.harness && plan.run === context.run);
  if (command === 'verify') return verify(api, plan, context);
  if (command === 'evaluate') {
    let projection: Json;
    try { projection = publicProjection(await evaluate(api, plan, context)); }
    catch { projection = { status: 'error' }; }
    output('projection', projection); summary(projection);
    process.exitCode = projection.status === 'passed' ? 0 : 1;
    return;
  }
  requireThat(command === 'pending' || command === 'report');
  // Reporting jobs serialize on head SHA; a fresh intake can reuse both revisions.
  try { await current(api, plan); } catch { return; }
  const statuses = await api(`/commits/${plan.head}/status`);
  requireThat(Array.isArray(statuses.statuses));
  const previous = statuses.statuses.find((status: Json) => status.context === 'Production replay');
  if (previous) {
    const prefix = `https://github.com/${repo}/actions/runs/`;
    requireThat(typeof previous.target_url === 'string' && previous.target_url.startsWith(prefix));
    const owner = previous.target_url.slice(prefix.length);
    requireThat(/^\d+$/.test(owner) && Number.isSafeInteger(Number(owner)));
    if (Number(owner) !== plan.run) {
      const runs = await Promise.all([api(`/actions/runs/${owner}`), api(`/actions/runs/${plan.run}`)]);
      requireThat(runs[0].workflow_id === runs[1].workflow_id && runs.every((run, i) => run.id === [Number(owner), plan.run][i]
        && Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0 && typeof run.path === 'string' && run.path.split('@')[0] === '.github/workflows/replay.yml'
        && run.event === 'workflow_run' && run.repository?.full_name === repo
        && Number.isSafeInteger(run.run_number) && run.run_number > 0));
      if (runs[0].run_number > runs[1].run_number) return;
    }
  }
  const projection = command === 'report' && process.env.REPLAY_PROJECTION ? publicProjection(JSON.parse(process.env.REPLAY_PROJECTION)) : { status: 'error' };
  const passed = command === 'report' && process.env.REPLAY_JOB_RESULT === 'success' && projection.status === 'passed';
  await api(`/statuses/${plan.head}`, { state: command === 'pending' ? 'pending' : passed ? 'success' : 'failure', context: 'Production replay',
    description: command === 'pending' ? 'Awaiting maintainer approval and evaluation' : passed ? 'Required replay gates passed' : 'Evaluation did not pass; see workflow',
    target_url: `https://github.com/${repo}/actions/runs/${plan.run}` });
  if (command === 'report') summary(projection);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Replay CI stopped: validation or configuration failed.\n'); process.exitCode = 1; });
}
