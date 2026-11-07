// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('saves a failed completeness summary when the runner exits before creating a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-runner-failure-'));
  const hook = join(root, 'fail-runner.mjs');
  let out: string | undefined;
  try {
    await writeFile(hook, "if (process.argv[1]?.endsWith('evalite-runner.ts')) throw new Error('deliberate runner startup failure');");
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', 'components'], {
      env: { ...process.env, NODE_OPTIONS: `--import=${hook}` }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(1);
    out = result.stdout.match(/Replay saved .*: (.+)/)?.[1];
    expect(out?.startsWith(resolve('.replay') + '/')).toBe(true);
    const summary = JSON.parse(await readFile(join(out!, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ runnerExit: 1, savedResults: 0, expectedResults: 20, complete: false, passed: false, reportError: expect.stringContaining('Report status unavailable') });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (out?.startsWith(resolve('.replay') + '/')) await rm(out, { recursive: true, force: true });
  }
}, 20_000);

it('serializes real replay callbacks across Evalite variants', async () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', 'components'], { env: process.env, encoding: 'utf8', timeout: 20_000 });
  const out = result.stdout.match(/Replay saved .*: (.+)/)?.[1];
  try {
    expect(result.status, result.stderr).toBe(0);
    expect(out?.startsWith(resolve('.replay') + '/')).toBe(true);
    const rows = (await readFile(join(out!, 'results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(20);
    expect(rows.every((row, i) => !i || row.window.startMs >= rows[i - 1].window.endMs)).toBe(true);
    const exported = JSON.parse(await readFile(join(out!, 'evalite.json'), 'utf8')).evals.flatMap((evaluation: { results: unknown[] }) => evaluation.results);
    expect(exported).toHaveLength(20);
    expect(await readFile(join(out!, 'report/index.html'), 'utf8')).toContain('<html');
  } finally { if (out?.startsWith(resolve('.replay') + '/')) await rm(out, { recursive: true, force: true }); }
}, 25_000);

it.each(['blocked-path', 'empty-message'])('fails the parent when static export fails (%s) after successful evaluations', async (failure) => {
  const root = await mkdtemp(join(tmpdir(), 'archie-export-failure-'));
  const hook = join(root, 'block-report.mjs');
  let out: string | undefined;
  try {
    await writeFile(hook, failure === 'blocked-path'
      ? "import fs from 'node:fs'; if (process.argv[1]?.endsWith('evalite-runner.ts')) fs.writeFileSync(process.env.REPLAY_OUT + '/report', 'blocked');"
      : "import fs from 'node:fs/promises'; if (process.argv[1]?.endsWith('evalite-runner.ts')) { const mkdir = fs.mkdir; fs.mkdir = async (path, ...args) => { if (String(path).startsWith(process.env.REPLAY_OUT + '/report')) throw new Error(''); return mkdir(path, ...args); }; }");
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', 'components'], { env: { ...process.env, NODE_OPTIONS: `--import=${hook}` }, encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(1);
    out = result.stdout.match(/Replay saved .*: (.+)/)?.[1];
    expect(out?.startsWith(resolve('.replay') + '/')).toBe(true);
    const summary = JSON.parse(await readFile(join(out!, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ runnerExit: 0, savedResults: 20, complete: true, passed: false, reportError: failure === 'empty-message' ? '' : expect.stringMatching(/E(?:EXIST|NOTDIR)/) });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (out?.startsWith(resolve('.replay') + '/')) await rm(out, { recursive: true, force: true });
  }
}, 25_000);

it('compares actual runtime roots with fixed attention and both memory fixtures', async () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', 'compare-components', process.cwd(), process.cwd()], { env: process.env, encoding: 'utf8', timeout: 25_000 });
  const out = result.stdout.match(/Replay saved .*: (.+)/)?.[1];
  try {
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(join(out!, 'manifest.json'), 'utf8'));
    const binary = 'openspec/changes/archive/2026-07-05-pr-167-mcp-file-bridge/qa-evidence/ac7-live-e2e/forge-qa.png';
    expect(manifest.source[binary]).toBe(createHash('sha256').update(await readFile(binary)).digest('hex'));
    expect(manifest.runtimeSources.map((source: any) => source.name)).toEqual(['baseline', 'candidate']);
    expect(manifest.runtimeSources[0].sourceHash).toBe(manifest.runtimeSources[1].sourceHash);
    const rows = (await readFile(join(out!, 'results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(20);
    expect([...new Set(rows.map((row) => row.variant))].sort()).toEqual(['baseline', 'candidate']);
    expect(rows.some((row) => row.episode.id.startsWith('task-memory'))).toBe(true);
    expect(rows.every((row) => row.result.mode === 'recorded-component')).toBe(true);
  } finally { if (out?.startsWith(resolve('.replay') + '/')) await rm(out, { recursive: true, force: true }); }
}, 30_000);

it('saves a failed completeness summary for an interrupted result line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-result-failure-'));
  const hook = join(root, 'interrupt-result.mjs');
  let out: string | undefined;
  try {
    await writeFile(hook, "import fs from 'node:fs'; if (process.argv[1]?.endsWith('evalite-runner.ts')) process.on('exit', () => fs.appendFileSync(process.env.REPLAY_RESULTS, '{interrupted\\n'));");
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/run.ts', 'components'], { env: { ...process.env, NODE_OPTIONS: `--import=${hook}` }, encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(1);
    out = result.stdout.match(/Replay saved .*: (.+)/)?.[1];
    const summary = JSON.parse(await readFile(join(out!, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ runnerExit: 0, savedResults: 20, invalidResults: 1, complete: false, passed: false, reportError: null });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (out?.startsWith(resolve('.replay') + '/')) await rm(out, { recursive: true, force: true });
  }
}, 25_000);
