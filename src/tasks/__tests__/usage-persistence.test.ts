/**
 * Filesystem-backed tests for the usage JSONL writer.
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
import { logger } from '../../system/logger.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

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

describe('appendUsageRecord', () => {
  it('appends one JSON line (including query_nonce) to shared/usage.jsonl and round-trips', async () => {
    const taskId = 'task-20260101-1200-write';
    await mkdir(getSharedPath(taskId), { recursive: true });

    const record = makeRecord(taskId);
    await appendUsageRecord(record);

    const usagePath = getUsageLogPath(taskId);
    expect(existsSync(usagePath)).toBe(true);

    const contents = await readFile(usagePath, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as TaskUsageRecord;
    expect(parsed).toEqual(record);
    expect(parsed.query_nonce).toBe('nonce-abc-123');
  });

  it('serializes concurrent appends in call order', async () => {
    const taskId = 'task-20260101-1200-queue';
    await mkdir(getSharedPath(taskId), { recursive: true });
    const first = { ...makeRecord(taskId), query_nonce: 'first' };
    const second = { ...makeRecord(taskId), query_nonce: 'second' };

    await Promise.all([appendUsageRecord(first), appendUsageRecord(second)]);

    const records = (await readFile(getUsageLogPath(taskId), 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TaskUsageRecord);
    expect(records.map((record) => record.query_nonce)).toEqual(['first', 'second']);
  });

  it('no-ops via the existsSync guard (no file, no failed-write log) when shared/ is missing', async () => {
    const taskId = 'task-20260101-1200-missing';
    const sharedPath = getSharedPath(taskId);
    expect(existsSync(sharedPath)).toBe(false);

    await expect(appendUsageRecord(makeRecord(taskId))).resolves.toBeUndefined();

    expect(existsSync(getUsageLogPath(taskId))).toBe(false);
    expect(existsSync(sharedPath)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows write failures (logs, resolves, never rejects) when shared/ exists but the target is unwritable', async () => {
    const taskId = 'task-20260101-1200-wfails';
    await mkdir(getSharedPath(taskId), { recursive: true });
    // A directory at the log path makes appendFile fail with EISDIR.
    await mkdir(getUsageLogPath(taskId), { recursive: true });

    await expect(appendUsageRecord(makeRecord(taskId))).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('usage', expect.stringContaining(taskId));
  });

  it('no-ops on an unsafe (traversal) taskId: no write, no throw, no failed-write log', async () => {
    const realTaskId = 'task-20260101-1200-real01';
    await mkdir(getSharedPath(realTaskId), { recursive: true });

    // Without validation this traversal normalizes to the real task directory.
    const unsafe = `../${basename(SESSIONS_ROOT)}/${realTaskId}`;

    await expect(appendUsageRecord(makeRecord(unsafe))).resolves.toBeUndefined();

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
