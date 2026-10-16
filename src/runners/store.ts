import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { writeJsonAtomic, readJson } from '../system/secrets-vault.js';
import { createKeyedLock } from '../system/keyed-lock.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { getSharedPath } from '../tasks/persistence.js';
import type { ExecEvent, RunnerLease, RunnerLeaseFile } from './types.js';

const taskIdSchema = z.string().regex(/^task-\d{8}-\d{4}-[a-z0-9]+$/);
const uuidV4Schema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

function assertTaskId(taskId: string): void {
  taskIdSchema.parse(taskId);
}

function assertUuid(value: string): void {
  uuidV4Schema.parse(value);
}

const execSessionSchema = z.object({
  id: uuidV4Schema,
  sessionId: z.string().regex(/^archie-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']),
  watermark: z.number().int().nonnegative(),
  deliveryCursor: z.number().int().nonnegative().default(0),
  outputBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean().default(false),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().optional(),
}).strict();

const leaseSchema = z.object({
  id: uuidV4Schema,
  taskId: taskIdSchema,
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
  execSessions: z.record(uuidV4Schema, execSessionSchema),
}).strict();

const leaseFileSchema = z.object({
  version: z.literal(1),
  leases: z.array(leaseSchema),
}).strict();

const saveLock = createKeyedLock();

export function getRunnerStatePath(taskId: string): string {
  assertTaskId(taskId);
  return join(getSharedPath(taskId), 'runners.json');
}

export function getRunnerDataPath(taskId: string, leaseId: string): string {
  assertTaskId(taskId);
  assertUuid(leaseId);
  return join(getSharedPath(taskId), 'runners', leaseId);
}

export function getRunnerExecLogPath(taskId: string, leaseId: string, execId: string): string {
  assertUuid(execId);
  return join(getRunnerDataPath(taskId, leaseId), 'exec', `${execId}.jsonl`);
}

export async function loadRunnerLeases(taskId: string): Promise<RunnerLease[]> {
  const raw = await readJson<unknown>(getRunnerStatePath(taskId));
  if (raw === null) return [];
  return leaseFileSchema.parse(raw).leases as RunnerLease[];
}

export function saveRunnerLeases(taskId: string, leases: readonly RunnerLease[]): Promise<void> {
  assertTaskId(taskId);
  const file = leaseFileSchema.parse({ version: 1, leases: structuredClone([...leases]) }) as RunnerLeaseFile;
  if (file.leases.some((lease) => lease.taskId !== taskId)) throw new Error(`Runner leases are stored under the wrong task: ${taskId}`);
  return saveLock(taskId, async () => {
    await writeJsonAtomic(getRunnerStatePath(taskId), file);
  });
}

export async function listRunnerTaskIds(): Promise<string[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && taskIdSchema.safeParse(entry.name).success && existsSync(getRunnerStatePath(entry.name)))
    .map((entry) => entry.name);
}

export async function appendRunnerExecLog(
  taskId: string,
  leaseId: string,
  execId: string,
  event: ExecEvent,
  afterCursor: number,
  metadata: { terminal?: false; outputBytes?: number; outputTruncated?: true } = {},
): Promise<number> {
  if (event.type === 'history_end') return afterCursor;
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error(`Invalid runner delivery cursor: ${afterCursor}`);
  const path = getRunnerExecLogPath(taskId, leaseId, execId);
  await mkdir(join(getRunnerDataPath(taskId, leaseId), 'exec'), { recursive: true });
  const record = event.type === 'stdout' || event.type === 'stderr'
    ? { type: event.type, data: Buffer.from(event.data).toString('base64'), encoding: 'base64', watermark: event.watermark }
    : event;
  const cursor = afterCursor + recordDeliverySize(record);
  await appendFile(path, `\n${JSON.stringify({ timestamp: new Date().toISOString(), cursor, ...record, ...metadata })}\n`, { mode: 0o600 });
  return cursor;
}

interface LogRecord { type?: unknown; data?: unknown; encoding?: unknown; error?: unknown; watermark?: unknown; cursor?: unknown; code?: unknown; timestamp?: unknown; terminal?: unknown; outputBytes?: unknown; outputTruncated?: unknown }

