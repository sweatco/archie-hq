import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createKeyedLock } from '../system/keyed-lock.js';
import { emitEvent } from '../system/event-bus.js';
import { logger } from '../system/logger.js';
import { getArtifactsPath } from '../tasks/persistence.js';
import { profileWorkspaceRoot } from './config.js';
import {
  appendRunnerExecLog,
  listRunnerTaskIds,
  loadRunnerLeases,
  readRunnerExecWatermark,
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
  RunnerLease,
  RunnerProfile,
  RunnerProvider,
} from './types.js';

const TOOL_OUTPUT_LIMIT = 128 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'runner';
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
    if (Buffer.byteLength(value) > 32 * 1024) throw new Error(`Environment variable ${key} exceeds 32 KiB`);
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (totalBytes > 64 * 1024) throw new Error('Runner command environment exceeds 64 KiB');
}

export class RunnerManager {
  private readonly leases = new Map<string, RunnerLease[]>();
  private readonly lock = createKeyedLock();
  private reaper?: NodeJS.Timeout;
  private degradedReason?: string;

  constructor(
    private readonly loaded: LoadedRunnerConfig,
    private readonly provider: RunnerProvider,
  ) {}

  get config() {
    return this.loaded.config;
  }

  async initialize(): Promise<void> {
    for (const taskId of await listRunnerTaskIds()) {
      const taskLeases = await loadRunnerLeases(taskId);
      for (const lease of taskLeases) {
        if (lease.taskId !== taskId) throw new Error(`Runner lease ${lease.id} is stored under the wrong task`);
        for (const session of Object.values(lease.execSessions)) {
          session.watermark = Math.max(session.watermark, await readRunnerExecWatermark(taskId, lease.id, session.id));
        }
      }
      this.leases.set(taskId, taskLeases);
    }

    try {
      await this.reconcile();
      this.degradedReason = undefined;
    } catch (error) {
      this.markDegraded(error);
    }

    this.reaper = setInterval(() => {
      void this.reap().catch((error) => this.markDegraded(error));
    }, this.config.reaperIntervalSeconds * 1000);
    this.reaper.unref();
  }

