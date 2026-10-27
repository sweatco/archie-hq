// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeCorpus, encryptCorpus, prepare, project, publicProjection, verify, type Api } from './ci.js';

const config = { model: 'claude-haiku-4-5-20251001', effort: 'low', maxTurns: 64, timeoutMs: 600000, sample: 5 };
const context = { repo: 'sweatco/archie-hq', harness: 'c'.repeat(40), corpus: 'd'.repeat(64), encrypted: 'e'.repeat(64), config, run: 200, attempt: 1 };
const pr = () => ({ number: 42, state: 'open', base: { sha: 'a'.repeat(40), repo: { full_name: context.repo } },
  head: { sha: 'b'.repeat(40), ref: 'feature', repo: { full_name: 'contributor/archie-hq' } } });
const upstream = () => ({ id: 100, workflow_id: 7, event: 'pull_request', repository: { full_name: context.repo },
  status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40), head_branch: 'feature',
  head_repository: { full_name: 'contributor/archie-hq' }, pull_requests: [{ number: 42 }] });
const event = () => ({ action: 'completed', repository: { full_name: context.repo }, workflow_run: { id: 100, head_sha: 'b'.repeat(40) } });
function fixture(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/actions/runs/100': upstream(), '/actions/workflows/replay-pr.yml': { id: 7, path: '.github/workflows/replay-pr.yml' }, '/pulls/42': pr(),
    '/environments/production-replay': { id: 10, name: 'production-replay', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Team' }] }] },
    '/actions/runs/200/approvals?per_page=100&page=1': [{ state: 'approved', environments: [{ id: 10 }], user: { login: 'maintainer', type: 'User' } }],
    '/collaborators/maintainer/permission': { permission: 'write', role_name: 'maintain' }, ...overrides,
  };
  const api: Api = vi.fn(async (path) => { if (!(path in routes)) throw new Error('private API error'); return structuredClone(routes[path]); });
  return { api, routes };
}

