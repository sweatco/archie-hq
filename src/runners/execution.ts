import { createHash, randomUUID } from 'node:crypto';
import { emitEvent } from '../system/event-bus.js';
import {
  appendRunnerExecLog,
  readRunnerExecLogState,
  readRunnerExecOutput,
  removeRunnerExecLog,
} from './store.js';
import type {
  ExecEvent,
  ExecRequest,
  RunnerCommandResult,
  RunnerExecSession,
  RunnerLease,
  RunnerProfile,
  RunnerProvider,
} from './types.js';

const TOOL_OUTPUT_LIMIT = 128 * 1024;

interface ExecutionHooks {
  persist(taskId: string): Promise<void>;
  markDegraded(error: unknown, key: string): void;
  markHealthy(key: string): void;
  touch(lease: RunnerLease, profile: RunnerProfile): void;
}

export interface ExecuteCommand {
  github: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  waitSeconds?: number;
  requestId: string;
}

export interface TransferCommand {
  argv: string[];
  cwd?: string;
  stdin?: AsyncIterable<Uint8Array>;
  onStdout?: (data: Uint8Array) => Promise<void>;
  signal?: AbortSignal;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminal(session: RunnerExecSession): boolean {
  return session.state !== 'running';
}

export function validateExecuteCommand(command: ExecuteCommand): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.requestId)) {
    throw new Error(`Invalid runner request id: ${command.requestId}`);
  }
  if (command.argv.length === 0 || command.argv.length > 256) {
    throw new Error('argv must contain between 1 and 256 entries');
  }
  if (command.argv.some((part) => Buffer.byteLength(part) > 32 * 1024)) {
    throw new Error('Each argv entry must be at most 32 KiB');
  }
  if (command.argv.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0) > 64 * 1024) {
    throw new Error('Runner command argv exceeds 64 KiB');
  }

  const entries = Object.entries(command.env);
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

function fingerprint(command: ExecuteCommand): string {
  return createHash('sha256').update(JSON.stringify({
    github: command.github,
    argv: command.argv,
    cwd: command.cwd,
    envKeys: Object.keys(command.env).sort(),
  })).digest('hex');
}

function createSession(profile: RunnerProfile, id: string = randomUUID(), requestFingerprint?: string): RunnerExecSession {
  return {
    id,
    sessionId: `archie-${id}`,
    requestFingerprint,
    state: 'running',
    watermark: 0,
    deliveryCursor: 0,
    outputBytes: 0,
    outputTruncated: false,
    startedAt: nowIso(),
    deadlineAt: new Date(Date.now() + profile.execTimeoutSeconds * 1000).toISOString(),
  };
}

export class RunnerExecution {
  constructor(
    private readonly provider: RunnerProvider,
    private readonly hooks: ExecutionHooks,
  ) {}

  async restoreLogCursors(lease: RunnerLease): Promise<void> {
    for (const session of Object.values(lease.execSessions)) {
      const state = await readRunnerExecLogState(lease.taskId, lease.id, session.id);
      session.watermark = Math.max(session.watermark, state.watermark);
      session.deliveryCursor = Math.max(session.deliveryCursor, state.deliveryCursor);
    }
  }

