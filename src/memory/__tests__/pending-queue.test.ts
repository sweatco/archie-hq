/**
 * Pending Queue Tests
 *
 * Round-trip enqueue/dequeue/read, idempotency, and atomic-write resilience
 * against a temp directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;
let pendingPath: string;

vi.mock('../paths.js', () => ({
  getMemoryDir: () => tempDir,
  getPendingPath: () => pendingPath,
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._\-]+$/.test(id),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { enqueuePending, dequeuePending, readPending } from '../pending-queue.js';

describe('pending-queue', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-pending-test-'));
    pendingPath = join(tempDir, 'pending-extractions.md');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', async () => {
    expect(await readPending()).toEqual([]);
  });

  it('does not hide queue read errors', async () => {
    await mkdir(pendingPath);
    await expect(readPending()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('enqueue creates the file with the entry', async () => {
    await enqueuePending('task-001');
    expect(existsSync(pendingPath)).toBe(true);
    const content = await readFile(pendingPath, 'utf-8');
    expect(content).toContain('# Pending Extractions');
    expect(content).toContain('- task-001');
    expect(await readPending()).toEqual(['task-001']);
  });

  it('enqueue is idempotent', async () => {
    await enqueuePending('task-001');
    await enqueuePending('task-001');
    expect(await readPending()).toEqual(['task-001']);
  });

  it('preserves order across multiple enqueues', async () => {
    await enqueuePending('task-001');
    await enqueuePending('task-002');
    await enqueuePending('task-003');
    expect(await readPending()).toEqual(['task-001', 'task-002', 'task-003']);
  });

  it('dequeue removes the specific entry', async () => {
    await enqueuePending('task-001');
    await enqueuePending('task-002');
    await dequeuePending('task-001');
    expect(await readPending()).toEqual(['task-002']);
  });

  it('dequeue on missing entry is a no-op', async () => {
    await enqueuePending('task-001');
    await dequeuePending('task-999');
    expect(await readPending()).toEqual(['task-001']);
  });

  it('refuses malformed task IDs', async () => {
    await enqueuePending('has space');
    expect(existsSync(pendingPath)).toBe(false);
  });

  it('survives a malformed file by skipping unparseable lines', async () => {
    await writeFile(pendingPath, '# Pending Extractions\n\n- task-001\nbogus line\n- task-002\n', 'utf-8');
    expect(await readPending()).toEqual(['task-001', 'task-002']);
  });

  it('emits a writable header even when empty after a dequeue', async () => {
    await enqueuePending('task-001');
    await dequeuePending('task-001');
    const content = await readFile(pendingPath, 'utf-8');
    expect(content).toContain('# Pending Extractions');
    expect(await readPending()).toEqual([]);
  });
});
