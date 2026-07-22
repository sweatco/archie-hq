import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerManager } from '../manager.js';
import type { ExecRequest, LoadedRunnerConfig, RunnerInstance, RunnerLease, RunnerProvider, RunnerSpec } from '../types.js';
import { listRunnerTaskIds, loadRunnerLeases, readRunnerExecWatermark } from '../store.js';

const persisted = new Map<string, RunnerLease[]>();

vi.mock('../store.js', () => ({
  listRunnerTaskIds: vi.fn().mockResolvedValue([]),
  loadRunnerLeases: vi.fn().mockResolvedValue([]),
  readRunnerExecWatermark: vi.fn().mockResolvedValue(0),
  saveRunnerLeases: vi.fn(async (taskId: string, leases: RunnerLease[]) => persisted.set(taskId, leases)),
  appendRunnerExecLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

class FakeProvider implements RunnerProvider {
  instances = new Map<string, RunnerInstance>();
  released: string[] = [];
  provisioned: RunnerSpec[] = [];

  async provision(spec: RunnerSpec) {
    this.provisioned.push(spec);
    const instance: RunnerInstance = { id: spec.id, status: 'running' };
    this.instances.set(spec.id, instance);
    return instance;
  }

  async inspect(id: string) { return this.instances.get(id) ?? null; }
  async list() { return [...this.instances.values()]; }
  async release(id: string) { this.released.push(id); this.instances.delete(id); }
  async closeExec() {}

  async *exec(_id: string, request: ExecRequest) {
    if (request.reconnectFrom !== undefined) yield { type: 'history_end' as const, watermark: request.reconnectFrom };
    else {
      yield { type: 'stdout' as const, data: Buffer.from('ok'), watermark: 1 };
      yield { type: 'exit' as const, code: 0, watermark: 2 };
    }
  }
}

function loadedConfig(maxConcurrent = 2): LoadedRunnerConfig {
  return {
    serviceAccountName: 'archie',
    serviceAccountToken: 'service-secret',
    guestPasswords: { ios: 'guest-secret' },
    config: {
      version: 1,
      instanceId: 'test',
      maxConcurrent,
      orphanGraceMinutes: 30,
      reaperIntervalSeconds: 3600,
      orchard: { baseUrl: 'https://orchard.test', context: 'test' },
      profiles: {
        ios: {
          image: `ghcr.io/example/xcode@sha256:${'a'.repeat(64)}`,
          os: 'darwin', cpu: 4, memoryMiB: 8192, diskGiB: 100,
          username: 'admin', passwordEnv: 'GUEST', allowedAgents: ['mobile-agent', 'second-agent'],
          labels: {}, resources: {}, softnetAllow: [], leaseTtlMinutes: 120,
          debugTtlMinutes: 30, maxDebugTtlMinutes: 60, execTimeoutSeconds: 3600,
          provisionTimeoutSeconds: 30, readinessTimeoutSeconds: 30, maxExecWaitSeconds: 1,
          maxExecOutputBytes: 1024, maxUploadBytes: 1024 * 1024, maxDownloadBytes: 1024 * 1024,
        },
      },
    },
  };
}

describe('RunnerManager', () => {
  beforeEach(() => {
    persisted.clear();
    vi.mocked(listRunnerTaskIds).mockResolvedValue([]);
    vi.mocked(loadRunnerLeases).mockResolvedValue([]);
    vi.mocked(readRunnerExecWatermark).mockResolvedValue(0);
  });

  it('reuses one lease per task-agent-profile without persisting secrets', async () => {
    const provider = new FakeProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const first = await manager.ensure('task-1', 'mobile-agent', 'ios');
    const second = await manager.ensure('task-1', 'mobile-agent', 'ios');
    expect(second.id).toBe(first.id);
    expect(provider.provisioned).toHaveLength(1);
    expect(JSON.stringify(persisted.get('task-1'))).not.toContain('secret');
    manager.shutdown();
  });

  it('enforces global capacity and agent profile allowlists', async () => {
    const provider = new FakeProvider();
    const manager = new RunnerManager(loadedConfig(1), provider);
    await manager.initialize();
    await manager.ensure('task-1', 'mobile-agent', 'ios');
    await expect(manager.ensure('task-2', 'second-agent', 'ios')).rejects.toThrow(/capacity/);
    await expect(manager.ensure('task-2', 'backend-agent', 'ios')).rejects.toThrow(/not allowed/);
    manager.shutdown();
  });

  it('keeps a bounded debug lease on completion and releases it explicitly', async () => {
    const provider = new FakeProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const debug = await manager.openDebug('task-1', 'mobile-agent', 'ios', 999);
    expect(Date.parse(debug.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    await manager.completeTask('task-1');
    expect(provider.released).toHaveLength(0);
    await manager.release('task-1', 'mobile-agent', 'ios');
    expect(provider.released).toEqual([debug.backendId]);
    manager.shutdown();
  });

  it('runs argv commands in a synced repository and records watermarks', async () => {
    const provider = new FakeProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/Users/admin/archie/workspace/org/app', syncedAt: new Date().toISOString() };
    const result = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['xcodebuild', '-version']);
    expect(result).toMatchObject({ state: 'completed', exitCode: 0, stdout: 'ok' });
    expect(lease.execSessions[result.execId].watermark).toBe(2);
    manager.shutdown();
  });

  it('releases every expired lease during startup reconciliation', async () => {
    const provider = new FakeProvider();
    const expired = (id: string): RunnerLease => ({
      id,
      taskId: 'task-1',
      agentId: id === 'lease-1' ? 'mobile-agent' : 'second-agent',
      profile: 'ios',
      backendId: `archie-test-1-${id}`,
      state: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:01:00.000Z',
      syncedRepos: {},
      execSessions: {},
    });
    const leases = [expired('lease-1'), expired('lease-2')];
    const backendIds = leases.map((lease) => lease.backendId).sort();
    for (const lease of leases) provider.instances.set(lease.backendId, { id: lease.backendId, status: 'running' });
    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-1']);
    vi.mocked(loadRunnerLeases).mockResolvedValue(leases);
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    expect(provider.released.sort()).toEqual(backendIds);
    expect(persisted.get('task-1')).toEqual([]);
    manager.shutdown();
  });

  it('recovers the durable watermark from the exec log', async () => {
    const provider = new FakeProvider();
    const lease: RunnerLease = {
      id: 'lease-1', taskId: 'task-1', agentId: 'mobile-agent', profile: 'ios',
      backendId: 'archie-test-1-lease', state: 'ready',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), syncedRepos: {},
      execSessions: {
        exec: {
          id: 'exec', sessionId: 'archie-exec', state: 'running', watermark: 2, outputBytes: 10,
          startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    };
    provider.instances.set(lease.backendId, { id: lease.backendId, status: 'running' });
    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-1']);
    vi.mocked(loadRunnerLeases).mockResolvedValue([lease]);
    vi.mocked(readRunnerExecWatermark).mockResolvedValue(7);
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    expect(lease.execSessions.exec.watermark).toBe(7);
    manager.shutdown();
  });
});
