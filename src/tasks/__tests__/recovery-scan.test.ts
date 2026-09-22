/**
 * The startup scan reads, it does not pick up.
 *
 * Observed on prod: a boot walked every session folder through `Task.get`,
 * running `migrateRepositoriesShape` and `stampRuntimeVersion` in memory for
 * each and logging a pre-v30 drop warning for tasks the process was never going
 * to run. A scan has no business migrating anything — migration belongs to the
 * pickup, which is `Task.get` on an in_progress task plus the write `activate()`
 * does. These cases run the real scan over a real fixture sessions dir (grep and
 * all), with only `Task` stubbed, so what is asserted is which folders reach a
 * Task at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';

vi.mock('../../system/workdir.js', async () => {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = join(tmpdir(), `archie-recovery-scan-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { SESSIONS_DIR: dir, WORKDIR: tmpdir() };
});

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: () => false,
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn(), onEvent: vi.fn() }));

// `Task` is the thing under observation: every construction of one is a pickup,
// and a pickup is what runs the load-path migrations. `migrateRepositoriesShape`
// is exported as a spy so a scan that reached for it would be visible here.
const { taskGetMock, migrateSpy } = vi.hoisted(() => ({
  taskGetMock: vi.fn(),
  migrateSpy: vi.fn(),
}));
vi.mock('../task.js', () => ({
  Task: { get: taskGetMock },
  activeTasks: new Map(),
  migrateRepositoriesShape: migrateSpy,
  readRepositories: (m: { repositories?: unknown }) =>
    Array.isArray(m.repositories) ? m.repositories : [],
}));

import { recoverActiveTasks } from '../recovery.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { SESSIONS_DIR } from '../../system/workdir.js';

const IN_PROGRESS = 'task-20260301-0900-legacy';

/**
 * A task folder as the pre-flattening engine left it: no `runtime_version`, and
 * `repositories` still the pre-v30 map keyed by short repo name. Loading one of
 * these through `Task.get` is what logs the drop warnings.
 */
async function writeLegacyTask(taskId: string, status: string): Promise<void> {
  const dir = join(SESSIONS_DIR, taskId, 'shared');
  await mkdir(dir, { recursive: true });
  const metadata = {
    task_id: taskId,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: { backend: { path: '/repos/backend' }, mobile: { path: '/repos/mobile' } },
    status,
    created_at: '2026-03-01T09:00:00.000Z',
    updated_at: '2026-03-01T09:00:00.000Z',
  };
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
}

function fakeTask(taskId: string) {
  return { taskId, metadata: { agent_sessions: {} }, sendMessage: vi.fn(async () => {}) };
}

describe('startup recovery scan', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await rm(SESSIONS_DIR, { recursive: true, force: true });
    await mkdir(SESSIONS_DIR, { recursive: true });
  });

  it('constructs a Task only for the in_progress task, and picks it up', async () => {
    await writeLegacyTask(IN_PROGRESS, 'in_progress');
    await writeLegacyTask('task-20260301-0901-done', 'completed');
    await writeLegacyTask('task-20260301-0902-halted', 'stopped');
    await writeLegacyTask('task-20260301-0903-done2', 'completed');

    const task = fakeTask(IN_PROGRESS);
    taskGetMock.mockResolvedValue(task);

    await recoverActiveTasks();

    // One folder of four reaches a Task — the other three were counted, not loaded.
    expect(taskGetMock).toHaveBeenCalledTimes(1);
    expect(taskGetMock).toHaveBeenCalledWith(IN_PROGRESS);
    // And the one that did is genuinely picked up, not merely read.
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.recovery);
  });

  it('migrates nothing while scanning — no drop warning for a task it is not picking up', async () => {
    await writeLegacyTask(IN_PROGRESS, 'in_progress');
    await writeLegacyTask('task-20260301-0901-done', 'completed');
    taskGetMock.mockResolvedValue(fakeTask(IN_PROGRESS));

    await recoverActiveTasks();

    // The prod symptom: 44 `[migrate]` warn lines at boot, for tasks nobody ran.
    expect(migrateSpy).not.toHaveBeenCalled();
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[1]));
    expect(warned.filter((line) => line.includes('[migrate]'))).toEqual([]);
  });

  it('leaves the folders it scanned byte-identical on disk', async () => {
    const untouched = 'task-20260301-0901-done';
    await writeLegacyTask(IN_PROGRESS, 'in_progress');
    await writeLegacyTask(untouched, 'completed');
    const before = await readFile(join(SESSIONS_DIR, untouched, 'shared', 'metadata.json'), 'utf-8');
    taskGetMock.mockResolvedValue(fakeTask(IN_PROGRESS));

    await recoverActiveTasks();

    // A rollback to the previous engine has to stay non-destructive for a task
    // this build never ran.
    expect(await readFile(join(SESSIONS_DIR, untouched, 'shared', 'metadata.json'), 'utf-8')).toBe(before);
  });

  it('loads nothing at all when no task is in progress', async () => {
    await writeLegacyTask('task-20260301-0901-done', 'completed');
    await writeLegacyTask('task-20260301-0902-halted', 'stopped');

    await recoverActiveTasks();

    expect(taskGetMock).not.toHaveBeenCalled();
  });
});
