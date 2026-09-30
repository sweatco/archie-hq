import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sessionsRoot: `/tmp/archie-runner-store-${process.pid}-${Date.now()}` }));

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../system/workdir.js')>(),
  SESSIONS_DIR: state.sessionsRoot,
}));

import {
  appendRunnerExecLog,
  getRunnerStatePath,
  listRunnerTaskIds,
  loadRunnerLeases,
  readRunnerExecLogState,
  readRunnerExecOutput,
} from '../store.js';

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

  it('replays logged output after an independent delivery cursor', async () => {
    const taskId = 'task-20260819-1200-cursor';
    const leaseId = '11111111-1111-4111-8111-111111111111';
    const execId = '22222222-2222-4222-8222-222222222222';
    let cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'stdout', data: Buffer.from('abcd'), watermark: 10 }, 0);
    cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'stderr', data: Buffer.from('efgh'), watermark: 11 }, cursor);
    cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'exit', code: 0, watermark: 12 }, cursor);

    expect(cursor).toBe(9);
    await expect(readRunnerExecLogState(taskId, leaseId, execId)).resolves.toEqual({ watermark: 12, deliveryCursor: 9 });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 0, 4)).resolves.toEqual({
      stdout: 'abcd', stderr: '', cursor: 4, hasMore: true, truncated: false,
    });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 4, 4)).resolves.toEqual({
      stdout: '', stderr: 'efgh', cursor: 9, hasMore: false, truncated: false,
    });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 8, 4)).resolves.toEqual({
      stdout: '', stderr: '', cursor: 9, hasMore: false, truncated: false,
    });
  });

  it('resumes inside one output record without dropping the remainder', async () => {
    const taskId = 'task-20260819-1203-page';
    const leaseId = '77777777-7777-4777-8777-777777777777';
    const execId = '88888888-8888-4888-8888-888888888888';
    let cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'stdout', data: Buffer.from('abcdefgh'), watermark: 1 }, 0);
    cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'exit', code: 0, watermark: 2 }, cursor);

    await expect(readRunnerExecOutput(taskId, leaseId, execId, 0, 3)).resolves.toMatchObject({ stdout: 'abc', cursor: 3, hasMore: true });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 3, 3)).resolves.toMatchObject({ stdout: 'def', cursor: 6, hasMore: true });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 6, 3)).resolves.toMatchObject({ stdout: 'gh', cursor: 9, hasMore: false });
  });

  it('returns cursors only at UTF-8 character boundaries', async () => {
    const taskId = 'task-20260819-1204-utf8';
    const leaseId = '99999999-9999-4999-8999-999999999999';
    const execId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'stdout', data: Buffer.from('A€B'), watermark: 1 }, 0);
    cursor = await appendRunnerExecLog(taskId, leaseId, execId, { type: 'exit', code: 0, watermark: 2 }, cursor);

    await expect(readRunnerExecOutput(taskId, leaseId, execId, 0, 2)).resolves.toMatchObject({ stdout: 'A', cursor: 1, hasMore: true });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 1, 2)).resolves.toMatchObject({ stdout: '€', cursor: 4, hasMore: true });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 4, 2)).resolves.toMatchObject({ stdout: 'B', cursor: 6, hasMore: false });
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 2, 2)).rejects.toThrow(/splits a UTF-8 character/);
  });

  it('migrates persisted sessions created before delivery cursors', async () => {
    const taskId = 'task-20260819-1201-legacy';
    const leaseId = '33333333-3333-4333-8333-333333333333';
    const execId = '44444444-4444-4444-8444-444444444444';
    await mkdir(join(state.sessionsRoot, taskId, 'shared'), { recursive: true });
    await writeFile(getRunnerStatePath(taskId), JSON.stringify({
      version: 1,
      leases: [{
        id: leaseId, taskId, agentId: 'mobile-agent', profile: 'ios', backendId: 'archie-test-1-legacy',
        state: 'ready', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), syncedRepos: {},
        execSessions: {
          [execId]: {
            id: execId, sessionId: `archie-${execId}`, state: 'completed', watermark: 2, outputBytes: 4,
            startedAt: new Date().toISOString(), deadlineAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0,
          },
        },
      }],
    }));

    const [lease] = await loadRunnerLeases(taskId);
    expect(lease.execSessions[execId].deliveryCursor).toBe(0);
  });

  it('rejects a missing delivery cursor instead of polling forever', async () => {
    const taskId = 'task-20260819-1202-gap';
    const leaseId = '55555555-5555-4555-8555-555555555555';
    const execId = '66666666-6666-4666-8666-666666666666';
    await appendRunnerExecLog(taskId, leaseId, execId, { type: 'stdout', data: Buffer.from('one'), watermark: 1 }, 0);
    const path = join(state.sessionsRoot, taskId, 'shared', 'runners', leaseId, 'exec', `${execId}.jsonl`);
    await writeFile(path, `${await readFile(path, 'utf8')}\n${JSON.stringify({ timestamp: new Date().toISOString(), cursor: 5, type: 'exit', code: 0, watermark: 3 })}\n`);

    await expect(readRunnerExecLogState(taskId, leaseId, execId)).rejects.toThrow(/cursor gap/);
    await expect(readRunnerExecOutput(taskId, leaseId, execId, 0, 1024)).rejects.toThrow(/cursor gap/);
  });
});
