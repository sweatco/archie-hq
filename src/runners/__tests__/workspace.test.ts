import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerProfileSchema } from '../config.js';
import type { TransferCommand } from '../execution.js';
import type { RunnerLease } from '../types.js';
import { RunnerWorkspace, runnerRepositoryPath } from '../workspace.js';

const paths = vi.hoisted(() => ({ root: `/tmp/archie-workspace-test-${process.pid}-${Date.now()}` }));
vi.mock('../../system/workdir.js', () => ({ SESSIONS_DIR: paths.root }));
vi.mock('../../tasks/persistence.js', () => ({ getArtifactsPath: () => join(paths.root, 'artifacts') }));
vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));

const exec = promisify(execFile);
const guest = join(paths.root, 'guest');
const repo = join(guest, 'repo');
const profile = runnerProfileSchema.parse({
  image: `registry/image@sha256:${'a'.repeat(64)}`,
  passwordEnv: 'PASSWORD', allowedAgents: ['test'], remoteWorkspaceRoot: guest,
  maxDownloadBytes: 8 * 1024 * 1024,
});
const lease: RunnerLease = {
  id: randomUUID(), taskId: 'task-1', agentId: 'test', profile: 'ios',
  backendId: 'vm', state: 'ready', createdAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  syncedRepos: { 'org/repo': { github: 'org/repo', remotePath: repo, syncedAt: new Date().toISOString() } },
  execSessions: {},
};

beforeEach(() => mkdir(repo, { recursive: true }));
afterEach(() => rm(paths.root, { recursive: true, force: true }));

function workspace(transform: (data: Buffer, command: TransferCommand) => Buffer = data => data) {
  const sizes: number[] = [];
  const hooks = {
    persist: vi.fn().mockResolvedValue(undefined), touch: vi.fn(),
    transfer: async (_lease: RunnerLease, _profile: unknown, command: TransferCommand) => {
      const { stdout } = await exec(command.argv[0], command.argv.slice(1), {
        cwd: command.cwd, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, signal: command.signal,
      });
      sizes.push(stdout.length);
      const data = transform(stdout, command);
      for (let i = 0; i < data.length; i += 32768) await command.onStdout?.(data.subarray(i, i + 32768));
    },
  };
  return { instance: new RunnerWorkspace(hooks), sizes, hooks };
}

describe('runner artifact download', () => {
  it('collects binary data larger than Orchard replay history through bounded commands', async () => {
    const name = "@file with 'quotes'; literal.bin";
    const data = randomBytes(5 * 1024 * 1024 + 17);
    await writeFile(join(repo, name), data);
    const { instance, sizes, hooks } = workspace();

    const destination = await instance.collect(lease, profile, 'org/repo', [name]);

    const collected = await readFile(join(destination, name));
    expect(collected.length).toBe(data.length);
    expect(createHash('sha256').update(collected).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024);
    expect(sizes.filter(size => size === 1024 * 1024)).toHaveLength(5);
    expect(hooks.persist).toHaveBeenCalledOnce();
    expect(await readdir(guest)).toEqual(['repo']);
  });

  it.each(['short', 'long'])('rejects a %s chunk and cleans up the guest archive', async mode => {
    await writeFile(join(repo, 'file'), 'data');
    const { instance, hooks } = workspace((data, command) => command.argv.includes('count=1')
      ? mode === 'short' ? data.subarray(0, -1) : Buffer.concat([data, Buffer.from('extra')])
      : data);

    await expect(instance.collect(lease, profile, 'org/repo', ['file'])).rejects.toThrow(/chunk/);
    expect(hooks.persist).not.toHaveBeenCalled();
    expect(await readdir(guest)).toEqual(['repo']);
  });

  it('enforces the archive limit before downloading and removes partial guest staging', async () => {
    await writeFile(join(repo, 'file'), randomBytes(2 * 1024 * 1024));
    const { instance, hooks } = workspace();

    await expect(instance.collect(lease, { ...profile, maxDownloadBytes: 1024 }, 'org/repo', ['file'])).rejects.toThrow();
    expect(hooks.persist).not.toHaveBeenCalled();
    expect(await readdir(guest)).toEqual(['repo']);
  });

  it('cleans up on cancellation between chunks', async () => {
    await writeFile(join(repo, 'file'), randomBytes(2 * 1024 * 1024));
    const abort = new AbortController();
    const { instance, hooks } = workspace((data, command) => {
      if (command.argv.includes('count=1')) abort.abort();
      return data;
    });

    await expect(instance.collect(lease, profile, 'org/repo', ['file'], abort.signal)).rejects.toThrow();
    expect(hooks.persist).not.toHaveBeenCalled();
    expect(await readdir(guest)).toEqual(['repo']);
  });
});


describe('runner repository upload', () => {
  it.each(['corrupt', 'partial'])('removes staging after a %s archive without replacing the synced repository', async mode => {
    const source = join(paths.root, 'source');
    await mkdir(source);
    await exec('git', ['init', '-q', source]);
    await writeFile(join(source, 'new.bin'), randomBytes(8192));
    await exec('git', ['-C', source, 'add', 'new.bin']);
    const remotePath = runnerRepositoryPath(profile, 'org/repo');
    await mkdir(remotePath, { recursive: true });
    await writeFile(join(remotePath, 'previous.txt'), 'previous snapshot');
    const synced = { github: 'org/repo', remotePath, syncedAt: '2026-01-01T00:00:00.000Z' };
    const uploadLease = { ...lease, syncedRepos: { 'org/repo': synced } };
    const hooks = {
      persist: vi.fn().mockResolvedValue(undefined), touch: vi.fn(),
      transfer: async (_lease: RunnerLease, _profile: unknown, command: TransferCommand) => {
        const chunks: Buffer[] = [];
        for await (const chunk of command.stdin!) chunks.push(Buffer.from(chunk));
        const archive = Buffer.concat(chunks);
        expect(archive.length).toBeGreaterThan(8192);
        const bytes = mode === 'corrupt' ? Buffer.from('not a tar archive') : archive.subarray(0, 600);
        const process = exec(command.argv[0], command.argv.slice(1), { signal: command.signal });
        process.child.stdin!.end(bytes);
        await process;
      },
    };

    await expect(new RunnerWorkspace(hooks).sync(uploadLease, profile, 'org/repo', source)).rejects.toThrow(/tar/);

    expect(await readFile(join(remotePath, 'previous.txt'), 'utf8')).toBe('previous snapshot');
    expect(await readdir(remotePath)).toEqual(['previous.txt']);
    expect(await readdir(dirname(remotePath))).toEqual([remotePath.split('/').at(-1)]);
    expect(uploadLease.syncedRepos['org/repo']).toBe(synced);
    expect(hooks.persist).not.toHaveBeenCalled();
    expect(hooks.touch).not.toHaveBeenCalled();
  });
});
