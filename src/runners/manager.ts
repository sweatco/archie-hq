import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createKeyedLock } from '../system/keyed-lock.js';
import { emitEvent } from '../system/event-bus.js';
import { logger } from '../system/logger.js';
import { loadMetadata } from '../tasks/persistence.js';
import {
  listRunnerTaskIds,
  loadRunnerLeases,
  saveRunnerLeases,
} from './store.js';
import { RunnerExecution, validateExecuteCommand } from './execution.js';
import { assertRelativeRunnerPath } from './transfer.js';
import { RunnerWorkspace } from './workspace.js';
import type {
  LoadedRunnerConfig,
  RunnerCommandResult,
  RunnerHealth,
  RunnerInstance,
  RunnerLease,
  RunnerProfile,
  RunnerProvider,
} from './types.js';

const READINESS_RETRY_MS = 5000;

class RunnerReadinessError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'runner';
}

export { runnerRepositoryPath } from './workspace.js';

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function leaseKey(taskId: string, agentId: string, profile: string): string {
  return `${taskId}:${agentId}:${profile}`;
}

export class RunnerManager {
  private readonly leases = new Map<string, RunnerLease[]>();
  private readonly lock = createKeyedLock();
  private readonly capacityLock = createKeyedLock();
  private reaper?: NodeJS.Timeout;
  private reaping = false;
  private readonly degradedReasons = new Map<string, string>();
  private readonly execution: RunnerExecution;
  private readonly workspace: RunnerWorkspace;

  constructor(
    private readonly loaded: LoadedRunnerConfig,
    private readonly provider: RunnerProvider,
  ) {
    this.execution = new RunnerExecution(provider, {
      persist: (taskId) => this.persist(taskId),
      markDegraded: (error, key) => this.markDegraded(error, key),
      markHealthy: (key) => this.markHealthy(key),
      touch: (lease, profile) => this.touch(lease, profile),
    });
    this.workspace = new RunnerWorkspace({
      transfer: (lease, profile, command) => this.execution.transfer(lease, profile, command),
      persist: (taskId) => this.persist(taskId),
      touch: (lease, profile) => this.touch(lease, profile),
    });
  }

  get config() {
    return this.loaded.config;
  }

  async initialize(): Promise<void> {
    for (const taskId of await listRunnerTaskIds()) {
      try {
        const taskLeases = await loadRunnerLeases(taskId);
        for (const lease of taskLeases) {
          if (lease.taskId !== taskId) throw new Error(`Runner lease ${lease.id} is stored under the wrong task`);
          if (!lease.backendId.startsWith(this.backendPrefix())) throw new Error(`Runner lease ${lease.id} does not belong to instance ${this.config.instanceId}`);
          await this.execution.restoreLogCursors(lease);
        }
        this.leases.set(taskId, taskLeases);
        this.markHealthy(`state:${taskId}`);
      } catch (error) {
        this.markDegraded(error, `state:${taskId}`);
      }
    }

    try {
      await this.reconcile();
      this.markHealthy('reconcile');
    } catch (error) {
      this.markDegraded(error, 'reconcile');
    }

    this.reaper = setInterval(() => {
      if (this.reaping) return;
      this.reaping = true;
      void this.reap()
        .then(() => this.markHealthy('reap'))
        .catch((error) => this.markDegraded(error, 'reap'))
        .finally(() => { this.reaping = false; });
    }, this.config.reaperIntervalSeconds * 1000);
    this.reaper.unref();
  }