function recordData(record: LogRecord): Buffer {
  return Buffer.from(String(record.data), record.encoding === 'base64' ? 'base64' : 'utf8');
}

function recordDeliverySize(record: LogRecord): number {
  if ((record.type === 'stdout' || record.type === 'stderr') && typeof record.data === 'string') {
    return Math.max(1, recordData(record).length);
  }
  if (record.type === 'error' && typeof record.error === 'string') {
    return Math.max(1, Buffer.byteLength(record.error));
  }
  if (record.type === 'exit') return 1;
  throw new Error('Invalid runner exec log record');
}

function utf8PageLength(data: Buffer, offset: number, limit: number, allowSingleScalarOverrun: boolean): number {
  if (offset >= data.length || limit <= 0) return 0;
  let end = Math.min(data.length, offset + limit);
  if (end === data.length) return end - offset;
  while (end > offset && (data[end] & 0xc0) === 0x80) end -= 1;
  if (end > offset) return end - offset;
  if (!allowSingleScalarOverrun) return 0;
  const lead = data[offset];
  const scalarBytes = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return Math.min(scalarBytes, data.length - offset);
}

export interface RunnerExecLogState {
  watermark: number;
  deliveryCursor: number;
  outputBytes: number;
  outputTruncated?: boolean;
  terminal?: { state: 'completed' | 'failed'; exitCode?: number; finishedAt: string };
}

export async function readRunnerExecLogState(taskId: string, leaseId: string, execId: string): Promise<RunnerExecLogState> {
  const path = getRunnerExecLogPath(taskId, leaseId, execId);
  if (!existsSync(path)) return { watermark: 0, deliveryCursor: 0, outputBytes: 0 };
  let watermark = 0;
  let outputBytes = 0;
  let outputTruncated = false;
  let terminal: RunnerExecLogState['terminal'];
  let deliveryCursor = 0;
  let legacyCursor = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let record: LogRecord;
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const expectedCursor = deliveryCursor + recordDeliverySize(record);
    if (record.type === 'stdout' || record.type === 'stderr') outputBytes += recordData(record).length;
    else if (record.type === 'error') outputBytes += Buffer.byteLength(String(record.error));
    if (typeof record.outputBytes === 'number' && Number.isSafeInteger(record.outputBytes) && record.outputBytes >= 0) outputBytes = Math.max(outputBytes, record.outputBytes);
    outputTruncated ||= record.outputTruncated === true;
    legacyCursor = expectedCursor;
    if (typeof record.watermark === 'number' && Number.isSafeInteger(record.watermark) && record.watermark >= 0) {
      watermark = Math.max(watermark, record.watermark);
    }
    const cursor = typeof record.cursor === 'number' && Number.isSafeInteger(record.cursor) && record.cursor >= 1
      ? record.cursor
      : legacyCursor;
    if (cursor !== expectedCursor) throw new Error(`Runner exec log cursor gap: expected ${expectedCursor}, found ${cursor}`);
    deliveryCursor = cursor;
    if ((record.type === 'exit' || record.type === 'error') && record.terminal !== false && typeof record.timestamp === 'string') {
      if (record.type === 'exit' && (!Number.isSafeInteger(record.code))) throw new Error('Invalid runner exec exit code');
      terminal = { state: record.type === 'exit' ? 'completed' : 'failed', finishedAt: record.timestamp, ...(record.type === 'exit' ? { exitCode: record.code as number } : {}) };
    }
  }
  return { watermark, deliveryCursor, outputBytes, ...(outputTruncated ? { outputTruncated } : {}), ...(terminal ? { terminal } : {}) };
}

