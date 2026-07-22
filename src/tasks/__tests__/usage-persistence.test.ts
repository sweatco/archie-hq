/**
 * Unit tests for appendUsageRecord (the usage.jsonl writer).
 *
 * Reuses persistence.test.ts's mock set so the module graph stays isolated:
 * workdir.js (mkdtempSync SESSIONS_DIR), logger, event-bus, slack client, ./task.js.
 *
 * The writer is fire-and-forget: appendUsageRecord enqueues on a per-task write
 * queue and its own returned promise resolves BEFORE the queued file write runs.
 * Tests therefore await the observable effect (vi.waitFor) rather than the call.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { mkdir, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { basename } from 'node:path';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-usage-persistence-test-'));
});

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: () => false,
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: SESSIONS_ROOT,
  WORKDIR: SESSIONS_ROOT,
}));

vi.mock('./task.js', () => ({
  activeTasks: new Map(),
}));

import {
  appendUsageRecord,
  getUsageLogPath,
  getSharedPath,
  isSafeTaskId,
  generateTaskId,
  type TaskUsageRecord,
} from '../persistence.js';
// The mocked logger (see vi.mock above): logger.warn fires ONLY from the
// writer's catch block, so it is the observable signal that distinguishes the
// existsSync guard (no warn) from a swallowed write failure (warn).
import { logger } from '../../system/logger.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

// Reset call history between tests so one test's warn does not leak into
// another's assertion (the logger mock is module-level and shared).
beforeEach(() => {
  vi.clearAllMocks();
});

function makeRecord(taskId: string): TaskUsageRecord {
  return {
    ts: '2026-07-21T00:00:00.000Z',
    taskId,
    agentId: 'pm',
    agentKey: 'pm',
    query_nonce: 'nonce-abc-123',
    session_id: 'sess-xyz',
    subtype: 'success',
    num_turns: 3,
    total_cost_usd: 0.42,
    modelUsage: { 'claude-sonnet-4-5': { costUSD: 0.42 } },
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('appendUsageRecord', () => {
  it('appends one JSON line (including query_nonce) to shared/usage.jsonl and round-trips', async () => {
    const taskId = 'task-20260101-1200-write';
    await mkdir(getSharedPath(taskId), { recursive: true });

    const record = makeRecord(taskId);
    await appendUsageRecord(record);

    const usagePath = getUsageLogPath(taskId);
    await vi.waitFor(() => expect(existsSync(usagePath)).toBe(true));

    const contents = await readFile(usagePath, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as TaskUsageRecord;
    expect(parsed).toEqual(record);
    expect(parsed.query_nonce).toBe('nonce-abc-123');
  });

  it('no-ops via the existsSync guard (no file, no failed-write log) when shared/ is missing', async () => {
    const taskId = 'task-20260101-1200-missing';
    const sharedPath = getSharedPath(taskId);
    expect(existsSync(sharedPath)).toBe(false);

    await expect(appendUsageRecord(makeRecord(taskId))).resolves.toBeUndefined();

    // Give the queued write ample time to (incorrectly) run, then assert absence.
    await delay(100);
    expect(existsSync(getUsageLogPath(taskId))).toBe(false);
    expect(existsSync(sharedPath)).toBe(false);

    // Pins the `if (!existsSync(dir)) return;` guard specifically. Without it,
    // appendFile would be attempted against a path whose parent is missing,
    // fail with ENOENT, and be caught+logged — so a warn here proves the guard
    // was skipped. File-absence alone cannot distinguish these two paths (a
    // failed write also leaves no file), which is why this assertion is needed.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows write failures (logs, resolves, never rejects) when shared/ exists but the target is unwritable', async () => {
    const taskId = 'task-20260101-1200-wfails';
    await mkdir(getSharedPath(taskId), { recursive: true });
    // Occupy the usage-log path with a directory so appendFile fails with
    // EISDIR. shared/ exists, so the existsSync guard does NOT short-circuit —
    // this drives the try/catch on a genuine write failure, the exact path
    // spawn.ts reaches via the fire-and-forget `void appendUsageRecord(...)`.
    await mkdir(getUsageLogPath(taskId), { recursive: true });

    // Fire-and-forget: the returned promise resolves immediately regardless.
    await expect(appendUsageRecord(makeRecord(taskId))).resolves.toBeUndefined();

    // The queued write must be caught and logged rather than rethrown. Without
    // the try/catch the queued promise would reject; because it is void-called
    // at spawn.ts, that surfaces as an unhandled rejection under Node's default
    // policy and crashes the process. logger.warn firing is the deterministic
    // proof the catch ran (and that the promise settled instead of rejecting).
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalledWith('usage', expect.stringContaining(taskId));
  });

  // Path-injection guard: an unsafe taskId must be rejected before any path is
  // built, so the writer never runs and nothing is written (CodeQL sink at
  // getSharedPath/getUsageLogPath + appendFile).
  it('no-ops on an unsafe (traversal) taskId: no write, no throw, no failed-write log', async () => {
    // A real task whose shared/ EXISTS — so the existsSync guard alone would
    // NOT stop the write; only the isSafeTaskId guard does.
    const realTaskId = 'task-20260101-1200-real01';
    await mkdir(getSharedPath(realTaskId), { recursive: true });

    // Unsafe id that, unguarded, normalizes back to the real task's shared/ dir
    // under SESSIONS_ROOT and would therefore pass existsSync and append there.
    const unsafe = `../${basename(SESSIONS_ROOT)}/${realTaskId}`;

    await expect(appendUsageRecord(makeRecord(unsafe))).resolves.toBeUndefined();

    // Give the queued write ample time to (incorrectly) run, then assert nothing
    // landed at the real task's usage log and no failed-write warn fired — the
    // guard returned before the try/catch, so the writer never ran.
    await delay(100);
    expect(existsSync(getUsageLogPath(realTaskId))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('isSafeTaskId', () => {
  it('accepts the canonical generateTaskId shape, including a freshly generated id', () => {
    expect(isSafeTaskId('task-20260101-1200-a3f9k2')).toBe(true);
    expect(isSafeTaskId(generateTaskId())).toBe(true);
  });

  it('rejects empty, traversal, and non-canonical ids', () => {
    for (const bad of [
      '',
      '../../etc',
      'task-..%2f',
      '../secret',
      'task-20260101-1200-a3f9k2/../x',
      'TASK-20260101-1200-abc',
      'task-2026-1200-abc',
      'foo',
    ]) {
      expect(isSafeTaskId(bad)).toBe(false);
    }
  });
});