describe('trusted replay approval', () => {
  it('binds the full immutable tuple and accepts a maintainer despite legacy write permission', async () => {
    const { api } = fixture();
    const plan = await prepare(api, event(), context);
    expect(plan).toMatchObject({ pr: 42, base: 'a'.repeat(40), head: 'b'.repeat(40), headRepo: 'contributor/archie-hq', harness: context.harness, corpus: context.corpus, config, run: 200, environment: 10 });
    await expect(verify(api, plan, context)).resolves.toBeUndefined();
  });

  it('maps an empty fork pull_requests hint through the paginated open-PR API', async () => {
    const run = upstream(); run.pull_requests = [];
    const { api } = fixture({ '/actions/runs/100': run, '/pulls?state=open&per_page=100&page=1': [pr()] });
    expect((await prepare(api, event(), context)).pr).toBe(42);
  });

  it('rejects ambiguous fork mappings', async () => {
    const run = upstream(); run.pull_requests = [];
    const { api } = fixture({ '/actions/runs/100': run, '/pulls?state=open&per_page=100&page=1': [pr(), { ...pr(), number: 43 }] });
    await expect(prepare(api, event(), context)).rejects.toThrow();
  });

  it('finds a unique fork PR after the first API page', async () => {
    const run = upstream(); run.pull_requests = [];
    const unrelated = Array.from({ length: 100 }, (_, i) => ({ ...pr(), number: i + 100, head: { ...pr().head, sha: 'e'.repeat(40) } }));
    const { api } = fixture({ '/actions/runs/100': run, '/pulls?state=open&per_page=100&page=1': unrelated, '/pulls?state=open&per_page=100&page=2': [pr()] });
    expect((await prepare(api, event(), context)).pr).toBe(42);
  });

  it.each([
    ['wrong workflow', { workflow_id: 8 }], ['wrong event', { event: 'push' }], ['wrong repository', { repository: { full_name: 'attacker/repo' } }],
    ['failed intake', { conclusion: 'failure' }], ['changed head', { head_sha: 'e'.repeat(40) }], ['wrong fork', { head_repository: { full_name: 'attacker/repo' } }],
  ])('rejects %s before approval', async (_name, patch) => {
    const { api } = fixture({ '/actions/runs/100': { ...upstream(), ...patch } });
    await expect(prepare(api, event(), context)).rejects.toThrow();
  });

  it.each([
    ['missing required reviewers', { id: 10, name: 'production-replay', protection_rules: [] }],
    ['admin bypass enabled', { id: 10, name: 'production-replay', can_admins_bypass: true, protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] }],
  ])('rejects %s', async (_name, environment) => {
    const { api } = fixture({ '/environments/production-replay': environment });
    await expect(prepare(api, event(), context)).rejects.toThrow();
  });

  it.each(['write', 'read', 'triage', undefined])('rejects approval role %s even with legacy write permission', async (role_name) => {
    const { api } = fixture({ '/collaborators/maintainer/permission': { permission: 'write', role_name } });
    const plan = await prepare(api, event(), context);
    await expect(verify(api, plan, context)).rejects.toThrow();
  });

  it('does not treat an environment bypass or approval for another environment as approval', async () => {
    for (const history of [[], [{ state: 'approved', environments: [{ id: 11 }], user: { login: 'maintainer', type: 'User' } }]]) {
      const { api } = fixture({ '/actions/runs/200/approvals?per_page=100&page=1': history });
      await expect(verify(api, await prepare(api, event(), context), context)).rejects.toThrow();
    }
  });

  it.each(['head', 'base', 'closed', 'environment', 'config', 'encrypted', 'rerun'])('rejects %s changes after approval', async (change) => {
    const { api, routes } = fixture();
    const plan = await prepare(api, event(), context);
    const changed = pr();
    if (change === 'head') changed.head.sha = 'e'.repeat(40);
    if (change === 'base') changed.base.sha = 'e'.repeat(40);
    if (change === 'closed') changed.state = 'closed';
    routes['/pulls/42'] = changed;
    if (change === 'environment') routes['/environments/production-replay'] = { id: 99, name: 'production-replay', protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] };
    await expect(verify(api, plan, { ...context, ...(change === 'config' ? { config: { ...config, maxTurns: 2 } } : {}), ...(change === 'encrypted' ? { encrypted: 'f'.repeat(64) } : {}), ...(change === 'rerun' ? { attempt: 2 } : {}) })).rejects.toThrow();
  });

  it('fails API errors closed without propagating private error text to the CLI contract', async () => {
    const api: Api = async () => { throw new Error('private API response'); };
    await expect(prepare(api, event(), context)).rejects.toThrow();
  });
});

const row = (variant: string, id = 'private-session') => ({ variant, episode: { id, input: 'private prompt' }, checks: { execution: true, recordings: true },
  result: { words: 5, elapsedMs: 10, usage: { sdkUsd: 0.1 }, recordings: { expected: 2, consumed: 2, complete: true, errors: [] }, posts: ['private answer'], errors: [] } });
const summary = () => ({ expectedResults: 2, savedResults: 2, complete: true, passed: true, runnerExit: 0, runnerSignal: null, runnerError: null, reportError: null, failed: [], secret: 'private summary' });