  shutdown(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  health(): RunnerHealth {
    return {
      enabled: true,
      degraded: !!this.degradedReason,
      ...(this.degradedReason ? { reason: this.degradedReason } : {}),
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

  private async persist(taskId: string): Promise<void> {
    await saveRunnerLeases(taskId, this.taskLeases(taskId));
  }

  private markDegraded(error: unknown): void {
    this.degradedReason = safeError(error);
    logger.warn('runners', `Runner subsystem degraded: ${this.degradedReason}`);
  }

  private markHealthy(): void {
    this.degradedReason = undefined;
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
    return `archie-${sanitizeName(this.config.instanceId)}-${Date.now()}-${leaseId.slice(0, 8)}`;
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
            current.state = 'ready';
            current.failure = undefined;
            this.touch(current, profile);
            await this.persist(taskId);
            this.markHealthy();
            return current;
          }
          if (instance?.status === 'pending') return await this.waitUntilReady(current, profile);
          current.state = 'failed';
          current.failure = instance?.statusMessage ? `Runner failed: ${instance.statusMessage.slice(0, 300)}` : 'Runner backend is missing';
          await this.persist(taskId);
        } catch (error) {
          this.markDegraded(error);
          throw error;
        }
      }

      const stale = this.taskLeases(taskId).filter((lease) => lease.agentId === agentId && lease.profile === profileName && (lease.state === 'failed' || lease.state === 'releasing'));
      for (const lease of stale) await this.releaseLease(lease);

      const active = [...this.leases.values()].flat().filter((lease) => lease.state !== 'failed');
      if (active.length >= this.config.maxConcurrent) throw new Error(`Runner capacity reached (${this.config.maxConcurrent})`);

      const id = randomUUID();
      const timestamp = nowIso();
      const lease: RunnerLease = {
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
      this.taskLeases(taskId).push(lease);
      await this.persist(taskId);
      emitEvent('runner:provisioning', taskId, { leaseId: id, profile: profileName, backendId: lease.backendId }, agentId);

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
        lease.state = 'failed';
        lease.failure = 'Runner provisioning failed';
        await this.persist(taskId);
        this.markDegraded(error);
        emitEvent('runner:failed', taskId, { leaseId: id, operation: 'provision' }, agentId);
        throw error;
      }
    });
  }

  private async waitUntilReady(lease: RunnerLease, profile: RunnerProfile): Promise<RunnerLease> {
    const deadline = Date.now() + profile.provisionTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const instance = await this.provider.inspect(lease.backendId);
      if (!instance) throw new Error(`Orchard VM ${lease.backendId} disappeared during provisioning`);
      if (instance.status === 'failed') throw new Error(`Orchard VM failed: ${instance.statusMessage ?? 'unknown error'}`);
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
    throw new Error(`Timed out waiting for Orchard VM ${lease.backendId}`);
  }

  private async checkReadiness(lease: RunnerLease, profile: RunnerProfile): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profile.readinessTimeoutSeconds * 1000);
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

  private remoteRepoPath(lease: RunnerLease, profile: RunnerProfile, github: string): string {
    const safeRepo = github.split('/').map(sanitizeName).join('/');
    return posix.join(profileWorkspaceRoot(profile), 'workspace', safeRepo);
  }

  async sync(taskId: string, agentId: string, profileName: string, github: string, clonePath: string): Promise<{ lease: RunnerLease; remotePath: string; bytes: number; files: number }> {
    const lease = await this.ensure(taskId, agentId, profileName);
    const profile = this.profile(agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const archive = await createRepositoryArchive(clonePath, profile.maxUploadBytes);
      const remotePath = this.remoteRepoPath(lease, profile, github);
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
      const lease = this.findLease(taskId, agentId, profileName)!;
      const profile = this.profile(agentId, profileName);
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
    const timer = setTimeout(() => controller.abort(), waitSeconds * 1000);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let returnedBytes = 0;
    let truncated = false;
    try {
      for await (const event of this.provider.exec(lease.backendId, { ...request, signal: controller.signal })) {
        await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
        if (event.type === 'stdout' || event.type === 'stderr') {
          session.outputBytes += event.data.byteLength;
          if (session.outputBytes > profile.maxExecOutputBytes) {
            await this.provider.closeExec(lease.backendId, session.sessionId).catch(() => {});
            session.state = 'failed';
            session.finishedAt = nowIso();
            throw new Error(`Runner command exceeded the ${profile.maxExecOutputBytes}-byte output limit`);
          }
          if (returnedBytes < TOOL_OUTPUT_LIMIT) {
            const remaining = TOOL_OUTPUT_LIMIT - returnedBytes;
            const data = Buffer.from(event.data).subarray(0, remaining);
            (event.type === 'stdout' ? stdout : stderr).push(data);
            returnedBytes += data.length;
            if (data.length < event.data.byteLength) truncated = true;
          } else {
            truncated = true;
          }
        } else if (event.type === 'exit') {
          session.state = 'completed';
          session.exitCode = event.code;
          session.finishedAt = nowIso();
        } else if (event.type === 'error') {
          session.state = 'failed';
          session.finishedAt = nowIso();
          stderr.push(Buffer.from(event.error));
        }
        if ('watermark' in event && event.watermark !== undefined) session.watermark = Math.max(session.watermark, event.watermark);
        await this.persist(lease.taskId);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        session.state = 'failed';
        session.finishedAt = nowIso();
        await this.persist(lease.taskId);
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    if (isTerminal(session)) {
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
      await this.provider.closeExec(lease.backendId, session.sessionId);
      session.state = 'cancelled';
      session.finishedAt = nowIso();
      await this.persist(taskId);
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
    let failure = '';
    try {
      for await (const event of this.provider.exec(lease.backendId, { argv, cwd, stdin, sessionId: session.sessionId, signal: controller.signal })) {
        if (event.type === 'stdout') {
          session.outputBytes += event.data.byteLength;
          await onStdout?.(event.data);
        } else {
          await appendRunnerExecLog(lease.taskId, lease.id, session.id, event);
        }
        if (event.type === 'stderr') failure += Buffer.from(event.data).toString('utf8');
        if (event.type === 'exit') {
          session.state = event.code === 0 ? 'completed' : 'failed';
          session.exitCode = event.code;
          session.finishedAt = nowIso();
        }
        if (event.type === 'error') {
          session.state = 'failed';
          session.finishedAt = nowIso();
          failure += event.error;
        }
        if ('watermark' in event && event.watermark !== undefined) session.watermark = Math.max(session.watermark, event.watermark);
        await this.persist(lease.taskId);
      }
      if (controller.signal.aborted && session.state === 'running') {
        await this.timeoutSession(lease, session);
      }
      if (session.state !== 'completed' || session.exitCode !== 0) throw new Error(failure.trim() || `Runner transfer exited with ${session.exitCode ?? 'no status'}`);
    } catch (error) {
      if (session.state === 'running') {
        await this.provider.closeExec(lease.backendId, session.sessionId).catch(() => {});
        session.state = controller.signal.aborted ? 'timed_out' : 'failed';
        session.finishedAt = nowIso();
        await this.persist(lease.taskId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async collect(taskId: string, agentId: string, profileName: string, github: string, paths: string[]): Promise<string> {
    if (paths.length === 0 || paths.length > 100) throw new Error('paths must contain between 1 and 100 entries');
    const safePaths = paths.map(assertRelativeRunnerPath);
    await this.ensure(taskId, agentId, profileName);
    return this.lock(`${taskId}:${agentId}:${profileName}`, async () => {
      const lease = this.findLease(taskId, agentId, profileName)!;
      const profile = this.profile(agentId, profileName);
      const synced = lease.syncedRepos[github];
      if (!synced) throw new Error(`Repository ${github} has not been synced to runner profile ${profileName}`);
      const tempDir = await mkdtemp(join(tmpdir(), 'archie-runner-download-'));
      const archivePath = join(tempDir, 'artifacts.tar');
      const output = createWriteStream(archivePath, { mode: 0o600 });
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
            if (!output.write(data)) await once(output, 'drain');
          },
        );
        output.end();
        await once(output, 'close');
        if ((await stat(archivePath)).size !== bytes) throw new Error('Collected archive was not written completely');

        const parent = join(getArtifactsPath(taskId), 'runners', lease.id);
        await mkdir(parent, { recursive: true });
        const destination = join(parent, collectionName());
        await extractRunnerArchive(archivePath, destination, profile.maxDownloadBytes);
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
    const lease = await this.ensure(taskId, agentId, profileName);
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
    for (const lease of [...this.taskLeases(taskId)]) {
      if (lease.debugExpiresAt && Date.parse(lease.debugExpiresAt) > Date.now()) continue;
      await this.lock(`${lease.taskId}:${lease.agentId}:${lease.profile}`, () => this.releaseLease(lease));
    }
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
      this.markHealthy();
      emitEvent('runner:released', lease.taskId, { leaseId: lease.id, profile: lease.profile, backendId: lease.backendId }, lease.agentId);
    } catch (error) {
      this.markDegraded(error);
      emitEvent('runner:failed', lease.taskId, { leaseId: lease.id, operation: 'release' }, lease.agentId);
      throw error;
    }
  }

  private async timeoutSession(lease: RunnerLease, session: RunnerExecSession): Promise<void> {
    await this.provider.closeExec(lease.backendId, session.sessionId).catch(() => {});
    session.state = 'timed_out';
    session.finishedAt = nowIso();
    await this.persist(lease.taskId);
    emitEvent('runner:exec', lease.taskId, { action: 'timeout', leaseId: lease.id, execId: session.id }, lease.agentId);
  }

  private async reconcile(): Promise<void> {
    const known = new Set<string>();
    for (const taskLeases of this.leases.values()) {
      for (const lease of [...taskLeases]) {
        known.add(lease.backendId);
        if (lease.state === 'releasing' || this.leaseExpired(lease)) {
          await this.releaseLease(lease);
          continue;
        }
        const instance = await this.provider.inspect(lease.backendId);
        if (!instance) {
          lease.state = 'failed';
          lease.failure = 'Runner backend is missing';
          await this.persist(lease.taskId);
          continue;
        }
        lease.state = instance.status === 'running' ? 'ready' : instance.status === 'pending' ? 'provisioning' : 'failed';
        if (instance.status === 'failed') lease.failure = instance.statusMessage?.slice(0, 300) ?? 'Runner backend failed';
        for (const session of Object.values(lease.execSessions)) {
          if (session.state === 'running' && Date.parse(session.deadlineAt) <= Date.now()) await this.timeoutSession(lease, session);
        }
        await this.persist(lease.taskId);
      }
    }

    const prefix = `archie-${sanitizeName(this.config.instanceId)}-`;
    const graceMs = this.config.orphanGraceMinutes * 60_000;
    for (const instance of await this.provider.list()) {
      if (!instance.id.startsWith(prefix) || known.has(instance.id)) continue;
      const timestamp = Number(instance.id.slice(prefix.length).split('-')[0]);
      if (Number.isFinite(timestamp) && Date.now() - timestamp >= graceMs) await this.provider.release(instance.id);
    }
  }

  private async reap(): Promise<void> {
    for (const taskLeases of [...this.leases.values()]) {
      for (const lease of [...taskLeases]) {
        for (const session of Object.values(lease.execSessions)) {
          if (session.state === 'running' && Date.parse(session.deadlineAt) <= Date.now()) await this.timeoutSession(lease, session);
        }
        if (lease.state === 'releasing' || this.leaseExpired(lease)) {
          await this.lock(`${lease.taskId}:${lease.agentId}:${lease.profile}`, () => this.releaseLease(lease));
        }
      }
    }
  }
}
