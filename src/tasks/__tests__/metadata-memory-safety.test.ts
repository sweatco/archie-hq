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
    classifyMock.mockResolvedValue({ kind: 'public' });
  });

  afterAll(async () => {
    await rm(SESSIONS_ROOT, { recursive: true, force: true });
  });

  it('keeps the immutable destination when stale Task instances save concurrently', async () => {
    const taskId = 'task-20260831-0000-scope1';
    await seed(taskId, metadata(taskId));
    const publicTask = new TaskCtor(taskId, metadata(taskId), []);
    const noneTask = new TaskCtor(taskId, metadata(taskId), []);
    publicTask.metadata.memory_destination = { channel_id: 'C07PUBLIC1' };
    noneTask.metadata.memory_destination = { channel_id: 'C07PUBLIC1' };

    await Promise.all([noneTask.save(true), publicTask.save(true)]);

    const persisted = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(persisted.memory_destination).toEqual({ channel_id: 'C07PUBLIC1' });
    expect((await readdir(dirname(getMetadataPath(taskId)))).filter((name) => name.includes('.tmp'))).toEqual([]);
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

  it('persists the inbound destination and keeps it after restart', async () => {
    const taskId = 'task-20260831-0000-restart1';
    await seed(taskId, metadata(taskId));
    memoryReady = false;
    const firstProcess = new TaskCtor(taskId, metadata(taskId), []);

    await firstProcess.append(thread('1.0'));
    const afterFirstIngest = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(afterFirstIngest.memory_destination).toEqual({ channel_id: 'C07PUBLIC1' });

    memoryReady = true;
    const restarted = new TaskCtor(taskId, afterFirstIngest, []);
    await restarted.append(thread('2.0'));

    expect(restarted.metadata.memory_destination).toEqual({ channel_id: 'C07PUBLIC1' });
    const afterRestart = JSON.parse(await readFile(getMetadataPath(taskId), 'utf-8')) as TaskMetadata;
    expect(afterRestart.memory_destination).toEqual({ channel_id: 'C07PUBLIC1' });
  });
});
