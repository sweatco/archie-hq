import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerManager, runnerRepositoryPath } from '../manager.js';
import type { ExecEvent, ExecRequest, LoadedRunnerConfig, RunnerInstance, RunnerLease, RunnerProvider, RunnerSpec } from '../types.js';
import { listRunnerTaskIds, loadRunnerLeases, readRunnerExecLogState, removeRunnerExecLog } from '../store.js';

const execFileAsync = promisify(execFile);

const persisted = new Map<string, RunnerLease[]>();
const execLogs = new Map<string, Array<{ cursor: number; event: ExecEvent }>>();
const execLogKey = (taskId: string, leaseId: string, execId: string) => `${taskId}:${leaseId}:${execId}`;

vi.mock('../store.js', () => ({
  listRunnerTaskIds: vi.fn().mockResolvedValue([]),
  loadRunnerLeases: vi.fn().mockResolvedValue([]),
  readRunnerExecLogState: vi.fn().mockResolvedValue({ watermark: 0, deliveryCursor: 0 }),
  readRunnerExecOutput: vi.fn(async (taskId: string, leaseId: string, execId: string, afterCursor: number, maxBytes: number) => {
    const records = execLogs.get(execLogKey(taskId, leaseId, execId)) ?? [];
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let cursor = afterCursor;
    let bytes = 0;
    let hasMore = false;
    let recordStart = 0;
    let deliveryBlocked = false;
    for (const record of records) {
      const value = record.event.type === 'stdout' || record.event.type === 'stderr'
        ? Buffer.from(record.event.data)
        : record.event.type === 'error'
          ? Buffer.from(record.event.error)
          : undefined;
      const candidateStart = recordStart;
      recordStart = record.cursor;
      if (record.cursor <= cursor) continue;
      if (deliveryBlocked) {
        hasMore = true;
        continue;
      }
      if (value && value.length > 0) {
        const offset = Math.max(0, cursor - candidateStart);
        const delivered = value.subarray(offset, offset + maxBytes - bytes);
        (record.event.type === 'stdout' ? stdout : stderr).push(delivered);
        bytes += delivered.length;
        cursor = candidateStart + offset + delivered.length;
        if (cursor < record.cursor) {
          deliveryBlocked = true;
          hasMore = true;
        }
      } else {
        cursor = record.cursor;
      }
    }
    return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), cursor, hasMore, truncated: false };
  }),
  saveRunnerLeases: vi.fn(async (taskId: string, leases: RunnerLease[]) => persisted.set(taskId, leases)),
  appendRunnerExecLog: vi.fn(async (taskId: string, leaseId: string, execId: string, event: ExecEvent, afterCursor: number) => {
    const key = execLogKey(taskId, leaseId, execId);
    const value = event.type === 'stdout' || event.type === 'stderr'
      ? Buffer.from(event.data)
      : event.type === 'error'
        ? Buffer.from(event.error)
        : undefined;
    const cursor = afterCursor + Math.max(1, value?.length ?? 0);
    execLogs.set(key, [...(execLogs.get(key) ?? []), { cursor, event }]);
    return cursor;
  }),
  removeRunnerExecLog: vi.fn(async (taskId: string, leaseId: string, execId: string) => {
    execLogs.delete(execLogKey(taskId, leaseId, execId));
  }),
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
  async closeExec(_id: string, _sessionId: string) {}

  async *exec(_id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
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
      orchard: { baseUrl: 'https://orchard.test', context: 'test', allowInsecureHttp: false },
      profiles: {
        ios: {
          image: `ghcr.io/example/xcode@sha256:${'a'.repeat(64)}`,
          os: 'darwin', cpu: 4, memoryMiB: 8192, diskGiB: 100,
          username: 'admin', passwordEnv: 'GUEST', allowedAgents: ['mobile-agent', 'second-agent'],
          labels: {}, resources: {}, networkMode: 'softnet', softnetAllow: [], leaseTtlMinutes: 120,
          debugTtlMinutes: 30, maxDebugTtlMinutes: 60, execTimeoutSeconds: 3600,
          provisionTimeoutSeconds: 30, readinessTimeoutSeconds: 30, maxExecWaitSeconds: 1,
          maxExecOutputBytes: 1024, maxActiveExecSessions: 4, maxExecSessionHistory: 50,
          maxUploadBytes: 1024 * 1024, maxDownloadBytes: 1024 * 1024,
        },
      },
    },
  };
}

