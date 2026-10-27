// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { Episode, ReplayResult } from './types.js';
import { Cassette } from './cassette.js';

export async function replay(episode: Episode, options: { model?: string; effort?: string; concise?: boolean; timeoutMs?: number; runtimeRoot?: string; maxTurns?: number } = {}): Promise<ReplayResult> {
  const root = await mkdtemp(join(tmpdir(), 'archie-replay-'));
  const state = join(root, 'state');
  await mkdir(state);
  // Expected answers and provenance never enter the worker or SDK filesystem.
  const session = episode.input.kind === 'session' ? episode.input : null;
  const cassette = session ? new Cassette(session.turns) : null;
  await writeFile(join(state, 'input.json'), JSON.stringify({ id: episode.id, input: session ? { kind: 'session', catalog: session.catalog } : episode.input, concise: options.concise }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    ARCHIE_WORKDIR: state, ARCHIE_SECRETS_DIR: join(state, 'secrets'), ARCHIE_MEMORY: 'false',
    ARCHIE_PM_MODEL: options.model ?? 'haiku', ARCHIE_PM_EFFORT: options.effort ?? 'low',
    ANTHROPIC_API_KEY: ['task', 'session'].includes(episode.input.kind) ? process.env.ANTHROPIC_API_KEY : undefined,
    REPLAY_RUNTIME_ROOT: resolve(options.runtimeRoot ?? '.'), REPLAY_MAX_TURNS: String(options.maxTurns ?? 4),
  };
  await mkdir(env.HOME!); await mkdir(env.TMPDIR!);
  let log = '';
  let group: number | undefined;
  const kill = () => { if (group) try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('tools/replay/worker.ts')], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      group = child.pid;
      child.on('message', (message: any) => {
        if (!cassette || !Number.isInteger(message.id)) return;
        const value = message.type === 'next-turn' ? cassette.next() : message.type === 'recorded-tool' ? cassette.call(message.name, message.input) : null;
        child.send({ id: message.id, value });
      });
      const timer = setTimeout(() => { kill(); reject(new Error('Replay timed out')); }, options.timeoutMs ?? 120_000);
      child.stdout!.on('data', (chunk) => { log = (log + chunk).slice(-12_000); });
      child.stderr!.on('data', (chunk) => { log = (log + chunk).slice(-12_000); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`Replay worker exited ${code}: ${log}`)); });
    });
    const result = JSON.parse(await readFile(join(state, 'result.json'), 'utf8'));
    if (cassette) result.recordings = cassette.summary();
    return result;
  } finally { kill(); await rm(root, { recursive: true, force: true }); }
}
