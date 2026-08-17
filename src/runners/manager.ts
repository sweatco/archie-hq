import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createKeyedLock } from '../system/keyed-lock.js';
import { emitEvent } from '../system/event-bus.js';
import { logger } from '../system/logger.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { getArtifactsPath, loadMetadata } from '../tasks/persistence.js';
import { profileWorkspaceRoot } from './config.js';
import {
  appendRunnerExecLog,
  listRunnerTaskIds,
  loadRunnerLeases,
  readRunnerExecWatermark,
  removeRunnerExecLog,
  saveRunnerLeases,
} from './store.js';
import {
  assertRelativeRunnerPath,
  collectionName,
  createRepositoryArchive,
  extractRunnerArchive,
} from './transfer.js';
import type {
  ExecEvent,
  ExecRequest,
  LoadedRunnerConfig,
  RunnerCommandResult,
  RunnerExecSession,
  RunnerHealth,
  RunnerInstance,
  RunnerLease,
  RunnerProfile,
  RunnerProvider,
} from './types.js';

const TOOL_OUTPUT_LIMIT = 128 * 1024;
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

export function runnerRepositoryPath(profile: RunnerProfile, github: string): string {
  const components = github.split('/').map(sanitizeName);
  const leaf = components.pop() ?? 'repo';
  const digest = createHash('sha256').update(github).digest('hex').slice(0, 12);
  return posix.join(profileWorkspaceRoot(profile), 'workspace', ...components, `${leaf}-${digest}`);
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isTerminal(session: RunnerExecSession): boolean {
  return session.state !== 'running';
}

function validateEnvironment(env: Record<string, string>): void {
  const entries = Object.entries(env);
  if (entries.length > 100) throw new Error('Runner commands accept at most 100 environment variables');
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (value.includes('\0')) throw new Error(`Environment variable ${key} contains a null byte`);
    if (Buffer.byteLength(value) > 32 * 1024) throw new Error(`Environment variable ${key} exceeds 32 KiB`);
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (totalBytes > 64 * 1024) throw new Error('Runner command environment exceeds 64 KiB');
}

export class RunnerManager {
  private readonly leases = new Map<string, RunnerLease[]>();
  private readonly lock = createKeyedLock();
  private readonly capacityLock = createKeyedLock();
  private reaper?: NodeJS.Timeout;
  private reaping = false;
  private readonly degradedReasons = new Map<string, string>();

  constructor(
    private readonly loaded: LoadedRunnerConfig,
    private readonly provider: RunnerProvider,
  ) {}

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
          for (const session of Object.values(lease.execSessions)) {
            session.watermark = Math.max(session.watermark, await readRunnerExecWatermark(taskId, lease.id, session.id));
          }
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

  private async pruneExecHistory(lease: RunnerLease, profile: RunnerProfile): Promise<void> {
    const terminal = Object.values(lease.execSessions)
      .filter(isTerminal)
      .sort((left, right) => Date.parse(left.finishedAt ?? left.startedAt) - Date.parse(right.finishedAt ?? right.startedAt));
    const excess = terminal.slice(0, Math.max(0, terminal.length - profile.maxExecSessionHistory));
    for (const session of excess) {
      await removeRunnerExecLog(lease.taskId, lease.id, session.id);
      delete lease.execSessions[session.id];
    }
    if (excess.length > 0) await this.persist(lease.taskId);
  }

  private assertExecCapacity(lease: RunnerLease, profile: RunnerProfile): void {
    const active = Object.values(lease.execSessions).filter((session) => session.state === 'running').length;
    if (active >= profile.maxActiveExecSessions) {
      throw new Error(`Runner has reached its ${profile.maxActiveExecSessions}-session active exec limit`);
    }
  }

  private async closeSession(lease: RunnerLease, session: RunnerExecSession): Promise<boolean> {
    try {
      await this.provider.closeExec(lease.backendId, session.sessionId);
      this.markHealthy(`close:${session.id}`);
      return true;
    } catch (error) {
      session.deadlineAt = nowIso();
      this.markDegraded(error, `close:${session.id}`);
      await this.persist(lease.taskId).catch((persistError) => this.markDegraded(persistError, `persist:${lease.id}`));
      return false;
    }
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
    const key = `${taskId}:${agentId}:${profileName}`;
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
      try {
        await this.probeReadiness(lease, profile, deadline);
        return;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
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

  async sync(taskId: string, agentId: string, profileName: string, github: string, clonePath: string): Promise<{ lease: RunnerLease; remotePath: string; bytes: number; files: number }> {
    await this.ensure(taskId, agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      const archive = await createRepositoryArchive(clonePath, profile.maxUploadBytes);
      const remotePath = runnerRepositoryPath(profile, github);
      const staging = `${remotePath}.staging-${randomUUID().slice(0, 8)}`;
      const previous = `${remotePath}.previous`;
      const script = [
        'set -eu',
        `mkdir -p ${shellQuote(posix.dirname(remotePath))}`,
        `rm -rf ${shellQuote(staging)} ${shellQuote(previous)}`,
        `mkdir -p ${shellQuote(staging)}`,
        `/usr/bin/tar -xpf - -C ${shellQuote(staging)}`,
        `[ ! -e ${shellQuote(remotePath)} ] || mv ${shellQuote(remotePath)} ${shellQuote(previous)}`,
        `mv ${shellQuote(staging)} ${shellQuote(remotePath)}`,
        `rm -rf ${shellQuote(previous)}`,
      ].join('\n');
      try {
        await this.runTransfer(lease, profile, ['/bin/sh', '-lc', script], undefined, archive.stream());
        lease.syncedRepos[github] = { github, remotePath, syncedAt: nowIso() };
        this.touch(lease, profile);
        await this.persist(taskId);
        emitEvent('runner:sync', taskId, { leaseId: lease.id, profile: profileName, github, bytes: archive.size, files: archive.fileCount }, agentId);
        return { lease, remotePath, bytes: archive.size, files: archive.fileCount };
      } finally {
        await archive.cleanup();
      }
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
  ): Promise<RunnerCommandResult> {
    if (argv.length === 0 || argv.length > 256) throw new Error('argv must contain between 1 and 256 entries');
    if (argv.some((part) => Buffer.byteLength(part) > 32 * 1024)) throw new Error('Each argv entry must be at most 32 KiB');
    if (argv.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0) > 64 * 1024) throw new Error('Runner command argv exceeds 64 KiB');
    validateEnvironment(env);
    const relativeCwd = cwd === '.' ? '.' : assertRelativeRunnerPath(cwd);
    await this.ensure(taskId, agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      this.assertExecCapacity(lease, profile);
      const synced = lease.syncedRepos[github];
      if (!synced) throw new Error(`Repository ${github} has not been synced to runner profile ${profileName}`);
      const remoteCwd = relativeCwd === '.' ? synced.remotePath : posix.join(synced.remotePath, relativeCwd);
      const execId = randomUUID();
      const session: RunnerExecSession = {
        id: execId,
        sessionId: `archie-${execId}`,
        state: 'running',
        watermark: 0,
        outputBytes: 0,
        startedAt: nowIso(),
        deadlineAt: new Date(Date.now() + profile.execTimeoutSeconds * 1000).toISOString(),
      };
      lease.execSessions[execId] = session;
      this.touch(lease, profile);
      await this.persist(taskId);
      emitEvent('runner:exec', taskId, { action: 'start', leaseId: lease.id, execId, profile: profileName }, agentId);
      return this.consumeCommand(lease, profile, session, {
        argv,
        cwd: remoteCwd,
        env,
        sessionId: session.sessionId,
      }, waitSeconds);
    });
  }

  async poll(taskId: string, agentId: string, profileName: string, execId: string, waitSeconds?: number): Promise<RunnerCommandResult> {
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.findLease(taskId, agentId, profileName);
      if (!lease) throw new Error(`No active ${profileName} runner lease`);
      const profile = this.profile(agentId, profileName);
      const session = lease.execSessions[execId];
      if (!session) throw new Error(`Unknown runner exec session: ${execId}`);
      if (isTerminal(session)) return this.commandResult(session, '', '', false);
      if (Date.parse(session.deadlineAt) <= Date.now()) {
        await this.timeoutSession(lease, session);
        return this.commandResult(session, '', '', false);
      }
      return this.consumeCommand(lease, profile, session, {
        sessionId: session.sessionId,
        reconnectFrom: session.watermark,
      }, waitSeconds);
    });
  }

  private async consumeCommand(
    lease: RunnerLease,
    profile: RunnerProfile,
    session: RunnerExecSession,
    request: ExecRequest,
    requestedWait?: number,
  ): Promise<RunnerCommandResult> {
    const waitSeconds = Math.max(0, Math.min(requestedWait ?? profile.maxExecWaitSeconds, profile.maxExecWaitSeconds));
    const controller = new AbortController();
    let deadlineReached = false;
    const waitTimer = setTimeout(() => controller.abort(), waitSeconds * 1000);
    const deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, Math.max(0, Date.parse(session.deadlineAt) - Date.now()));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let returnedBytes = 0;
    let truncated = false;
    const appendReturned = (target: Buffer[], value: Uint8Array) => {
      if (returnedBytes >= TOOL_OUTPUT_LIMIT) {
        truncated = true;
        return;
      }
      const remaining = TOOL_OUTPUT_LIMIT - returnedBytes;
      const data = Buffer.from(value).subarray(0, remaining);
      target.push(data);
      returnedBytes += data.length;
      if (data.length < value.byteLength) truncated = true;
    };
    try {
      for await (const event of this.provider.exec(lease.backendId, { ...request, signal: controller.signal })) {
        if (event.type === 'stdout' || event.type === 'stderr') {
          session.outputBytes += event.data.byteLength;
          if (session.outputBytes > profile.maxExecOutputBytes) {
            throw new Error(`Runner command exceeded the ${profile.maxExecOutputBytes}-byte output limit`);
          }
          await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
          appendReturned(event.type === 'stdout' ? stdout : stderr, event.data);
        } else if (event.type === 'exit') {
          await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
          session.state = 'completed';
          session.exitCode = event.code;
          session.finishedAt = nowIso();
        } else if (event.type === 'error') {
          const errorData = Buffer.from(event.error);
          session.outputBytes += errorData.byteLength;
          if (session.outputBytes > profile.maxExecOutputBytes) {
            const bounded = `Runner error exceeded the ${profile.maxExecOutputBytes}-byte output limit`;
            await appendRunnerExecLog(lease.taskId, lease.id, session.id, { type: 'error', error: bounded, watermark: event.watermark });
            appendReturned(stderr, Buffer.from(bounded));
            truncated = true;
          } else {
            await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
            appendReturned(stderr, errorData);
          }
          session.state = 'failed';
          session.finishedAt = nowIso();
        }
        if ('watermark' in event && event.watermark !== undefined) session.watermark = Math.max(session.watermark, event.watermark);
        await this.persist(lease.taskId);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (await this.closeSession(lease, session)) {
          session.state = 'failed';
          session.finishedAt = nowIso();
          await this.persist(lease.taskId);
        }
        throw error;
      }
    } finally {
      clearTimeout(waitTimer);
      clearTimeout(deadlineTimer);
    }
    if (deadlineReached && session.state === 'running') {
      await this.timeoutSession(lease, session);
    }
    if (isTerminal(session)) {
      await this.pruneExecHistory(lease, profile);
      emitEvent('runner:exec', lease.taskId, { action: 'end', leaseId: lease.id, execId: session.id, state: session.state, exitCode: session.exitCode }, lease.agentId);
    }
    return this.commandResult(session, Buffer.concat(stdout).toString('utf8'), Buffer.concat(stderr).toString('utf8'), truncated);
  }

  private commandResult(session: RunnerExecSession, stdout: string, stderr: string, truncated: boolean): RunnerCommandResult {
    return { execId: session.id, state: session.state, exitCode: session.exitCode, stdout, stderr, truncated };
  }

  async cancel(taskId: string, agentId: string, profileName: string, execId: string): Promise<void> {
    await this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.findLease(taskId, agentId, profileName);
      if (!lease) throw new Error(`No active ${profileName} runner lease`);
      this.profile(agentId, profileName);
      const session = lease.execSessions[execId];
      if (!session) throw new Error(`Unknown runner exec session: ${execId}`);
      if (isTerminal(session)) return;
      if (!await this.closeSession(lease, session)) throw new Error(`Failed to close runner command ${execId}; cleanup will retry`);
      session.state = 'cancelled';
      session.finishedAt = nowIso();
      await this.persist(taskId);
      await this.pruneExecHistory(lease, this.profile(agentId, profileName));
      emitEvent('runner:exec', taskId, { action: 'cancel', leaseId: lease.id, execId }, agentId);
    });
  }

  private async runTransfer(
    lease: RunnerLease,
    profile: RunnerProfile,
    argv: string[],
    cwd?: string,
    stdin?: AsyncIterable<Uint8Array>,
    onStdout?: (data: Uint8Array) => Promise<void>,
  ): Promise<void> {
    this.assertExecCapacity(lease, profile);
    const execId = randomUUID();
    const session: RunnerExecSession = {
      id: execId,
      sessionId: `archie-${execId}`,
      state: 'running',
      watermark: 0,
      outputBytes: 0,
      startedAt: nowIso(),
      deadlineAt: new Date(Date.now() + profile.execTimeoutSeconds * 1000).toISOString(),
    };
    lease.execSessions[execId] = session;
    await this.persist(lease.taskId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profile.execTimeoutSeconds * 1000);
    const failure: Buffer[] = [];
    let failureBytes = 0;
    let diagnosticBytes = 0;
    const appendFailure = (value: Uint8Array) => {
      diagnosticBytes += value.byteLength;
      if (diagnosticBytes > profile.maxExecOutputBytes) {
        throw new Error(`Runner transfer exceeded the ${profile.maxExecOutputBytes}-byte diagnostic output limit`);
      }
      if (failureBytes >= TOOL_OUTPUT_LIMIT) return;
      const data = Buffer.from(value).subarray(0, TOOL_OUTPUT_LIMIT - failureBytes);
      failure.push(data);
      failureBytes += data.length;
    };
    try {
      for await (const event of this.provider.exec(lease.backendId, { argv, cwd, stdin, sessionId: session.sessionId, signal: controller.signal })) {
        if (event.type === 'stdout') {
          session.outputBytes += event.data.byteLength;
          if (onStdout) await onStdout(event.data);
          else appendFailure(event.data);
        } else {
          await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
        }
        if (event.type === 'stderr') appendFailure(event.data);
        if (event.type === 'exit') {
          session.state = event.code === 0 ? 'completed' : 'failed';
          session.exitCode = event.code;
          session.finishedAt = nowIso();
        }
        if (event.type === 'error') {
          session.state = 'failed';
          session.finishedAt = nowIso();
          appendFailure(Buffer.from(event.error));
        }
        if ('watermark' in event && event.watermark !== undefined) session.watermark = Math.max(session.watermark, event.watermark);
        await this.persist(lease.taskId);
      }
      if (controller.signal.aborted && session.state === 'running') {
        await this.timeoutSession(lease, session);
      }
      if (session.state !== 'completed' || session.exitCode !== 0) throw new Error(Buffer.concat(failure).toString('utf8').trim() || `Runner transfer exited with ${session.exitCode ?? 'no status'}`);
    } catch (error) {
      if (session.state === 'running') {
        if (await this.closeSession(lease, session)) {
          session.state = controller.signal.aborted ? 'timed_out' : 'failed';
          session.finishedAt = nowIso();
          await this.persist(lease.taskId);
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (isTerminal(session)) {
        await this.pruneExecHistory(lease, profile).catch((error) => this.markDegraded(error, `history:${lease.id}`));
      }
    }
  }

  async collect(taskId: string, agentId: string, profileName: string, github: string, paths: string[]): Promise<string> {
    if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
    if (paths.length === 0 || paths.length > 100) throw new Error('paths must contain between 1 and 100 entries');
    const safePaths = paths.map(assertRelativeRunnerPath);
    await this.ensure(taskId, agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.activeLease(taskId, agentId, profileName);
      const profile = this.profile(agentId, profileName);
      const synced = lease.syncedRepos[github];
      if (!synced) throw new Error(`Repository ${github} has not been synced to runner profile ${profileName}`);
      const tempDir = await mkdtemp(join(tmpdir(), 'archie-runner-download-'));
      const archivePath = join(tempDir, 'artifacts.tar');
      const output = createWriteStream(archivePath, { mode: 0o600 });
      const outputDone = finished(output);
      void outputDone.catch(() => {});
      let bytes = 0;
      try {
        await this.runTransfer(
          lease,
          profile,
          ['/usr/bin/tar', '-cf', '-', '--', ...safePaths],
          synced.remotePath,
          undefined,
          async (data) => {
            bytes += data.byteLength;
            if (bytes > profile.maxDownloadBytes) throw new Error(`Collected archive exceeds the ${profile.maxDownloadBytes}-byte download limit`);
            if (!output.write(data)) await Promise.race([once(output, 'drain'), outputDone]);
          },
        );
        output.end();
        await outputDone;
        if ((await stat(archivePath)).size !== bytes) throw new Error('Collected archive was not written completely');

        const sessionsRoot = resolve(SESSIONS_DIR);
        const artifactsRoot = resolve(getArtifactsPath(taskId));
        const artifactsRelative = relative(sessionsRoot, artifactsRoot);
        if (artifactsRelative === '..' || artifactsRelative.startsWith('..' + sep) || isAbsolute(artifactsRelative)) {
          throw new Error('Runner artifacts path escapes the sessions directory');
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease.id)) {
          throw new Error(`Invalid runner lease id: ${lease.id}`);
        }
        const parent = resolve(artifactsRoot, 'runners', lease.id);
        const parentRelative = relative(artifactsRoot, parent);
        if (parentRelative === '..' || parentRelative.startsWith('..' + sep) || isAbsolute(parentRelative)) {
          throw new Error('Runner lease path escapes the task artifacts directory');
        }
        await mkdir(parent, { recursive: true });
        const destination = resolve(parent, collectionName());
        const destinationRelative = relative(parent, destination);
        if (destinationRelative === '..' || destinationRelative.startsWith('..' + sep) || isAbsolute(destinationRelative)) {
          throw new Error('Runner collection path escapes the lease directory');
        }
        await extractRunnerArchive(archivePath, destination, parent, profile.maxDownloadBytes);
        this.touch(lease, profile);
        await this.persist(taskId);
        emitEvent('runner:artifacts', taskId, { leaseId: lease.id, profile: profileName, github, paths: safePaths, bytes, destination }, agentId);
        return destination;
      } finally {
        output.destroy();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

  async openDebug(taskId: string, agentId: string, profileName: string, ttlMinutes?: number): Promise<{ backendId: string; context: string; expiresAt: string; commands: string[] }> {
    await this.ensure(taskId, agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
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
        ],
      };
    });
  }

  async release(taskId: string, agentId: string, profileName: string): Promise<void> {
    this.profile(agentId, profileName);
    await this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.taskLeases(taskId).find((candidate) => candidate.agentId === agentId && candidate.profile === profileName);
      if (!lease) return;
      await this.releaseLease(lease);
    });
  }

  async completeTask(taskId: string): Promise<void> {
    const failures: unknown[] = [];
    for (const lease of [...this.taskLeases(taskId)]) {
      try {
        await this.lock(`${lease.taskId}:${lease.agentId}:${lease.profile}`, async () => {
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

  private async timeoutSession(lease: RunnerLease, session: RunnerExecSession): Promise<void> {
    if (!await this.closeSession(lease, session)) return;
    session.state = 'timed_out';
    session.finishedAt = nowIso();
    await this.persist(lease.taskId);
    emitEvent('runner:exec', lease.taskId, { action: 'timeout', leaseId: lease.id, execId: session.id }, lease.agentId);
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
        const profile = this.config.profiles[lease.profile];
        if (!profile || !profile.allowedAgents.includes(lease.agentId)) {
          await this.failLease(lease, 'Runner profile or agent allowlist changed', 'reconcile');
          continue;
        }
        let instance: RunnerInstance | null;
        try {
          instance = await this.provider.inspect(lease.backendId);
        } catch (error) {
          this.markDegraded(error, `inspect:${lease.id}`);
          continue;
        }
        this.markHealthy(`inspect:${lease.id}`);
        if (!instance) {
          await this.failLease(lease, 'Runner backend is missing', 'reconcile');
          continue;
        }
        if (instance.status === 'failed') {
          await this.failLease(lease, instance.statusMessage ?? 'Runner backend failed', 'reconcile');
          continue;
        }
        if (instance.status === 'pending' && lease.state === 'provisioning'
          && Date.parse(lease.createdAt) + profile.provisionTimeoutSeconds * 1000 <= Date.now()) {
          await this.failLease(lease, 'Runner provisioning deadline expired', 'reconcile');
          continue;
        }
        if (instance.status === 'running' && lease.state === 'provisioning') {
          if (profile.readinessCommand) {
            try {
              await this.checkReadiness(lease, profile);
            } catch (error) {
              await this.failLease(lease, error, 'readiness');
              continue;
            }
          }
        }
        lease.state = instance.status === 'running' ? 'ready' : 'provisioning';
        for (const session of Object.values(lease.execSessions)) {
          if (session.state === 'running' && Date.parse(session.deadlineAt) <= Date.now()) await this.timeoutSession(lease, session);
        }
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
        await this.lock(`${lease.taskId}:${lease.agentId}:${lease.profile}`, async () => {
          if (!this.taskLeases(lease.taskId).includes(lease)) return;
          if (lease.state === 'releasing') {
            await this.releaseLease(lease);
            return;
          }
          const profile = this.config.profiles[lease.profile];
          if (!profile || !profile.allowedAgents.includes(lease.agentId)) {
            await this.failLease(lease, 'Runner profile or agent allowlist changed', 'reap');
            return;
          }
          let instance: RunnerInstance | null;
          try {
            instance = await this.provider.inspect(lease.backendId);
          } catch (error) {
            this.markDegraded(error, `inspect:${lease.id}`);
            return;
          }
          this.markHealthy(`inspect:${lease.id}`);
          if (!instance || instance.status === 'failed') {
            await this.failLease(lease, instance?.statusMessage ?? 'Runner backend is missing', 'reap');
            return;
          }
          if (lease.state === 'provisioning' && instance.status === 'pending'
            && Date.parse(lease.createdAt) + profile.provisionTimeoutSeconds * 1000 <= Date.now()) {
            await this.failLease(lease, 'Runner provisioning deadline expired', 'reap');
            return;
          }
          if (lease.state === 'provisioning' && instance.status === 'running') {
            if (profile.readinessCommand) {
              try {
                await this.checkReadiness(lease, profile);
              } catch (error) {
                await this.failLease(lease, error, 'readiness');
                return;
              }
            }
            lease.state = 'ready';
            this.touch(lease, profile);
            await this.persist(lease.taskId);
          }
          for (const session of Object.values(lease.execSessions)) {
            if (session.state === 'running' && Date.parse(session.deadlineAt) <= Date.now()) await this.timeoutSession(lease, session);
          }
          await this.pruneExecHistory(lease, profile);
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