describe('RunnerManager', () => {
  beforeEach(() => {
    persisted.clear();
    execLogs.clear();
    vi.mocked(listRunnerTaskIds).mockResolvedValue([]);
    vi.mocked(loadRunnerLeases).mockResolvedValue([]);
    vi.mocked(readRunnerExecLogState).mockResolvedValue({ watermark: 0, deliveryCursor: 0 });
    vi.mocked(removeRunnerExecLog).mockClear();
  });

  it('gives colliding sanitized repository names distinct guest paths', () => {
    const profile = loadedConfig().config.profiles.ios;
    expect(runnerRepositoryPath(profile, 'org/foo.bar')).not.toBe(runnerRepositoryPath(profile, 'org/foo-bar'));
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

  it('reserves capacity atomically across concurrent tasks', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    class SlowProvider extends FakeProvider {
      override async provision(spec: RunnerSpec) {
        this.provisioned.push(spec);
        await blocked;
        const instance: RunnerInstance = { id: spec.id, status: 'running' };
        this.instances.set(spec.id, instance);
        return instance;
      }
    }
    const provider = new SlowProvider();
    const manager = new RunnerManager(loadedConfig(1), provider);
    await manager.initialize();
    const first = manager.ensure('task-1', 'mobile-agent', 'ios');
    await vi.waitFor(() => expect(provider.provisioned).toHaveLength(1));

    await expect(manager.ensure('task-2', 'second-agent', 'ios')).rejects.toThrow(/capacity/);
    unblock();
    await first;
    manager.shutdown();
  });

  it('retries the readiness probe while the guest agent boots', async () => {
    class FlakyReadinessProvider extends FakeProvider {
      readinessAttempts = 0;
      async *exec(id: string, request: ExecRequest) {
        if (request.sessionId.startsWith('readiness-') && this.readinessAttempts++ === 0) {
          throw new Error('Orchard WebSocket exec failed (503)');
        }
        yield* super.exec(id, request);
      }
    }
    const provider = new FlakyReadinessProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.readinessCommand = ['/usr/bin/true'];
    const manager = new RunnerManager(loaded, provider);
    await manager.initialize();
    vi.useFakeTimers();
    try {
      const pending = manager.ensure('task-1', 'mobile-agent', 'ios');
      await vi.advanceTimersByTimeAsync(6000);
      const lease = await pending;
      expect(lease.state).toBe('ready');
      expect(provider.readinessAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    manager.shutdown();
  });

  it('keeps a bounded debug lease on completion and releases it explicitly', async () => {
    const provider = new FakeProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    const debug = await manager.openDebug('task-1', 'mobile-agent', 'ios', 999, [18080]);
    expect(Date.parse(debug.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(debug.commands).toContain(`orchard port-forward vm '${debug.backendId}' 18080:18080`);
    await expect(manager.openDebug('task-1', 'mobile-agent', 'ios', 5, [18080, 18080])).rejects.toThrow(/unique/);
    await manager.completeTask('task-1');
    expect(lease.expiresAt).toBe(debug.expiresAt);
    expect(provider.released).toHaveLength(0);
    await manager.release('task-1', 'mobile-agent', 'ios');
    expect(provider.released).toEqual([debug.backendId]);
    manager.shutdown();
  });

  it('deletes a backend when readiness fails', async () => {
    class FailedReadinessProvider extends FakeProvider {
      async *exec(_id: string, _request: ExecRequest): AsyncIterable<ExecEvent> {
        throw new Error('guest agent unavailable');
      }
    }
    const provider = new FailedReadinessProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.readinessCommand = ['/usr/bin/true'];
    loaded.config.profiles.ios.readinessTimeoutSeconds = 1;
    const manager = new RunnerManager(loaded, provider);
    await manager.initialize();

    await expect(manager.ensure('task-1', 'mobile-agent', 'ios')).rejects.toThrow(/guest agent unavailable/);
    expect(provider.released).toHaveLength(1);
    expect(persisted.get('task-1')).toEqual([]);
    manager.shutdown();
  });

  it('stops readiness retries when the backend fails', async () => {
    class BackendFailsDuringReadinessProvider extends FakeProvider {
      readinessAttempts = 0;
      override async inspect(id: string) {
        const instance = await super.inspect(id);
        if (instance && this.readinessAttempts > 0) {
          return { ...instance, status: 'failed' as const, statusMessage: 'Softnet requires root' };
        }
        return instance;
      }
      override async *exec(_id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        if (request.sessionId.startsWith('readiness-')) this.readinessAttempts += 1;
        throw new Error('guest not reachable');
      }
    }
    const provider = new BackendFailsDuringReadinessProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.readinessCommand = ['/usr/bin/true'];
    const manager = new RunnerManager(loaded, provider);
    await manager.initialize();
    vi.useFakeTimers();
    try {
      const rejected = expect(manager.ensure('task-1', 'mobile-agent', 'ios')).rejects.toThrow(/Softnet requires root/);
      await vi.advanceTimersByTimeAsync(6000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(provider.released).toHaveLength(1);
    manager.shutdown();
  });

  it('reruns readiness before promoting a provisioning lease during recovery', async () => {
    class RecoveryProvider extends FakeProvider {
      readinessAttempts = 0;
      async *exec(id: string, request: ExecRequest) {
        if (request.sessionId.startsWith('readiness-')) this.readinessAttempts += 1;
        yield* super.exec(id, request);
      }
    }
    const provider = new RecoveryProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.readinessCommand = ['/usr/bin/true'];
    const lease: RunnerLease = {
      id: 'lease-1', taskId: 'task-1', agentId: 'mobile-agent', profile: 'ios',
      backendId: 'archie-test-1-lease', state: 'provisioning',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), syncedRepos: {}, execSessions: {},
    };
    provider.instances.set(lease.backendId, { id: lease.backendId, status: 'running' });
    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-1']);
    vi.mocked(loadRunnerLeases).mockResolvedValue([lease]);
    const manager = new RunnerManager(loaded, provider);

    await manager.initialize();

    expect(provider.readinessAttempts).toBe(1);
    expect(lease.state).toBe('ready');
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
    expect(result).toMatchObject({ cursor: 3, hasMore: false });
    manager.shutdown();
  });

  it('reconnects a dropped transfer session before accepting its exit status', async () => {
    class DroppedTransferProvider extends FakeProvider {
      transferAttempts = 0;

      override async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        if (request.stdin) {
          this.transferAttempts += 1;
          for await (const _chunk of request.stdin) {}
          yield { type: 'bootstrap_complete' };
          return;
        }
        if (this.transferAttempts > 0 && request.reconnectFrom !== undefined) {
          this.transferAttempts += 1;
          yield { type: 'history_end', watermark: request.reconnectFrom };
          yield { type: 'exit', code: 0, watermark: request.reconnectFrom + 1 };
          return;
        }
        yield* super.exec(id, request);
      }
    }
    const repo = await mkdtemp(join(tmpdir(), 'archie-runner-sync-reconnect-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: repo });
      await writeFile(join(repo, 'fixture.txt'), 'transfer payload');
      const provider = new DroppedTransferProvider();
      const manager = new RunnerManager(loadedConfig(), provider);
      await manager.initialize();

      const synced = await manager.sync('task-1', 'mobile-agent', 'ios', 'org/app', repo);

      expect(provider.transferAttempts).toBe(2);
      expect(synced.files).toBe(1);
      manager.shutdown();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('fails a transfer instead of reconnecting when stdin delivery was incomplete', async () => {
    class InterruptedUploadProvider extends FakeProvider {
      transferAttempts = 0;

      override async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        if (request.stdin) {
          this.transferAttempts += 1;
          return;
        }
        if (request.reconnectFrom !== undefined) this.transferAttempts += 1;
        yield* super.exec(id, request);
      }
    }
    const repo = await mkdtemp(join(tmpdir(), 'archie-runner-sync-interrupted-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: repo });
      await writeFile(join(repo, 'fixture.txt'), 'transfer payload');
      const provider = new InterruptedUploadProvider();
      const manager = new RunnerManager(loadedConfig(), provider);

      await expect(manager.sync('task-1', 'mobile-agent', 'ios', 'org/app', repo)).rejects.toThrow(/stdin upload completed/);
      expect(provider.transferAttempts).toBe(1);
      manager.shutdown();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reuses a stable request id and replays output after the client cursor', async () => {
    class CountingProvider extends FakeProvider {
      commandStarts = 0;
      override async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        this.commandStarts += 1;
        yield* super.exec(id, request);
      }
    }
    const provider = new CountingProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };
    const requestId = '11111111-1111-4111-8111-111111111111';

    const env = { RUNNER_SECRET: 'delivery-secret' };
    const first = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/printf', 'ok'], '.', env, 1, requestId);
    const replayedStart = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/printf', 'ok'], '.', env, 1, requestId);
    const replayedPoll = await manager.poll('task-1', 'mobile-agent', 'ios', requestId, 0, 0);
    const acknowledged = await manager.poll('task-1', 'mobile-agent', 'ios', requestId, first.cursor, 0);

    expect(provider.commandStarts).toBe(1);
    expect(replayedStart).toMatchObject({ execId: requestId, stdout: 'ok', cursor: 3, hasMore: false });
    expect(replayedPoll).toMatchObject({ stdout: 'ok', cursor: 3, hasMore: false });
    expect(acknowledged).toMatchObject({ stdout: '', stderr: '', cursor: 3, hasMore: false });
    expect(JSON.stringify(persisted.get('task-1'))).not.toContain('delivery-secret');
    await expect(manager.poll('task-1', 'mobile-agent', 'ios', requestId, 4, 0)).rejects.toThrow(/Invalid delivery cursor/);
    await expect(manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/false'], '.', {}, 1, requestId)).rejects.toThrow(/different command/);
    manager.shutdown();
  });

  it('replays a persisted command result after manager restart', async () => {
    class CountingProvider extends FakeProvider {
      commandStarts = 0;
      override async *exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        this.commandStarts += 1;
        yield* super.exec(id, request);
      }
    }
    const provider = new CountingProvider();
    const firstManager = new RunnerManager(loadedConfig(), provider);
    await firstManager.initialize();
    const lease = await firstManager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };
    const requestId = '22222222-2222-4222-8222-222222222222';
    await firstManager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/printf', 'ok'], '.', {}, 1, requestId);
    const recoveredLeases = structuredClone(persisted.get('task-1') ?? []);
    firstManager.shutdown();

    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-1']);
    vi.mocked(loadRunnerLeases).mockResolvedValue(recoveredLeases);
    vi.mocked(readRunnerExecLogState).mockImplementation(async (taskId, leaseId, execId) => {
      const records = execLogs.get(execLogKey(taskId, leaseId, execId)) ?? [];
      const watermarks = records.flatMap(({ event }) => 'watermark' in event && event.watermark !== undefined ? [event.watermark] : []);
      return {
        watermark: Math.max(0, ...watermarks),
        deliveryCursor: Math.max(0, ...records.map((record) => record.cursor)),
      };
    });
    const recoveredManager = new RunnerManager(loadedConfig(), provider);
    await recoveredManager.initialize();

    const replayed = await recoveredManager.poll('task-1', 'mobile-agent', 'ios', requestId, 0, 0);

    expect(provider.commandStarts).toBe(1);
    expect(replayed).toMatchObject({ state: 'completed', stdout: 'ok', cursor: 3, hasMore: false });
    recoveredManager.shutdown();
  });

  it('bounds active detached commands', async () => {
    class DetachedProvider extends FakeProvider {
      override async *exec(_id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
    }
    const provider = new DetachedProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.maxActiveExecSessions = 2;
    const manager = new RunnerManager(loaded, provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };

    await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/sleep', '60'], '.', {}, 0);
    await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/sleep', '60'], '.', {}, 0);
    await expect(manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/true'], '.', {}, 0)).rejects.toThrow(/active exec limit/);
    manager.shutdown();
  });

  it('enforces the command deadline while an exec call is attached', async () => {
    class DeadlineProvider extends FakeProvider {
      closed: string[] = [];
      override async closeExec(_id: string, sessionId: string) { this.closed.push(sessionId); }
      override async *exec(_id: string, request: ExecRequest): AsyncIterable<ExecEvent> {
        if (request.signal?.aborted) return;
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
    }
    vi.useFakeTimers();
    try {
      const provider = new DeadlineProvider();
      const loaded = loadedConfig();
      loaded.config.profiles.ios.execTimeoutSeconds = 1;
      loaded.config.profiles.ios.maxExecWaitSeconds = 5;
      const manager = new RunnerManager(loaded, provider);
      await manager.initialize();
      const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
      lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };

      const pending = manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/sleep', '60'], '.', {}, 5);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await pending;

      expect(result.state).toBe('timed_out');
      expect(provider.closed).toHaveLength(1);
      manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps oversized provider error frames', async () => {
    class ErrorProvider extends FakeProvider {
      override async *exec(): AsyncIterable<ExecEvent> {
        yield { type: 'error', error: 'x'.repeat(4096), watermark: 1 };
      }
    }
    const provider = new ErrorProvider();
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };

    const result = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/false']);
    expect(result).toMatchObject({ state: 'failed', truncated: true });
    expect(result.stderr).toMatch(/exceeded the 1024-byte output limit/);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
    manager.shutdown();
  });

  it('prunes old terminal exec sessions and their logs', async () => {
    const provider = new FakeProvider();
    const loaded = loadedConfig();
    loaded.config.profiles.ios.maxExecSessionHistory = 1;
    const manager = new RunnerManager(loaded, provider);
    await manager.initialize();
    const lease = await manager.ensure('task-1', 'mobile-agent', 'ios');
    lease.syncedRepos['org/app'] = { github: 'org/app', remotePath: '/workspace/app', syncedAt: new Date().toISOString() };

    const first = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/true']);
    const second = await manager.exec('task-1', 'mobile-agent', 'ios', 'org/app', ['/usr/bin/true']);
    expect(Object.keys(lease.execSessions)).toEqual([second.execId]);
    expect(removeRunnerExecLog).toHaveBeenCalledWith('task-1', lease.id, first.execId);
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
          id: 'exec', sessionId: 'archie-exec', state: 'running', watermark: 2, deliveryCursor: 1, outputBytes: 10, outputTruncated: false,
          startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    };
    provider.instances.set(lease.backendId, { id: lease.backendId, status: 'running' });
    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-1']);
    vi.mocked(loadRunnerLeases).mockResolvedValue([lease]);
    vi.mocked(readRunnerExecLogState).mockResolvedValue({ watermark: 7, deliveryCursor: 4 });
    const manager = new RunnerManager(loadedConfig(), provider);
    await manager.initialize();
    expect(lease.execSessions.exec.watermark).toBe(7);
    expect(lease.execSessions.exec.deliveryCursor).toBe(4);
    manager.shutdown();
  });

  it('quarantines one corrupt task state without blocking healthy recovery', async () => {
    const provider = new FakeProvider();
    const quarantinedBackend = 'archie-test-1-corrupt';
    const lease: RunnerLease = {
      id: 'lease-healthy', taskId: 'task-healthy', agentId: 'mobile-agent', profile: 'ios',
      backendId: 'archie-test-1-healthy', state: 'ready', createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      syncedRepos: {}, execSessions: {},
    };
    provider.instances.set(lease.backendId, { id: lease.backendId, status: 'running' });
    provider.instances.set(quarantinedBackend, { id: quarantinedBackend, status: 'running' });
    vi.mocked(listRunnerTaskIds).mockResolvedValue(['task-corrupt', 'task-healthy']);
    vi.mocked(loadRunnerLeases).mockImplementation(async (taskId) => {
      if (taskId === 'task-corrupt') throw new Error('Invalid runner state');
      return [lease];
    });
    const manager = new RunnerManager(loadedConfig(), provider);

    await manager.initialize();

    expect(manager.health()).toMatchObject({ degraded: true, activeLeases: 1 });
    expect(await manager.ensure('task-healthy', 'mobile-agent', 'ios')).toBe(lease);
    expect(provider.released).not.toContain(quarantinedBackend);
    manager.shutdown();
  });

  it('recovers runner health after a transient startup inventory failure', async () => {
    class InventoryProvider extends FakeProvider {
      attempts = 0;
      override async list() {
        if (this.attempts++ === 0) throw new Error('inventory unavailable');
        return [];
      }
    }
    vi.useFakeTimers();
    try {
      const provider = new InventoryProvider();
      const loaded = loadedConfig();
      loaded.config.reaperIntervalSeconds = 1;
      const manager = new RunnerManager(loaded, provider);
      await manager.initialize();
      expect(manager.health().degraded).toBe(true);

      await vi.advanceTimersByTimeAsync(1100);

      expect(manager.health().degraded).toBe(false);
      expect(provider.attempts).toBe(2);
      manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
