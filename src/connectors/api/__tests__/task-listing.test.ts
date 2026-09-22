/**
 * `GET /api/tasks` is a listing, not a pickup.
 *
 * It walks a page of session folders, which on prod is a fleet of thousands, and
 * a listing that reached for `Task.get` would migrate and stamp every row it
 * rendered — upgrading tasks nobody is running and logging a pre-v30 drop
 * warning for each. It reads raw metadata instead; these cases pin that, over a
 * real fixture sessions dir served by a real Express app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createRequire } from 'module';
import type { Server } from 'http';

const require = createRequire(import.meta.url);

vi.mock('../../../system/workdir.js', async () => {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = join(tmpdir(), `archie-api-listing-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { SESSIONS_DIR: dir, WORKDIR: tmpdir(), TRIGGERS_DIR: join(dir, 'triggers') };
});

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

vi.mock('../../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../slack/client.js', () => ({
  isExternalUser: () => false,
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

// A listing that constructs one of these is the bug. Nothing here should call it.
const { taskGetMock, migrateSpy } = vi.hoisted(() => ({ taskGetMock: vi.fn(), migrateSpy: vi.fn() }));
vi.mock('../../../tasks/task.js', () => ({
  Task: { get: taskGetMock, create: vi.fn() },
  activeTasks: new Map(),
  migrateRepositoriesShape: migrateSpy,
  readRepositories: (m: { repositories?: unknown }) =>
    Array.isArray(m.repositories) ? m.repositories : [],
}));

import { mountApiRoutes } from '../routes.js';
import { logger } from '../../../system/logger.js';
import { SESSIONS_DIR } from '../../../system/workdir.js';

const express = require('express');

const LEGACY = 'task-20260301-0900-legacy';

/** A task folder as the pre-flattening engine left it: no stamp, pre-v30 repos map. */
async function writeLegacyTask(taskId: string, status: string): Promise<void> {
  const dir = join(SESSIONS_DIR, taskId, 'shared');
  await mkdir(dir, { recursive: true });
  const metadata = {
    task_id: taskId,
    channels: { 'slack:C1:111.0': { type: 'slack', channel_id: 'C1', channel_name: 'bugs', thread_id: '111.0' } },
    default_channel: 'slack:C1:111.0',
    agent_sessions: {},
    repositories: { backend: { path: '/repos/backend' }, mobile: { path: '/repos/mobile' } },
    status,
    title: 'a task from the old engine',
    created_at: '2026-03-01T09:00:00.000Z',
    updated_at: '2026-03-01T09:00:00.000Z',
  };
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
}

let server: Server;
let baseUrl: string;

describe('GET /api/tasks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await rm(SESSIONS_DIR, { recursive: true, force: true });
    await mkdir(SESSIONS_DIR, { recursive: true });

    const app = express();
    mountApiRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists legacy tasks without migrating, stamping or logging about them', async () => {
    await writeLegacyTask(LEGACY, 'completed');
    await writeLegacyTask('task-20260301-0901-legacy2', 'stopped');
    const before = await readFile(join(SESSIONS_DIR, LEGACY, 'shared', 'metadata.json'), 'utf-8');

    const res = await fetch(`${baseUrl}/api/tasks`);
    const body = (await res.json()) as { tasks: Array<Record<string, unknown>>; total: number };

    // The rows are unchanged by any of this — same fields, newest first.
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.tasks.map((t) => t.task_id)).toEqual(['task-20260301-0901-legacy2', LEGACY]);
    expect(body.tasks[1]).toMatchObject({
      task_id: LEGACY,
      status: 'completed',
      title: 'a task from the old engine',
      channel_name: 'bugs',
    });

    // No Task constructed, so no migration ran and nothing was logged about a
    // task the operator merely listed.
    expect(taskGetMock).not.toHaveBeenCalled();
    expect(migrateSpy).not.toHaveBeenCalled();
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[1]));
    expect(warned.filter((line) => line.includes('[migrate]'))).toEqual([]);

    // And the folder is byte-identical: a read must never upgrade one.
    expect(await readFile(join(SESSIONS_DIR, LEGACY, 'shared', 'metadata.json'), 'utf-8')).toBe(before);
  });
});