  async startOrResume(lease: RunnerLease, profile: RunnerProfile, command: ExecuteCommand): Promise<RunnerCommandResult> {
    const requestFingerprint = fingerprint(command);
    const existing = lease.execSessions[command.requestId];
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error(`Runner request id ${command.requestId} was already used for a different command`);
      }
      if (isTerminal(existing)) return this.commandResult(lease, existing, 0);
      if (Date.parse(existing.deadlineAt) <= Date.now()) {
        await this.timeout(lease, existing);
        return this.commandResult(lease, existing, 0);
      }
      return this.consumeUntilWait(lease, profile, existing, {
        sessionId: existing.sessionId,
        reconnectFrom: existing.watermark,
      }, command.waitSeconds, 0);
    }

    this.assertCapacity(lease, profile);
    const session = createSession(profile, command.requestId, requestFingerprint);
    lease.execSessions[session.id] = session;
    this.hooks.touch(lease, profile);
    await this.hooks.persist(lease.taskId);
    emitEvent('runner:exec', lease.taskId, {
      action: 'start',
      leaseId: lease.id,
      execId: session.id,
      profile: lease.profile,
    }, lease.agentId);
    return this.consumeUntilWait(lease, profile, session, {
      argv: command.argv,
      cwd: command.cwd,
      env: command.env,
      sessionId: session.sessionId,
    }, command.waitSeconds, 0);
  }

  async poll(
    lease: RunnerLease,
    profile: RunnerProfile,
    execId: string,
    afterCursor: number,
    waitSeconds?: number,
  ): Promise<RunnerCommandResult> {
    const session = lease.execSessions[execId];
    if (!session) throw new Error(`Unknown runner exec session: ${execId}`);
    this.assertDeliveryCursor(session, afterCursor);
    if (isTerminal(session)) return this.commandResult(lease, session, afterCursor);
    if (Date.parse(session.deadlineAt) <= Date.now()) {
      await this.timeout(lease, session);
      return this.commandResult(lease, session, afterCursor);
    }
    return this.consumeUntilWait(lease, profile, session, {
      sessionId: session.sessionId,
      reconnectFrom: session.watermark,
    }, waitSeconds, afterCursor);
  }

  async cancel(lease: RunnerLease, profile: RunnerProfile, execId: string): Promise<void> {
    const session = lease.execSessions[execId];
    if (!session) throw new Error(`Unknown runner exec session: ${execId}`);
    if (isTerminal(session)) return;
    if (!await this.close(lease, session)) {
      throw new Error(`Failed to close runner command ${execId}; cleanup will retry`);
    }
    session.state = 'cancelled';
    session.finishedAt = nowIso();
    await this.hooks.persist(lease.taskId);
    await this.pruneHistory(lease, profile);
    emitEvent('runner:exec', lease.taskId, { action: 'cancel', leaseId: lease.id, execId }, lease.agentId);
  }

  async transfer(lease: RunnerLease, profile: RunnerProfile, command: TransferCommand): Promise<void> {
    this.assertCapacity(lease, profile);
    const session = createSession(profile);
    lease.execSessions[session.id] = session;
    await this.hooks.persist(lease.taskId);

    const controller = new AbortController();
    const abort = () => controller.abort(command.signal?.reason);
    if (command.signal?.aborted) abort();
    else command.signal?.addEventListener('abort', abort, { once: true });
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
      let request: ExecRequest = {
        argv: command.argv,
        cwd: command.cwd,
        stdin: command.stdin,
        sessionId: session.sessionId,
        signal: controller.signal,
      };
      let bootstrapComplete = command.stdin === undefined;
      while (session.state === 'running' && !controller.signal.aborted) {
        for await (const event of this.provider.exec(lease.backendId, request)) {
          if (event.type === 'bootstrap_complete') {
            bootstrapComplete = true;
          } else if (event.type === 'stdout') {
            session.outputBytes += event.data.byteLength;
            if (command.onStdout) await command.onStdout(event.data);
            else appendFailure(event.data);
          } else {
            await this.appendEvent(lease, session, event);
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
          if ('watermark' in event && event.watermark !== undefined) {
            session.watermark = Math.max(session.watermark, event.watermark);
          }
          await this.hooks.persist(lease.taskId);
        }
        if (session.state !== 'running' || controller.signal.aborted) break;
        if (!bootstrapComplete) throw new Error('Runner transfer disconnected before its stdin upload completed');
        request = { sessionId: session.sessionId, reconnectFrom: session.watermark, signal: controller.signal };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (controller.signal.aborted && session.state === 'running') await this.timeout(lease, session);
      if (session.state !== 'completed' || session.exitCode !== 0) {
        throw new Error(Buffer.concat(failure).toString('utf8').trim() || `Runner transfer exited with ${session.exitCode ?? 'no status'}`);
      }
    } catch (error) {
      if (session.state === 'running' && await this.close(lease, session)) {
        session.state = controller.signal.aborted ? 'timed_out' : 'failed';
        session.finishedAt = nowIso();
        await this.hooks.persist(lease.taskId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      command.signal?.removeEventListener('abort', abort);
      if (isTerminal(session)) {
        await this.pruneHistory(lease, profile).catch((error) => this.hooks.markDegraded(error, `history:${lease.id}`));
      }
    }
  }

  async timeoutOverdueSessions(lease: RunnerLease): Promise<void> {
    for (const session of Object.values(lease.execSessions)) {
      if (session.state === 'running' && Date.parse(session.deadlineAt) <= Date.now()) {
        await this.timeout(lease, session);
      }
    }
  }

  private assertCapacity(lease: RunnerLease, profile: RunnerProfile): void {
    const active = Object.values(lease.execSessions).filter((session) => session.state === 'running').length;
    if (active >= profile.maxActiveExecSessions) {
      throw new Error(`Runner has reached its ${profile.maxActiveExecSessions}-session active exec limit`);
    }
  }

  private async close(lease: RunnerLease, session: RunnerExecSession): Promise<boolean> {
    try {
      await this.provider.closeExec(lease.backendId, session.sessionId);
      this.hooks.markHealthy(`close:${session.id}`);
      return true;
    } catch (error) {
      session.deadlineAt = nowIso();
      this.hooks.markDegraded(error, `close:${session.id}`);
      await this.hooks.persist(lease.taskId).catch((persistError) => {
        this.hooks.markDegraded(persistError, `persist:${lease.id}`);
      });
      return false;
    }
  }

  private async appendEvent(lease: RunnerLease, session: RunnerExecSession, event: ExecEvent): Promise<void> {
    if (event.type === 'history_end' || event.type === 'bootstrap_complete') return;
    session.deliveryCursor = await appendRunnerExecLog(
      lease.taskId,
      lease.id,
      session.id,
      event,
      session.deliveryCursor,
    );
  }

  private assertDeliveryCursor(session: RunnerExecSession, afterCursor: number): void {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > session.deliveryCursor) {
      throw new Error(`Invalid delivery cursor ${afterCursor} for runner command ${session.id}`);
    }
  }

  private async commandResult(
    lease: RunnerLease,
    session: RunnerExecSession,
    afterCursor: number,
  ): Promise<RunnerCommandResult> {
    this.assertDeliveryCursor(session, afterCursor);
    const healthKey = `log:${session.id}`;
    let output: Awaited<ReturnType<typeof readRunnerExecOutput>>;
    try {
      output = await readRunnerExecOutput(lease.taskId, lease.id, session.id, afterCursor, TOOL_OUTPUT_LIMIT);
    } catch (error) {
      this.hooks.markDegraded(error, healthKey);
      throw error;
    }
    if (!output.hasMore && output.cursor < session.deliveryCursor) {
      const error = new Error(`Runner command ${session.id} output log is missing delivery cursor ${output.cursor + 1}`);
      this.hooks.markDegraded(error, healthKey);
      throw error;
    }
    this.hooks.markHealthy(healthKey);
    return {
      execId: session.id,
      state: session.state,
      exitCode: session.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
      truncated: output.truncated || session.outputTruncated,
      cursor: output.cursor,
      hasMore: output.hasMore || output.cursor < session.deliveryCursor,
    };
  }

  private async consumeUntilWait(
    lease: RunnerLease,
    profile: RunnerProfile,
    session: RunnerExecSession,
    request: ExecRequest,
    requestedWait?: number,
    afterCursor = 0,
  ): Promise<RunnerCommandResult> {
    const waitSeconds = Math.max(0, Math.min(
      requestedWait ?? profile.maxExecWaitSeconds,
      profile.maxExecWaitSeconds,
    ));
    const controller = new AbortController();
    let deadlineReached = false;
    const waitTimer = setTimeout(() => controller.abort(), waitSeconds * 1000);
    const deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, Math.max(0, Date.parse(session.deadlineAt) - Date.now()));
    try {
      for await (const event of this.provider.exec(lease.backendId, { ...request, signal: controller.signal })) {
        if (event.type === 'stdout' || event.type === 'stderr') {
          session.outputBytes += event.data.byteLength;
          if (session.outputBytes > profile.maxExecOutputBytes) {
            const bounded = `Runner command exceeded the ${profile.maxExecOutputBytes}-byte output limit`;
            session.outputTruncated = true;
            await this.appendEvent(lease, session, { type: 'error', error: bounded, watermark: event.watermark });
            throw new Error(bounded);
          }
          await this.appendEvent(lease, session, event);
        } else if (event.type === 'exit') {
          await this.appendEvent(lease, session, event);
          session.state = 'completed';
          session.exitCode = event.code;
          session.finishedAt = nowIso();
        } else if (event.type === 'error') {
          const errorData = Buffer.from(event.error);
          session.outputBytes += errorData.byteLength;
          if (session.outputBytes > profile.maxExecOutputBytes) {
            const bounded = `Runner error exceeded the ${profile.maxExecOutputBytes}-byte output limit`;
            session.outputTruncated = true;
            await this.appendEvent(lease, session, { type: 'error', error: bounded, watermark: event.watermark });
          } else {
            await this.appendEvent(lease, session, event);
          }
          session.state = 'failed';
          session.finishedAt = nowIso();
        }
        if ('watermark' in event && event.watermark !== undefined) {
          session.watermark = Math.max(session.watermark, event.watermark);
        }
        await this.hooks.persist(lease.taskId);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (await this.close(lease, session)) {
          session.state = 'failed';
          session.finishedAt = nowIso();
          await this.hooks.persist(lease.taskId);
        }
        throw error;
      }
    } finally {
      clearTimeout(waitTimer);
      clearTimeout(deadlineTimer);
    }
    if (deadlineReached && session.state === 'running') await this.timeout(lease, session);
    if (isTerminal(session)) {
      await this.pruneHistory(lease, profile);
      emitEvent('runner:exec', lease.taskId, {
        action: 'end',
        leaseId: lease.id,
        execId: session.id,
        state: session.state,
        exitCode: session.exitCode,
      }, lease.agentId);
    }
    return this.commandResult(lease, session, afterCursor);
  }

  async pruneHistory(lease: RunnerLease, profile: RunnerProfile): Promise<void> {
    const terminal = Object.values(lease.execSessions)
      .filter(isTerminal)
      .sort((left, right) => Date.parse(left.finishedAt ?? left.startedAt) - Date.parse(right.finishedAt ?? right.startedAt));
    const excess = terminal.slice(0, Math.max(0, terminal.length - profile.maxExecSessionHistory));
    for (const session of excess) {
      await removeRunnerExecLog(lease.taskId, lease.id, session.id);
      delete lease.execSessions[session.id];
    }
    if (excess.length > 0) await this.hooks.persist(lease.taskId);
  }

  private async timeout(lease: RunnerLease, session: RunnerExecSession): Promise<void> {
    if (!await this.close(lease, session)) return;
    session.state = 'timed_out';
    session.finishedAt = nowIso();
    await this.hooks.persist(lease.taskId);
    emitEvent('runner:exec', lease.taskId, {
      action: 'timeout',
      leaseId: lease.id,
      execId: session.id,
    }, lease.agentId);
  }
}
