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

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdir, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';

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
  type TaskUsageRecord,
} from '../persistence.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
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
    const taskId = 'task-usage-write';
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

  it('no-ops (no file, no throw) when shared/ is missing', async () => {
    const taskId = 'task-usage-missing-shared';
    const sharedPath = getSharedPath(taskId);
    expect(existsSync(sharedPath)).toBe(false);

    await expect(appendUsageRecord(makeRecord(taskId))).resolves.toBeUndefined();

    // Give the queued write ample time to (incorrectly) run, then assert absence.
    await delay(100);
    expect(existsSync(getUsageLogPath(taskId))).toBe(false);
    expect(existsSync(sharedPath)).toBe(false);
  });
});