export async function readRunnerExecOutput(
  taskId: string,
  leaseId: string,
  execId: string,
  afterCursor: number,
  maxBytes: number,
): Promise<{ stdout: string; stderr: string; cursor: number; hasMore: boolean; truncated: boolean }> {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error(`Invalid runner delivery cursor: ${afterCursor}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`Invalid runner output limit: ${maxBytes}`);
  const path = getRunnerExecLogPath(taskId, leaseId, execId);
  if (!existsSync(path)) {
    if (afterCursor > 0) throw new Error(`Runner exec log is missing after delivery cursor ${afterCursor}`);
    return { stdout: '', stderr: '', cursor: 0, hasMore: false, truncated: false };
  }
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const pending = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let cursor = afterCursor;
  let logCursor = 0;
  let returnedBytes = 0;
  let deliveryBlocked = false;
  // Replay pending bytes from earlier records on every read, including after restart.
  const replay = (kind: 'stdout' | 'stderr', data: Buffer) => {
    const combined = Buffer.concat([pending[kind], data]);
    pending[kind] = combined.subarray(completeUtf8Length(combined));
  };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let record: LogRecord;
    try { record = JSON.parse(line) as LogRecord; } catch { continue; }
    const recordStart = logCursor;
    const expectedCursor = recordStart + recordDeliverySize(record);
    const recordCursor = typeof record.cursor === 'number' && Number.isSafeInteger(record.cursor) && record.cursor >= 1
      ? record.cursor : expectedCursor;
    if (recordCursor !== expectedCursor) throw new Error(`Runner exec log cursor gap: expected ${expectedCursor}, found ${recordCursor}`);
    logCursor = recordCursor;
    const kind = record.type === 'stdout' ? 'stdout' : 'stderr';
    const data = record.type === 'stdout' || record.type === 'stderr' ? recordData(record)
      : record.type === 'error' ? Buffer.from(String(record.error)) : undefined;
    if (recordCursor <= afterCursor) {
      if (data) replay(kind, data);
      if (record.type === 'exit' || record.type === 'error') { pending.stdout = Buffer.alloc(0); pending.stderr = Buffer.alloc(0); }
      continue;
    }
    if (deliveryBlocked) continue;
    if (data?.length) {
      const offset = Math.max(0, afterCursor - recordStart);
      if (offset) {
        replay(kind, data.subarray(0, offset));
        if (pending[kind].length) throw new Error('Runner delivery cursor splits a UTF-8 character');
      }
      const carried = pending[kind].length;
      const combined = Buffer.concat([pending[kind], data.subarray(offset)]);
      const complete = completeUtf8Length(combined);
      const length = utf8PageLength(combined.subarray(0, complete), 0, maxBytes - returnedBytes, returnedBytes === 0);
      output[kind].push(combined.subarray(0, length));
      returnedBytes += length;
      if (length < complete) {
        cursor = recordStart + offset + Math.max(0, length - carried);
        deliveryBlocked = true;
        continue;
      }
      pending[kind] = combined.subarray(complete);
    }
    if (record.type === 'exit' || record.type === 'error') {
      const tailBytes = pending.stdout.length + pending.stderr.length;
      // At most two incomplete scalars; flush with the terminal cursor even if
      // this slightly exceeds the page budget, rather than replaying emitted bytes.
      output.stdout.push(pending.stdout);
      output.stderr.push(pending.stderr);
      returnedBytes += tailBytes;
      pending.stdout = Buffer.alloc(0);
      pending.stderr = Buffer.alloc(0);
    }
    cursor = recordCursor;
  }
  if (afterCursor > logCursor) throw new Error(`Delivery cursor ${afterCursor} is beyond runner exec log cursor ${logCursor}`);
  return {
    stdout: Buffer.concat(output.stdout).toString('utf8'),
    stderr: Buffer.concat(output.stderr).toString('utf8'),
    cursor,
    hasMore: cursor < logCursor,
    truncated: false,
  };
}

/** Keep only an incomplete trailing scalar; invalid complete bytes decode normally. */
function completeUtf8Length(data: Buffer): number {
  if (!data.length) return 0;
  let start = data.length - 1;
  while (start > 0 && (data[start] & 0xc0) === 0x80) start--;
  const lead = data[start];
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return data.length - start < expected ? start : data.length;
}

export function removeRunnerExecLog(taskId: string, leaseId: string, execId: string): Promise<void> {
  return rm(getRunnerExecLogPath(taskId, leaseId, execId), { force: true });
}
