import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { writeJsonAtomic, readJson } from '../system/secrets-vault.js';
import { createKeyedLock } from '../system/keyed-lock.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { getSharedPath } from '../tasks/persistence.js';
import type { ExecEvent, RunnerLease, RunnerLeaseFile } from './types.js';

const execSessionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']),
  watermark: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().optional(),
}).strict();

const leaseSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  profile: z.string(),
  backendId: z.string(),
  state: z.enum(['provisioning', 'ready', 'failed', 'releasing']),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  debugExpiresAt: z.iso.datetime().optional(),
  failure: z.string().optional(),
  syncedRepos: z.record(z.string(), z.object({
    github: z.string(),
    remotePath: z.string(),
    syncedAt: z.iso.datetime(),
  }).strict()),
  execSessions: z.record(z.string(), execSessionSchema),
}).strict();

const leaseFileSchema = z.object({
  version: z.literal(1),
  leases: z.array(leaseSchema),
}).strict();

const saveLock = createKeyedLock();

export function getRunnerStatePath(taskId: string): string {
  return join(getSharedPath(taskId), 'runners.json');
}

export function getRunnerDataPath(taskId: string, leaseId: string): string {
  return join(getSharedPath(taskId), 'runners', leaseId);
}

export function getRunnerExecLogPath(taskId: string, leaseId: string, execId: string): string {
  return join(getRunnerDataPath(taskId, leaseId), 'exec', `${execId}.jsonl`);
}

export async function loadRunnerLeases(taskId: string): Promise<RunnerLease[]> {
  const raw = await readJson<unknown>(getRunnerStatePath(taskId));
  if (raw === null) return [];
  return leaseFileSchema.parse(raw).leases as RunnerLease[];
}

export function saveRunnerLeases(taskId: string, leases: readonly RunnerLease[]): Promise<void> {
  const file: RunnerLeaseFile = { version: 1, leases: structuredClone([...leases]) };
  return saveLock(taskId, async () => {
    await writeJsonAtomic(getRunnerStatePath(taskId), file);
  });
}

export async function listRunnerTaskIds(): Promise<string[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('task-') && existsSync(getRunnerStatePath(entry.name)))
    .map((entry) => entry.name);
}

export async function appendRunnerExecLog(
  taskId: string,
  leaseId: string,
  execId: string,
  event: ExecEvent,
): Promise<void> {
  if (event.type === 'history_end') return;
  const path = getRunnerExecLogPath(taskId, leaseId, execId);
  await mkdir(join(getRunnerDataPath(taskId, leaseId), 'exec'), { recursive: true });
  const record = event.type === 'stdout' || event.type === 'stderr'
    ? { type: event.type, data: Buffer.from(event.data).toString('utf8'), watermark: event.watermark }
    : event;
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}

export async function readRunnerExecWatermark(taskId: string, leaseId: string, execId: string): Promise<number> {
  const path = getRunnerExecLogPath(taskId, leaseId, execId);
  if (!existsSync(path)) return 0;
  let watermark = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const record = JSON.parse(line) as { watermark?: unknown };
      if (typeof record.watermark === 'number' && Number.isSafeInteger(record.watermark) && record.watermark >= 0) {
        watermark = Math.max(watermark, record.watermark);
      }
    } catch {
      continue;
    }
  }
  return watermark;
}
