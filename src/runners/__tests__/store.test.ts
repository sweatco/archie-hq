import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sessionsRoot: `/tmp/archie-runner-store-${process.pid}-${Date.now()}` }));

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../system/workdir.js')>(),
  SESSIONS_DIR: state.sessionsRoot,
}));

import { getRunnerStatePath, listRunnerTaskIds, loadRunnerLeases } from '../store.js';

describe('runner state store', () => {
  beforeEach(async () => {
    await rm(state.sessionsRoot, { recursive: true, force: true });
    await mkdir(state.sessionsRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(state.sessionsRoot, { recursive: true, force: true });
  });

  it('ignores non-canonical task directories', async () => {
    const valid = 'task-20260817-1630-valid1';
    await mkdir(join(state.sessionsRoot, valid, 'shared'), { recursive: true });
    await writeFile(getRunnerStatePath(valid), JSON.stringify({ version: 1, leases: [] }));
    await mkdir(join(state.sessionsRoot, 'task-invalid', 'shared'), { recursive: true });
    await writeFile(join(state.sessionsRoot, 'task-invalid', 'shared', 'runners.json'), '{}');

    await expect(listRunnerTaskIds()).resolves.toEqual([valid]);
  });

  it('rejects corrupt identifiers before they reach log paths or providers', async () => {
    const taskId = 'task-20260817-1630-corrupt';
    await mkdir(join(state.sessionsRoot, taskId, 'shared'), { recursive: true });
    await writeFile(getRunnerStatePath(taskId), JSON.stringify({
      version: 1,
      leases: [{
        id: '../../outside', taskId, agentId: 'mobile-agent', profile: 'ios', backendId: 'unowned-vm',
        state: 'ready', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), syncedRepos: {}, execSessions: {},
      }],
    }));

    await expect(loadRunnerLeases(taskId)).rejects.toThrow();
  });
});