  shutdown(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  health(): RunnerHealth {
    const reasons = [...this.degradedReasons.values()];
    return {
      enabled: true,
      degraded: reasons.length > 0,
      ...(reasons.length > 0 ? { reason: reasons.slice(0, 3).join('; ') } : {}),
      activeLeases: [...this.leases.values()].flat().filter((lease) => lease.state !== 'failed').length,
    };
  }

  profilesForAgent(agentId: string): string[] {
    return Object.entries(this.config.profiles)
      .filter(([, profile]) => profile.allowedAgents.includes(agentId))
      .map(([name]) => name)
      .sort();
  }

  isAllowed(agentId: string, profileName: string): boolean {
    return this.config.profiles[profileName]?.allowedAgents.includes(agentId) === true;
  }

  private profile(agentId: string, profileName: string): RunnerProfile {
    const profile = this.config.profiles[profileName];
    if (!profile) throw new Error(`Unknown runner profile: ${profileName}`);
    if (!profile.allowedAgents.includes(agentId)) throw new Error(`Agent ${agentId} is not allowed to use runner profile ${profileName}`);
    return profile;
  }

  private taskLeases(taskId: string): RunnerLease[] {
    let taskLeases = this.leases.get(taskId);
    if (!taskLeases) {
      taskLeases = [];
      this.leases.set(taskId, taskLeases);
    }
    return taskLeases;
  }

  private findLease(taskId: string, agentId: string, profile: string): RunnerLease | undefined {
    return this.taskLeases(taskId).find((lease) => lease.agentId === agentId && lease.profile === profile && (lease.state === 'provisioning' || lease.state === 'ready'));
  }

  private activeLease(taskId: string, agentId: string, profile: string): RunnerLease {
    const lease = this.findLease(taskId, agentId, profile);
    if (!lease) throw new Error(`No active ${profile} runner lease`);
    return lease;
  }

  private async persist(taskId: string): Promise<void> {
    await saveRunnerLeases(taskId, this.taskLeases(taskId));
  }

  private markDegraded(error: unknown, key = 'controller'): void {
    const reason = safeError(error);
    this.degradedReasons.set(key, reason);
    logger.warn('runners', `Runner subsystem degraded: ${reason}`);
  }

  private markHealthy(key = 'controller'): void {
    this.degradedReasons.delete(key);
  }

  private async failLease(lease: RunnerLease, error: unknown, operation: string): Promise<void> {
    lease.state = 'failed';
    lease.failure = safeError(error);
    await this.persist(lease.taskId);
    emitEvent('runner:failed', lease.taskId, { leaseId: lease.id, operation }, lease.agentId);
    await this.releaseLease(lease).catch(() => {});
  }

  private touch(lease: RunnerLease, profile: RunnerProfile): void {
    lease.lastUsedAt = nowIso();
    lease.expiresAt = addMinutes(profile.leaseTtlMinutes);
  }

  private leaseExpired(lease: RunnerLease): boolean {
    const extension = Math.max(
      Date.parse(lease.expiresAt),
      Date.parse(lease.debugExpiresAt ?? '1970-01-01T00:00:00.000Z'),
      ...Object.values(lease.execSessions)
        .filter((session) => session.state === 'running')
        .map((session) => Date.parse(session.deadlineAt)),
    );
    return extension <= Date.now();
  }

  private createBackendId(leaseId: string): string {
    return `${this.backendPrefix()}${Date.now()}-${leaseId.slice(0, 8)}`;
  }

  private backendPrefix(): string {
    return `archie-${sanitizeName(this.config.instanceId)}-`;
  }

  async ensure(taskId: string, agentId: string, profileName: string): Promise<RunnerLease> {
    const profile = this.profile(agentId, profileName);
    const key = leaseKey(taskId, agentId, profileName);
    return this.lock(key, async () => {
      const current = this.findLease(taskId, agentId, profileName);
      if (current) {
        try {
          const instance = await this.provider.inspect(current.backendId);
          if (instance?.status === 'running') {
            if (current.state === 'provisioning' && profile.readinessCommand) {
              try {
                await this.checkReadiness(current, profile);
              } catch (error) {
                await this.failLease(current, error, 'readiness');
                throw error;
              }
            }
            current.state = 'ready';
            current.failure = undefined;
            this.touch(current, profile);
            await this.persist(taskId);
            this.markHealthy();
            return current;
          }
          if (instance?.status === 'pending') {
            try {
              return await this.waitUntilReady(current, profile);
            } catch (error) {
              if (error instanceof RunnerReadinessError) await this.failLease(current, error, 'readiness');
              else this.markDegraded(error);
              throw error;
            }
          }
          await this.failLease(
            current,
            instance?.statusMessage ? `Runner failed: ${instance.statusMessage.slice(0, 300)}` : 'Runner backend is missing',
            'inspect',
          );
        } catch (error) {
          if (current.state === 'failed' || current.state === 'releasing') throw error;
          this.markDegraded(error);
          throw error;
        }
      }

      const stale = this.taskLeases(taskId).filter((lease) => lease.agentId === agentId && lease.profile === profileName && (lease.state === 'failed' || lease.state === 'releasing'));
      for (const lease of stale) await this.releaseLease(lease);

      const lease = await this.capacityLock('global', async () => {
        const active = [...this.leases.values()].flat().filter((candidate) => candidate.state !== 'failed');
        if (active.length >= this.config.maxConcurrent) throw new Error(`Runner capacity reached (${this.config.maxConcurrent})`);

        const id = randomUUID();
        const timestamp = nowIso();
        const reserved: RunnerLease = {
          id,
          taskId,
          agentId,
          profile: profileName,
          backendId: this.createBackendId(id),
          state: 'provisioning',
          createdAt: timestamp,
          lastUsedAt: timestamp,
          expiresAt: addMinutes(profile.leaseTtlMinutes),
          syncedRepos: {},
          execSessions: {},
        };
        this.taskLeases(taskId).push(reserved);
        await this.persist(taskId);
        emitEvent('runner:provisioning', taskId, { leaseId: id, profile: profileName, backendId: reserved.backendId }, agentId);
        return reserved;
      });

      try {
        await this.provider.provision({
          id: lease.backendId,
          image: profile.image,
          os: profile.os,
          cpu: profile.cpu,
          memoryMiB: profile.memoryMiB,
          diskGiB: profile.diskGiB,
          username: profile.username,
          password: this.loaded.guestPasswords[profileName],
          labels: profile.labels,
          resources: profile.resources,
          networkMode: profile.networkMode,
          softnetAllow: profile.softnetAllow,
        });
        return await this.waitUntilReady(lease, profile);
      } catch (error) {
        await this.failLease(lease, error, 'provision');
        throw error;
      }
    });
  }

  private async waitUntilReady(lease: RunnerLease, profile: RunnerProfile): Promise<RunnerLease> {
    const deadline = Date.now() + profile.provisionTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const instance = await this.provider.inspect(lease.backendId);
      if (!instance) throw new RunnerReadinessError(`Orchard VM ${lease.backendId} disappeared during provisioning`);
      if (instance.status === 'failed') throw new RunnerReadinessError(`Orchard VM failed: ${instance.statusMessage ?? 'unknown error'}`);
      if (instance.status === 'running') {
        if (profile.readinessCommand) await this.checkReadiness(lease, profile);
        lease.state = 'ready';
        lease.failure = undefined;
        this.touch(lease, profile);
        await this.persist(lease.taskId);
        this.markHealthy();
        emitEvent('runner:ready', lease.taskId, { leaseId: lease.id, profile: lease.profile, backendId: lease.backendId }, lease.agentId);
        return lease;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new RunnerReadinessError(`Timed out waiting for Orchard VM ${lease.backendId}`);
  }

  // Orchard reports "running" as soon as the VM process starts; the guest agent
  // may need minutes more to boot, so the probe retries until the timeout.
  private async checkReadiness(lease: RunnerLease, profile: RunnerProfile): Promise<void> {
    const deadline = Date.now() + profile.readinessTimeoutSeconds * 1000;
    let lastFailure = 'Runner readiness command did not succeed';
    while (true) {
      let instance: RunnerInstance | null = null;
      let inspected = false;
      try {
        instance = await this.provider.inspect(lease.backendId);
        inspected = true;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (inspected && !instance) {
        throw new RunnerReadinessError(`Orchard VM ${lease.backendId} disappeared during readiness`);
      } else if (instance?.status === 'failed') {
        throw new RunnerReadinessError(`Orchard VM failed during readiness: ${instance.statusMessage ?? 'unknown error'}`);
      } else if (instance?.status === 'running') {
        try {
          await this.probeReadiness(lease, profile, deadline);
          return;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
        }
      }
      if (Date.now() + READINESS_RETRY_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, READINESS_RETRY_MS));
    }
    throw new RunnerReadinessError(lastFailure);
  }

  private async probeReadiness(lease: RunnerLease, profile: RunnerProfile, deadline: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    const sessionId = `readiness-${randomUUID()}`;
    let exitCode: number | undefined;
    let failure: string | undefined;
    try {
      for await (const event of this.provider.exec(lease.backendId, {
        argv: profile.readinessCommand,
        sessionId,
        signal: controller.signal,
      })) {
        if (event.type === 'exit') exitCode = event.code;
        if (event.type === 'error') failure = event.error;
      }
    } finally {
      clearTimeout(timer);
    }
    if (exitCode !== 0) {
      await this.provider.closeExec(lease.backendId, sessionId).catch(() => {});
      throw new Error(failure || `Runner readiness command exited with ${exitCode ?? 'no status'}`);
    }
  }

  async sync(taskId: string, agentId: string, profileName: string, github: string, clonePath: string, signal?: AbortSignal): Promise<{ lease: RunnerLease; remotePath: string; bytes: number; files: number }> {
    await this.ensure(taskId, agentId, profileName);
    return this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      return this.workspace.sync(lease, profile, github, clonePath, signal);
    });
  }

