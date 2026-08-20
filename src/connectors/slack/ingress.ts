import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKDIR } from '../../system/workdir.js';
import { createKeyedLock } from '../../system/keyed-lock.js';
import { logger } from '../../system/logger.js';

export interface SlackIngressRef {
  type: 'app_mention' | 'message';
  channel: string;
  user: string;
  ts: string;
  threadTs?: string;
}

export type SlackIngressOutcome =
  | { status: 'complete' }
  | { status: 'terminal'; reason: string };

export type SlackIngressWake = 'new' | 'existing';

export interface SlackIngressRecovery {
  wake?: SlackIngressWake;
  checkpoint: (wake: SlackIngressWake) => Promise<void>;
}

export type SlackIngressProcessor = (
  ref: SlackIngressRef,
  recovery: SlackIngressRecovery,
) => Promise<SlackIngressOutcome>;

interface SlackIngressRecord {
  version: 1;
  attempts: number;
  nextAttemptAt: number;
  ref: SlackIngressRef;
  wake?: SlackIngressWake;
}

const MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const MAX_CONCURRENT_THREADS = 4;
const SHUTDOWN_DRAIN_MS = 30_000;
const enqueueLock = createKeyedLock();

let processor: SlackIngressProcessor | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let drainPromise: Promise<void> | null = null;
let rerunRequested = false;
const activeRecords = new Map<string, Promise<void>>();
const infrastructureRetryAt = new Map<string, number>();

function ingressDir(): string {
  return join(WORKDIR, 'slack', 'ingress');
}

function normalizeRef(ref: SlackIngressRef): SlackIngressRef {
  if (ref.type !== 'app_mention' && ref.type !== 'message') throw new Error('Invalid Slack ingress type');
  if (!/^[A-Z0-9]+$/.test(ref.channel)) throw new Error('Invalid Slack channel ID');
  if (!/^[A-Z0-9]+$/.test(ref.user)) throw new Error('Invalid Slack user ID');
  if (!/^\d+\.\d+$/.test(ref.ts)) throw new Error('Invalid Slack message timestamp');
  if (ref.threadTs !== undefined && !/^\d+\.\d+$/.test(ref.threadTs)) {
    throw new Error('Invalid Slack thread timestamp');
  }
  return {
    type: ref.type,
    channel: ref.channel,
    user: ref.user,
    ts: ref.ts,
    ...(ref.threadTs ? { threadTs: ref.threadTs } : {}),
  };
}

function recordPath(ref: SlackIngressRef): string {
  return join(ingressDir(), `${ref.channel}-${ref.ts}.json`);
}

function deadRecordPath(path: string): string {
  return `${path}.dead`;
}

async function writeRecord(path: string, record: object): Promise<void> {
  await mkdir(ingressDir(), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readRecord(path: string): Promise<SlackIngressRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as SlackIngressRecord;
    if (
      parsed.version !== 1
      || !Number.isInteger(parsed.attempts)
      || !Number.isFinite(parsed.nextAttemptAt)
      || (parsed.wake !== undefined && parsed.wake !== 'new' && parsed.wake !== 'existing')
    ) {
      throw new Error('unsupported record shape');
    }
    return { ...parsed, ref: normalizeRef(parsed.ref) };
  } catch (error) {
    const quarantinePath = `${path}.${Date.now()}.invalid`;
    try {
      await rename(path, quarantinePath);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw renameError;
    }
    logger.warn('Slack', `Quarantined invalid ingress record ${path}: ${error}`);
    return null;
  }
}

async function listRecords(): Promise<{
  records: Array<{ path: string; record: SlackIngressRecord }>;
  unreadable: boolean;
}> {
  const directory = ingressDir();
  if (!existsSync(directory)) return { records: [], unreadable: false };
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const records: Array<{ path: string; record: SlackIngressRecord }> = [];
  let unreadable = false;
  for (const name of names) {
    const path = join(directory, name);
    try {
      const record = await readRecord(path);
      if (record) records.push({ path, record });
    } catch (error) {
      unreadable = true;
      logger.warn('Slack', `Could not read ingress record ${path}; will retry`, error);
    }
  }
  return { records, unreadable };
}

function safeReason(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : fallback;
  const safe = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.slice(0, 80) || fallback;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown_error';
  const candidate = error as { code?: unknown; data?: { error?: unknown } };
  return safeReason(candidate.data?.error ?? candidate.code, 'unknown_error');
}

function retryDelay(attempts: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

function armDrain(delayMs: number): void {
  if (!processor) return;
  if (drainPromise && delayMs === 0) {
    rerunRequested = true;
    return;
  }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    requestDrain();
  }, Math.max(0, delayMs));
  retryTimer.unref?.();
}