describe('private corpus and public results', () => {
  it('authenticates and preserves the entire corpus, independently of the PR sample size', () => {
    const bytes = Buffer.from(JSON.stringify({ schema: 'archie-session-capture/v1', sessions: Array.from({ length: 19 }, (_, i) => ({ id: `private-${i}` })) }));
    const key = Buffer.alloc(32, 1), encrypted = encryptCorpus(bytes, key);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(decodeCorpus(encrypted, key.toString('base64'), hash)).toEqual(bytes);
    expect(encrypted.includes(Buffer.from('private'))).toBe(false);
    expect(() => decodeCorpus(encrypted, key.toString('base64'), '0'.repeat(64))).toThrow();
    expect(() => decodeCorpus(encrypted, Buffer.alloc(32, 2).toString('base64'), hash)).toThrow();
    const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 1;
    expect(() => decodeCorpus(corrupt, key.toString('base64'), hash)).toThrow();
    expect(() => decodeCorpus(encrypted, key.toString('base64') + '\n', hash)).toThrow();
    expect(() => encryptCorpus(Buffer.from('{"schema":"wrong","sessions":[]}'), key)).toThrow();
  });

  it('publishes only fresh allowlisted finite numbers and fixed status enums', () => {
    const section = project(summary(), [row('baseline'), row('candidate')], 2, true);
    const value = publicProjection({ status: 'passed', components: section, sessions: section, error: 'private error', raw: 'private input' });
    expect(value).toMatchObject({ status: 'passed', sessions: { expected: 2, baseline: { sdkUsd: 0.1, recordedConsumed: 2 } } });
    expect(JSON.stringify(value)).not.toMatch(/private|prompt|answer|secret|raw|error/);
    expect(() => publicProjection({ ...value, sessions: { ...section, expected: 'private' } })).toThrow();
    expect(() => publicProjection({ status: 'private' })).toThrow();
    expect(() => publicProjection({ ...value, components: { ...section, baseline: { ...section.baseline, elapsedMs: Infinity } } })).toThrow();
  });

  it.each(['missing', 'duplicate', 'unpaired', 'gate', 'recording', 'report', 'runner'])('fails %s output even when the summary claims success', (failure) => {
    const rows = [row('baseline'), row('candidate')]; const value = summary();
    if (failure === 'missing') { rows.pop(); value.savedResults = 1; }
    if (failure === 'duplicate') { rows[1] = row('baseline'); }
    if (failure === 'unpaired') { rows[1] = row('candidate', 'other-session'); }
    if (failure === 'gate') { rows[1].checks.execution = false; }
    if (failure === 'recording') { rows[1].result.recordings.consumed = 1; }
    if (failure === 'report') { Object.assign(value, { reportError: 'private report error' }); }
    if (failure === 'runner') { value.runnerExit = 1; }
    expect(project(value, rows, 2, true).status).toBe('failed');
  });

  it('does not permit a successful public result without both complete comparison sections', () => {
    expect(() => publicProjection({ status: 'passed' })).toThrow();
  });
});

