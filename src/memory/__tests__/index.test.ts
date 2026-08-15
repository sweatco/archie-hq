import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;
const state = vi.hoisted(() => ({ memoryDir: '', runtimeDisabled: false }));

const { onTaskCompleted, disableMemoryRuntime } = vi.hoisted(() => ({
  onTaskCompleted: vi.fn(),
  disableMemoryRuntime: vi.fn(),
}));

vi.mock('../paths.js', () => ({
  getMemoryDir: () => state.memoryDir,
  getPublicStoreMarkerPath: () => `${state.memoryDir}/.public-store-v1`,
  getUsersDir: () => `${state.memoryDir}/users`,
  getTasksDir: () => `${state.memoryDir}/tasks`,
  getEntitiesDir: () => `${state.memoryDir}/entities`,
  isMemoryEnabled: () => !state.runtimeDisabled,
  disableMemoryRuntime,
  isAllowedUserId: () => true,
}));

vi.mock('../../system/event-bus.js', () => ({ onTaskCompleted }));
vi.mock('../lifecycle.js', () => ({
  handleTaskCompleted: vi.fn(),
  rescheduleTaskCompleted: vi.fn(),
}));
vi.mock('../pending-queue.js', () => ({ readPendingEntries: vi.fn().mockResolvedValue([]) }));
vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initMemory } from '../index.js';

describe('initMemory public-store compatibility gate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.runtimeDisabled = false;
    disableMemoryRuntime.mockImplementation(() => {
      state.runtimeDisabled = true;
    });
    tempDir = await mkdtemp(join(tmpdir(), 'archie-memory-init-'));
    state.memoryDir = join(tempDir, 'memory');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('marks an empty store and initializes the lifecycle', async () => {
    await initMemory();

    expect(existsSync(join(state.memoryDir, '.public-store-v1'))).toBe(true);
    expect(onTaskCompleted).toHaveBeenCalledOnce();
    expect(disableMemoryRuntime).not.toHaveBeenCalled();
  });

  it('refuses an unmarked store without moving or exposing legacy data', async () => {
    const legacy = join(state.memoryDir, 'summaries', 'task-private.md');
    await mkdir(join(state.memoryDir, 'summaries'), { recursive: true });
    await writeFile(legacy, 'private legacy summary', 'utf-8');

    await initMemory();

    expect(disableMemoryRuntime).toHaveBeenCalledWith(expect.stringContaining('no public-store marker'));
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(state.memoryDir, '.public-store-v1'))).toBe(false);
    expect(onTaskCompleted).not.toHaveBeenCalled();
  });

  it('degrades to disabled when the memory path cannot be initialized', async () => {
    await writeFile(state.memoryDir, 'not a directory', 'utf-8');

    await expect(initMemory()).resolves.toBeUndefined();

    expect(disableMemoryRuntime).toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
  });
});
