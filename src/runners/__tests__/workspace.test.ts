import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerProfileSchema } from '../config.js';
import type { TransferCommand } from '../execution.js';
import type { RunnerLease } from '../types.js';
import { RunnerWorkspace } from '../workspace.js';

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