it('runs the real CI command with synthetic runtimes and publishes no private child/install output', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-ci-test-'));
  try {
    const roots = ['harness', 'baseline', 'candidate'].map((name) => join(root, name));
    const bytes = Buffer.from(JSON.stringify({ schema: 'archie-session-capture/v1', seed: 'synthetic', sessions: [{ id: 'PRIVATE_CORPUS' }] }));
    const key = Buffer.alloc(32, 7), encrypted = encryptCorpus(bytes, key);
    const required = ['src/tasks/task.ts', 'src/agents/task-usage.ts', 'src/proactivity/store.ts', 'src/proactivity/service.ts',
      'src/proactivity/recall.ts', 'src/memory/store.ts', 'src/memory/context.ts', 'src/memory/task-authors.ts'];
    for (const path of roots) for (const file of required) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), ''); }
    mkdirSync(join(roots[0], 'tools/replay'), { recursive: true });
    mkdirSync(join(roots[0], '.github/replay'), { recursive: true });
    writeFileSync(join(roots[0], '.github/replay/corpus.enc'), encrypted);
    copyFileSync(resolve('tools/replay/ci.ts'), join(roots[0], 'tools/replay/ci.ts'));
    symlinkSync(resolve('node_modules'), join(roots[0], 'node_modules'), 'dir');
    writeFileSync(join(roots[0], '.gitignore'), 'node_modules\n.replay\n');
    writeFileSync(join(roots[0], 'tools/replay/run.ts'), `
      import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      const session = process.argv[2] === 'compare';
      for (const key of ['GH_TOKEN','GITHUB_OUTPUT','GITHUB_STEP_SUMMARY','REPLAY_CORPUS_KEY']) if (process.env[key]) throw new Error('secret env leak');
      if (Boolean(process.env.ANTHROPIC_API_KEY) !== session) throw new Error('key isolation failed');
      console.error('PRIVATE_CHILD_OUTPUT ::warning:: PRIVATE_TRACE');
      if (session && !readFileSync(process.argv[3], 'utf8').includes('PRIVATE_CORPUS')) throw new Error('snapshot missing');
      const offset = session ? 4 : 3, config = JSON.parse(process.env.REPLAY_CONFIG);
      const revision = (root) => execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim();
      const out = '.replay/' + (session ? 'sessions' : 'components'); mkdirSync(out, {recursive:true});
      const rows = ['baseline','candidate'].flatMap((variant) => Array.from({length:session ? 1 : 10}, (_, i) => ({variant,episode:{id:'PRIVATE_ID'+i},checks:{execution:true,recordings:true},result:{words:3,elapsedMs:5,posts:['PRIVATE_ANSWER'],usage:{sdkUsd:0},recordings:{expected:0,consumed:0,complete:true,errors:[]}}})));
      writeFileSync(out+'/results.jsonl', rows.map(JSON.stringify).join('\\n'));
      writeFileSync(out+'/summary.json', JSON.stringify({expectedResults:rows.length,savedResults:rows.length,complete:true,passed:true,runnerExit:0,runnerSignal:null,runnerError:null,reportError:null,failed:[],raw:'PRIVATE_SUMMARY'}));
      writeFileSync(out+'/manifest.json', JSON.stringify({revision:revision('.'),sourceHash:'0'.repeat(64),datasetHash:'0'.repeat(64),config,runtimeSources:['baseline','candidate'].map((name,i)=>({name,revision:revision(process.argv[offset+i]),sourceHash:'0'.repeat(64)})),capture:'PRIVATE_MANIFEST'}));
    `);
    const revisions = roots.map((path) => {
      const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Replay test', '-c', 'user.email=replay@example.test', ...args], { cwd: path, stdio: 'pipe', encoding: 'utf8' }).trim();
      git(['init']); git(['add', '.']); git(['commit', '-m', 'synthetic fixture']);
      return git(['rev-parse', 'HEAD']);
    });
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ -z "$ANTHROPIC_API_KEY$GH_TOKEN$GITHUB_OUTPUT$REPLAY_CORPUS_KEY" ] || exit 1\necho PRIVATE_INSTALL_OUTPUT >&2\n', { mode: 0o700 });
    const plan = { ...context, base: revisions[1], head: revisions[2], harness: revisions[0], headRepo: 'contributor/archie-hq', pr: 42, environment: 10, upstream: 100,
      corpus: createHash('sha256').update(bytes).digest('hex'), encrypted: createHash('sha256').update(encrypted).digest('hex'), configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
    const preload = join(root, 'github.mjs');
    writeFileSync(preload, `
      const plan=JSON.parse(process.env.REPLAY_PLAN);
      globalThis.fetch=async(url)=>({ok:true,json:async()=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/environments/production-replay'))return {id:10,name:'production-replay',protection_rules:[{type:'required_reviewers',reviewers:[{}]}]};
        if(path.endsWith('/pulls/42'))return {state:'open',base:{sha:plan.base,repo:{full_name:plan.repo}},head:{sha:plan.head,repo:{full_name:plan.headRepo}}};
        if(path.endsWith('/approvals'))return [{state:'approved',environments:[{id:10}],user:{login:'maintainer',type:'User'}}];
        if(path.endsWith('/permission'))return {permission:'write',role_name:'maintain'};
        throw new Error('PRIVATE_API_ERROR');
      }});
    `);
    const output = join(root, 'output'), summaryPath = join(root, 'summary');
    const result = spawnSync(process.execPath, ['--import', preload, join(roots[0], 'tools/replay/ci.ts'), 'evaluate'], { cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPLAY_CONFIG: JSON.stringify(config), REPLAY_HARNESS: plan.harness, REPLAY_PLAN: JSON.stringify(plan),
        REPLAY_CORPUS_KEY: key.toString('base64'), ANTHROPIC_API_KEY: 'PRIVATE_DUMMY_KEY', GH_TOKEN: 'PRIVATE_DUMMY_TOKEN',
        GITHUB_REPOSITORY: context.repo, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summaryPath } });
    expect(result.status, result.stderr).toBe(0);
    const published = readFileSync(output, 'utf8') + readFileSync(summaryPath, 'utf8') + result.stdout + result.stderr;
    expect(published).not.toMatch(/PRIVATE_|private error|warning::/);
    expect(JSON.parse(readFileSync(output, 'utf8').trim().slice('projection='.length))).toMatchObject({ status: 'passed', corpusSessions: 1, sampleSessions: 1, components: { expected: 20, completed: 20 }, sessions: { expected: 2, completed: 2 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('prepares an encrypted synthetic corpus and private key file without printing or overwriting either', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-ci-encrypt-'));
  try {
    const input = join(root, 'snapshot.json'), output = join(root, 'corpus.enc'), key = join(root, 'key');
    const bytes = Buffer.from(JSON.stringify({ schema: 'archie-session-capture/v1', sessions: [{ id: 'PRIVATE_CORPUS' }] }));
    writeFileSync(input, bytes);
    const args = [resolve('tools/replay/ci.ts'), 'encrypt', input, output, key];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('PRIVATE_');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const original = readFileSync(output), secret = readFileSync(key, 'utf8');
    expect(decodeCorpus(original, secret, createHash('sha256').update(bytes).digest('hex'))).toEqual(bytes);
    const retry = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(retry.status).toBe(1); expect(retry.stdout + retry.stderr).not.toContain(secret);
    expect(readFileSync(output)).toEqual(original); expect(readFileSync(key, 'utf8')).toBe(secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('keeps newer same-SHA retry status ownership using workflow run_number, regardless of opaque run IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-ci-status-'));
  try {
    mkdirSync(join(root, 'tools/replay'), { recursive: true }); mkdirSync(join(root, '.github/replay'), { recursive: true });
    copyFileSync(resolve('tools/replay/ci.ts'), join(root, 'tools/replay/ci.ts'));
    const cipher = Buffer.from('synthetic encrypted fixture'); writeFileSync(join(root, '.github/replay/corpus.enc'), cipher);
    const state = join(root, 'statuses.json'), preload = join(root, 'github.mjs'); writeFileSync(state, '[]');
    writeFileSync(preload, `
      import {readFileSync,writeFileSync} from 'node:fs';
      const plan=JSON.parse(process.env.REPLAY_PLAN), state=process.env.STATUS_FILE;
      globalThis.fetch=async(url,options)=>({ok:true,json:async()=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/pulls/42'))return {state:'open',base:{sha:plan.base,repo:{full_name:plan.repo}},head:{sha:plan.head,repo:{full_name:plan.headRepo}}};
        if(path.endsWith('/status'))return {statuses:JSON.parse(readFileSync(state,'utf8')).slice(-1)};
        if(path.includes('/actions/runs/')){const id=Number(path.split('/').pop());return {id,workflow_id:8,path:'.github/workflows/replay.yml@main',event:'workflow_run',repository:{full_name:plan.repo},run_number:id===900?20:21};}
        if(path.includes('/statuses/')){const rows=JSON.parse(readFileSync(state,'utf8'));rows.push(JSON.parse(options.body));writeFileSync(state,JSON.stringify(rows));return {};}
        throw new Error('private API error');
      }});
    `);
    const section = project(summary(), [row('baseline'), row('candidate')], 2, true);
    const run = (id: number, command: 'pending' | 'report', passed: boolean) => {
      const plan = { ...context, pr: 42, base: 'a'.repeat(40), head: 'b'.repeat(40), headRepo: 'contributor/archie-hq', environment: 10, upstream: 100,
        run: id, encrypted: createHash('sha256').update(cipher).digest('hex'), configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
      const result = spawnSync(process.execPath, ['--import', preload, join(root, 'tools/replay/ci.ts'), command], { encoding: 'utf8',
        env: { ...process.env, STATUS_FILE: state, GH_TOKEN: 'synthetic', GITHUB_REPOSITORY: context.repo, GITHUB_RUN_ID: String(id), GITHUB_RUN_ATTEMPT: '1',
          REPLAY_HARNESS: context.harness, REPLAY_CONFIG: JSON.stringify(config), REPLAY_PLAN: JSON.stringify(plan), GITHUB_STEP_SUMMARY: join(root, 'summary'),
          REPLAY_JOB_RESULT: passed ? 'success' : 'failure', REPLAY_PROJECTION: JSON.stringify(passed ? { status: 'passed', components: section, sessions: section } : { status: 'error' }) } });
      expect(result.status, result.stderr).toBe(0);
    };
    run(200, 'pending', false); run(200, 'report', true); run(900, 'report', false); run(900, 'pending', false);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(state, 'utf8')).at(-1)).toMatchObject({ state: 'success', target_url: 'https://github.com/sweatco/archie-hq/actions/runs/200' });
    writeFileSync(state, '[]'); run(200, 'pending', false); run(900, 'report', true);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(state, 'utf8')).at(-1)).toMatchObject({ state: 'pending', target_url: 'https://github.com/sweatco/archie-hq/actions/runs/200' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