async function removeRecord(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function moveToDead(
  path: string,
  record: SlackIngressRecord,
  reason: string,
  lastError?: string,
): Promise<void> {
  await writeRecord(deadRecordPath(path), {
    ...record,
    state: 'dead',
    reason: safeReason(reason, 'terminal'),
    ...(lastError ? { lastError } : {}),
  });
  await removeRecord(path);
}

async function processRecord(path: string): Promise<void> {
  if (existsSync(deadRecordPath(path))) {
    await removeRecord(path);
    return;
  }
  const loaded = await readRecord(path);
  if (!loaded || loaded.nextAttemptAt > Date.now() || !processor) return;
  let current: SlackIngressRecord = loaded;

  try {
    const outcome = await processor(current.ref, {
      wake: current.wake,
      checkpoint: async (wake) => {
        if (current.wake && current.wake !== wake) {
          throw new Error(`Slack ingress wake changed from ${current.wake} to ${wake}`);
        }
        if (current.wake) return;
        current = { ...current, wake };
        await writeRecord(path, current);
      },
    });
    if (outcome.status === 'terminal') {
      logger.system(`Discarding terminal Slack ingress ${current.ref.channel}:${current.ref.ts} (${safeReason(outcome.reason, 'terminal')})`);
    }
    await removeRecord(path);
  } catch (error) {
    const attempts = current.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await moveToDead(path, { ...current, attempts }, 'retry_exhausted', errorCode(error));
    } else {
      await writeRecord(path, {
        ...current,
        attempts,
        nextAttemptAt: Date.now() + retryDelay(attempts),
        lastError: errorCode(error),
      });
    }
  }
}

function startRecord(path: string): Promise<void> {
  const existing = activeRecords.get(path);
  if (existing) return existing;

  let infrastructureFailed = false;
  const running = processRecord(path)
    .catch((error) => {
      infrastructureFailed = true;
      infrastructureRetryAt.set(path, Date.now() + BASE_RETRY_MS);
      logger.error('Slack', `Failed to process durable ingress record ${path}`, error);
    })
    .finally(() => {
      activeRecords.delete(path);
      if (!infrastructureFailed) infrastructureRetryAt.delete(path);
      requestDrain();
    });
  activeRecords.set(path, running);
  return running;
}

function oldestByThread(
  entries: Array<{ path: string; record: SlackIngressRecord }>,
): Array<{ path: string; record: SlackIngressRecord }> {
  const oldest = new Map<string, { path: string; record: SlackIngressRecord }>();
  for (const entry of entries.sort((a, b) => Number(a.record.ref.ts) - Number(b.record.ref.ts))) {
    const key = `${entry.record.ref.channel}:${entry.record.ref.threadTs ?? entry.record.ref.ts}`;
    if (!oldest.has(key)) oldest.set(key, entry);
  }
  return [...oldest.values()];
}

async function drainDueRecords(): Promise<void> {
  const initial = await listRecords();
  const due = oldestByThread(initial.records)
    .filter(({ path, record }) => (
      Math.max(record.nextAttemptAt, infrastructureRetryAt.get(path) ?? 0) <= Date.now()
      && !activeRecords.has(path)
    ));
  const available = Math.max(0, MAX_CONCURRENT_THREADS - activeRecords.size);
  for (const { path } of due.slice(0, available)) {
    void startRecord(path);
  }

  const remaining = await listRecords();
  if (activeRecords.size >= MAX_CONCURRENT_THREADS) return;
  const inactive = oldestByThread(remaining.records).filter(({ path }) => !activeRecords.has(path));
  const dueRemaining = inactive.some(({ path, record }) => (
    Math.max(record.nextAttemptAt, infrastructureRetryAt.get(path) ?? 0) <= Date.now()
  ));
  if (dueRemaining) {
    armDrain(0);
    return;
  }
  const nextRecord = inactive.reduce(
    (earliest, { path, record }) => Math.min(
      earliest,
      Math.max(record.nextAttemptAt, infrastructureRetryAt.get(path) ?? 0),
    ),
    Number.POSITIVE_INFINITY,
  );
  const nextRead = initial.unreadable || remaining.unreadable
    ? Date.now() + BASE_RETRY_MS
    : Number.POSITIVE_INFINITY;
  const next = Math.min(nextRecord, nextRead);
  if (Number.isFinite(next)) armDrain(Math.max(0, next - Date.now()));
}

function requestDrain(): void {
  if (!processor) return;
  if (drainPromise) {
    rerunRequested = true;
    return;
  }
  drainPromise = drainDueRecords()
    .catch((error) => {
      logger.error('Slack', 'Failed to drain durable ingress', error);
      armDrain(BASE_RETRY_MS);
    })
    .finally(() => {
      drainPromise = null;
      if (rerunRequested) {
        rerunRequested = false;
        requestDrain();
      }
    });
}

async function waitForActiveWork(): Promise<void> {
  while (drainPromise || activeRecords.size > 0) {
    await Promise.allSettled([
      ...(drainPromise ? [drainPromise] : []),
      ...activeRecords.values(),
    ]);
  }
}

export async function enqueueSlackIngress(input: SlackIngressRef): Promise<void> {
  const ref = normalizeRef(input);
  const path = recordPath(ref);
  await enqueueLock(path, async () => {
    if (existsSync(path) || existsSync(deadRecordPath(path))) return;
    await writeRecord(path, {
      version: 1,
      attempts: 0,
      nextAttemptAt: Date.now(),
      ref,
    });
  });
  armDrain(0);
}

export async function startSlackIngress(nextProcessor: SlackIngressProcessor): Promise<void> {
  processor = nextProcessor;
  await mkdir(ingressDir(), { recursive: true, mode: 0o700 });
  armDrain(0);
}

export async function stopSlackIngress(): Promise<void> {
  processor = null;
  rerunRequested = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (!drainPromise && activeRecords.size === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    waitForActiveWork().then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(() => resolve(true), SHUTDOWN_DRAIN_MS);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (timedOut) logger.warn('Slack', 'Timed out draining Slack ingress during shutdown; pending records will replay');
}

export async function waitForSlackIngressIdle(): Promise<void> {
  await waitForActiveWork();
}
