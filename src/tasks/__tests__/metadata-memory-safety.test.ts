import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { AgentDef } from '../../types/agent.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-task-metadata-'));
});

let memoryReady = true;
const { classifyMock } = vi.hoisted(() => ({ classifyMock: vi.fn() }));

vi.mock('../../system/workdir.js', () => ({
  WORKDIR: SESSIONS_ROOT,
  SESSIONS_DIR: SESSIONS_ROOT,
  CACHES_DIR: join(SESSIONS_ROOT, 'caches'),
}));
vi.mock('../../memory/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/paths.js')>()),
  isMemoryReady: () => memoryReady,
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackMemoryScope: classifyMock,
  getBotUserId: () => 'U07ARCHIE1',
  isInternalMemoryUser: () => true,
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() },
}));

import { Task } from '../task.js';
import { getKnowledgeLogPath, getMetadataPath } from '../persistence.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;

function metadata(taskId: string): TaskMetadata {
  return {
    task_id: taskId,
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    memory_scope: { kind: 'unclassified' },
    memory_authors: {},
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
  };
}

function thread(ts: string): SlackThread {
  return {
    threadId: '1.0',
    channel: { id: 'C07PUBLIC1', name: 'general' },
    shared: false,
    currentMessageTs: ts,
    rootAuthorWasBot: false,
    messages: [{
      user: {
        id: 'U07PERSON1', username: 'person', realName: 'Person',
        isRestricted: false, isUltraRestricted: false, isBot: false, isAppUser: false,
      },
      ownText: `message ${ts}`,
      ts,
    }],
  };
}

async function seed(taskId: string, value: TaskMetadata): Promise<void> {
  await mkdir(dirname(getMetadataPath(taskId)), { recursive: true });
  await writeFile(getMetadataPath(taskId), JSON.stringify(value, null, 2));
  await writeFile(getKnowledgeLogPath(taskId), '');
}

describe('task metadata memory persistence', () => {
  beforeEach(async () => {
    await rm(SESSIONS_ROOT, { recursive: true, force: true });
    await mkdir(SESSIONS_ROOT, { recursive: true });
    memoryReady = true;
    classifyMock.mockReset();
    classifyMock.mockResolvedValue({ kind: 'public', channel_id: 'C07PUBLIC1' });
  });

  afterAll(async () => {
    await rm(SESSIONS_ROOT, { recursive: true, force: true });
  });

  it('keeps the narrowest scope when stale Task instances save concurrently', async () => {
    const taskId = 'task-20260831-0000-scope1';
    await seed(taskId, metadata(taskId));
    const publicTask = new TaskCtor(taskId, metadata(taskId), []);
    const noneTask = new TaskCtor(taskId, metadata(taskId), []);
    publicTask.metadata.memory_scope = { kind: 'public', channel_id: 'C07PUBLIC1' };
    noneTask.metadata.memory_scope = { kind: 'none' };

    await Promise.all([noneTask.save(true), publicTask.save(true)]);

    const persisted = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(persisted.memory_scope).toEqual({ kind: 'none' });
    expect((await readdir(dirname(getMetadataPath(taskId)))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('does not widen a persisted private exposure through a stale save', async () => {
    const taskId = 'task-20260831-0000-expose1';
    const initial = metadata(taskId);
    initial.memory_scope = { kind: 'channel', channel_id: 'C07PRIVATE1' };
    initial.memory_exposed = true;
    initial.memory_exposure_scope = { kind: 'channel', channel_id: 'C07PRIVATE1' };
    await seed(taskId, initial);
    const stale = metadata(taskId);
    stale.memory_scope = { kind: 'channel', channel_id: 'C07PRIVATE1' };
    stale.memory_exposed = true;
    stale.memory_exposure_scope = { kind: 'internal' };

    await new TaskCtor(taskId, stale, []).save(true);

    const persisted = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(persisted.memory_exposure_scope).toEqual({ kind: 'channel', channel_id: 'C07PRIVATE1' });
  });

  it('preserves persisted exposure fields when a stale writer never observed them', async () => {
    const taskId = 'task-20260831-0000-expose2';
    const exposed = metadata(taskId);
    exposed.memory_exposed = true;
    exposed.memory_exposure_scope = { kind: 'channel', channel_id: 'C07PRIVATE1' };
    await seed(taskId, exposed);

    await new TaskCtor(taskId, metadata(taskId), []).save(true);

    const persisted = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(persisted.memory_exposed).toBe(true);
    expect(persisted.memory_exposure_scope).toEqual({ kind: 'channel', channel_id: 'C07PRIVATE1' });
  });

  it('merges memory authors from stale writers under the metadata lock', async () => {
    const taskId = 'task-20260831-0000-authors1';
    await seed(taskId, metadata(taskId));
    const first = metadata(taskId);
    const second = metadata(taskId);
    first.memory_authors = { U07PERSON1: 'One' };
    second.memory_authors = { U07PERSON2: 'Two' };

    await Promise.all([
      new TaskCtor(taskId, first, []).save(true),
      new TaskCtor(taskId, second, []).save(true),
    ]);

    const persisted = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(persisted.memory_authors).toEqual({ U07PERSON1: 'One', U07PERSON2: 'Two' });
  });

  it('persists none before unready ingestion and cannot widen after restart', async () => {
    const taskId = 'task-20260831-0000-restart1';
    await seed(taskId, metadata(taskId));
    memoryReady = false;
    const firstProcess = new TaskCtor(taskId, metadata(taskId), []);

    await firstProcess.append(thread('1.0'));
    const afterFirstIngest = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(afterFirstIngest.memory_scope).toEqual({ kind: 'none' });

    memoryReady = true;
    const restarted = new TaskCtor(taskId, afterFirstIngest, []);
    await restarted.append(thread('2.0'));

    expect(restarted.metadata.memory_scope).toEqual({ kind: 'none' });
    const afterRestart = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(afterRestart.memory_scope).toEqual({ kind: 'none' });
  });
});