  async exec(
    taskId: string,
    agentId: string,
    profileName: string,
    github: string,
    argv: string[],
    cwd = '.',
    env: Record<string, string> = {},
    waitSeconds?: number,
    requestId: string = randomUUID(),
  ): Promise<RunnerCommandResult> {
    validateExecuteCommand({ github, argv, cwd, env, waitSeconds, requestId });
    const relativeCwd = cwd === '.' ? '.' : assertRelativeRunnerPath(cwd);
    await this.ensure(taskId, agentId, profileName);
    return this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      const synced = lease.syncedRepos[github];
      if (!synced) throw new Error(`Repository ${github} has not been synced to runner profile ${profileName}`);
      const remoteCwd = relativeCwd === '.' ? synced.remotePath : posix.join(synced.remotePath, relativeCwd);
      return this.execution.startOrResume(lease, profile, {
        github,
        argv,
        cwd: remoteCwd,
        env,
        waitSeconds,
        requestId,
      });
    });
  }

  async poll(taskId: string, agentId: string, profileName: string, execId: string, afterCursor: number, waitSeconds?: number): Promise<RunnerCommandResult> {
    return this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.findLease(taskId, agentId, profileName);
      if (!lease) throw new Error(`No active ${profileName} runner lease`);
      const profile = this.profile(agentId, profileName);
      return this.execution.poll(lease, profile, execId, afterCursor, waitSeconds);
    });
  }

  async cancel(taskId: string, agentId: string, profileName: string, execId: string): Promise<void> {
    await this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.findLease(taskId, agentId, profileName);
      if (!lease) throw new Error(`No active ${profileName} runner lease`);
      await this.execution.cancel(lease, this.profile(agentId, profileName), execId);
    });
  }

  async collect(taskId: string, agentId: string, profileName: string, github: string, paths: string[], signal?: AbortSignal): Promise<string> {
    if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
    if (paths.length === 0 || paths.length > 100) throw new Error('paths must contain between 1 and 100 entries');
    const safePaths = paths.map(assertRelativeRunnerPath);
    await this.ensure(taskId, agentId, profileName);
    return this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      return this.workspace.collect(lease, profile, github, safePaths, signal);
    });
  }

  async openDebug(taskId: string, agentId: string, profileName: string, ttlMinutes?: number, ports: number[] = []): Promise<{ backendId: string; context: string; expiresAt: string; commands: string[] }> {
    if (ports.length > 8 || ports.some((port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535)) {
      throw new Error('Debug ports must contain at most 8 integers between 1024 and 65535');
    }
    if (new Set(ports).size !== ports.length) throw new Error('Debug ports must be unique');
    await this.ensure(taskId, agentId, profileName);
    return this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.findLease(taskId, agentId, profileName);
      if (!lease) throw new Error(`No active ${profileName} runner lease`);
      const profile = this.profile(agentId, profileName);
      const ttl = Math.min(ttlMinutes ?? profile.debugTtlMinutes, profile.maxDebugTtlMinutes);
      if (ttl < 1) throw new Error('Debug TTL must be at least one minute');
      lease.debugExpiresAt = addMinutes(ttl);
      await this.persist(taskId);
      emitEvent('runner:debug', taskId, { leaseId: lease.id, profile: profileName, expiresAt: lease.debugExpiresAt }, agentId);
      return {
        backendId: lease.backendId,
        context: this.config.orchard.context,
        expiresAt: lease.debugExpiresAt,
        commands: [
          `orchard context default ${shellQuote(this.config.orchard.context)}`,
          `orchard vnc vm ${shellQuote(lease.backendId)}`,
          ...ports.map((port) => `orchard port-forward vm ${shellQuote(lease.backendId)} ${port}:${port}`),
        ],
      };
    });
  }

  async release(taskId: string, agentId: string, profileName: string): Promise<void> {
    this.profile(agentId, profileName);
    await this.lock(leaseKey(taskId, agentId, profileName), async () => {
      const lease = this.taskLeases(taskId).find((candidate) => candidate.agentId === agentId && candidate.profile === profileName);
      if (!lease) return;
      await this.releaseLease(lease);
    });
  }

  async completeTask(taskId: string): Promise<void> {
    const failures: unknown[] = [];
    for (const lease of [...this.taskLeases(taskId)]) {
      try {
        await this.lock(leaseKey(lease.taskId, lease.agentId, lease.profile), async () => {
          if (!this.taskLeases(taskId).includes(lease)) return;
          if (lease.debugExpiresAt && Date.parse(lease.debugExpiresAt) > Date.now()) {
            lease.expiresAt = lease.debugExpiresAt;
            await this.persist(taskId);
            return;
          }
          await this.releaseLease(lease);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to complete ${failures.length} runner lease(s)`);
  }

  private async releaseLease(lease: RunnerLease): Promise<void> {
    lease.state = 'releasing';
    await this.persist(lease.taskId);
    try {
      await this.provider.release(lease.backendId);
      const taskLeases = this.taskLeases(lease.taskId);
      const index = taskLeases.findIndex((candidate) => candidate.id === lease.id);
      if (index >= 0) taskLeases.splice(index, 1);
      await this.persist(lease.taskId);
      this.markHealthy(`release:${lease.id}`);
      emitEvent('runner:released', lease.taskId, { leaseId: lease.id, profile: lease.profile, backendId: lease.backendId }, lease.agentId);
    } catch (error) {
      this.markDegraded(error, `release:${lease.id}`);
      emitEvent('runner:failed', lease.taskId, { leaseId: lease.id, operation: 'release' }, lease.agentId);
      throw error;
    }
  }

  private async inspectLease(
    lease: RunnerLease,
    operation: 'reconcile' | 'reap',
  ): Promise<{ profile: RunnerProfile; instance: RunnerInstance } | undefined> {
    const profile = this.config.profiles[lease.profile];
    if (!profile || !profile.allowedAgents.includes(lease.agentId)) {
      await this.failLease(lease, 'Runner profile or agent allowlist changed', operation);
      return undefined;
    }

    let instance: RunnerInstance | null;
    try {
      instance = await this.provider.inspect(lease.backendId);
    } catch (error) {
      this.markDegraded(error, `inspect:${lease.id}`);
      return undefined;
    }
    this.markHealthy(`inspect:${lease.id}`);
    if (!instance) {
      await this.failLease(lease, 'Runner backend is missing', operation);
      return undefined;
    }
    if (instance.status === 'failed') {
      const fallback = operation === 'reconcile' ? 'Runner backend failed' : 'Runner backend is missing';
      await this.failLease(lease, instance.statusMessage ?? fallback, operation);
      return undefined;
    }
    if (instance.status === 'pending' && lease.state === 'provisioning'
      && Date.parse(lease.createdAt) + profile.provisionTimeoutSeconds * 1000 <= Date.now()) {
      await this.failLease(lease, 'Runner provisioning deadline expired', operation);
      return undefined;
    }
    return { profile, instance };
  }

  private async finishProvisioning(lease: RunnerLease, profile: RunnerProfile): Promise<boolean> {
    if (profile.readinessCommand) {
      try {
        await this.checkReadiness(lease, profile);
      } catch (error) {
        await this.failLease(lease, error, 'readiness');
        return false;
      }
    }
    lease.state = 'ready';
    return true;
  }

  private async reconcile(): Promise<void> {
    for (const [taskId, taskLeases] of this.leases) {
      let taskCompleted = false;
      try {
        taskCompleted = (await loadMetadata(taskId))?.status === 'completed';
        this.markHealthy(`metadata:${taskId}`);
      } catch (error) {
        this.markDegraded(error, `metadata:${taskId}`);
      }
      for (const lease of [...taskLeases]) {
        if (taskCompleted && (!lease.debugExpiresAt || Date.parse(lease.debugExpiresAt) <= Date.now())) {
          await this.releaseLease(lease).catch(() => {});
          continue;
        }
        if (taskCompleted && lease.debugExpiresAt) {
          lease.expiresAt = lease.debugExpiresAt;
          await this.persist(taskId);
        }
        if (lease.state === 'failed' || lease.state === 'releasing' || this.leaseExpired(lease)) {
          await this.releaseLease(lease).catch(() => {});
          continue;
        }
        const inspected = await this.inspectLease(lease, 'reconcile');
        if (!inspected) continue;
        const { profile, instance } = inspected;
        if (instance.status === 'running' && lease.state === 'provisioning') {
          if (!await this.finishProvisioning(lease, profile)) continue;
        }
        lease.state = instance.status === 'running' ? 'ready' : 'provisioning';
        await this.execution.timeoutOverdueSessions(lease);
        await this.persist(lease.taskId);
      }
    }

    await this.reconcileOrphans();
  }

  private async reconcileOrphans(): Promise<void> {
    if ([...this.degradedReasons.keys()].some((key) => key.startsWith('state:'))) return;
    const known = new Set([...this.leases.values()].flat().map((lease) => lease.backendId));
    const prefix = this.backendPrefix();
    const graceMs = this.config.orphanGraceMinutes * 60_000;
    for (const instance of await this.provider.list()) {
      if (!instance.id.startsWith(prefix) || known.has(instance.id)) continue;
      const timestamp = Number(instance.id.slice(prefix.length).split('-')[0]);
      if (!Number.isFinite(timestamp) || Date.now() - timestamp < graceMs) continue;
      try {
        await this.provider.release(instance.id);
        this.markHealthy(`orphan:${instance.id}`);
      } catch (error) {
        this.markDegraded(error, `orphan:${instance.id}`);
      }
    }
  }

  private async reap(): Promise<void> {
    for (const taskLeases of [...this.leases.values()]) {
      for (const lease of [...taskLeases]) {
        await this.lock(leaseKey(lease.taskId, lease.agentId, lease.profile), async () => {
          if (!this.taskLeases(lease.taskId).includes(lease)) return;
          if (lease.state === 'releasing') {
            await this.releaseLease(lease);
            return;
          }
          const inspected = await this.inspectLease(lease, 'reap');
          if (!inspected) return;
          const { profile, instance } = inspected;
          if (lease.state === 'provisioning' && instance.status === 'running') {
            if (!await this.finishProvisioning(lease, profile)) return;
            this.touch(lease, profile);
            await this.persist(lease.taskId);
          }
          await this.execution.timeoutOverdueSessions(lease);
          await this.execution.pruneHistory(lease, profile);
          if (this.leaseExpired(lease)) await this.releaseLease(lease);
          this.markHealthy(`reap:${lease.id}`);
        }).catch((error) => this.markDegraded(error, `reap:${lease.id}`));
      }
    }
    try {
      await this.reconcileOrphans();
      this.markHealthy('reconcile');
    } catch (error) {
      this.markDegraded(error, 'reconcile');
    }
  }
}
