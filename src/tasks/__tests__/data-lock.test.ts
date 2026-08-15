import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sessionsRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'archie-task-data-lock-'));
});

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/workdir.js')>()),
  SESSIONS_DIR: sessionsRoot,
}));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackIngestAuthor: (user: { teamId?: string; isBot?: boolean; isAppUser?: boolean }) => {
    if (!user.teamId) return 'unknown';
    if (user.isBot || user.isAppUser) return 'untrusted';
    return user.teamId === 'T_HOME' ? 'internal' : 'external';
  },
}));

import { withTaskDataLock } from '../data-lock.js';
import { Task, activeTasks } from '../task.js';
import { getKnowledgeLogPath, getMetadataPath } from '../persistence.js';
import type { AgentDef } from '../../types/agent.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

const TASK_ID = 'task-20260815-1200-datalock';
const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    visibility: 'public',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-08-15T12:00:00.000Z',
    updated_at: '2026-08-15T12:00:00.000Z',
  };
}

function thread(messages: SlackThread['messages']): SlackThread {
  return {
    threadId: '1.0',
    channel: { id: 'C_DATA', name: 'data' },
    shared: false,
    taskVisibility: 'public',
    currentMessageTs: messages.at(-1)?.ts ?? '1.0',
    rootAuthorWasBot: false,
    messages,
  };
}

const human = { id: 'U1', username: 'human', realName: 'Human', teamId: 'T_HOME' };

beforeEach(async () => {
  activeTasks.delete(TASK_ID);
  await rm(join(sessionsRoot, TASK_ID), { recursive: true, force: true });
  await mkdir(join(sessionsRoot, TASK_ID, 'shared'), { recursive: true });
  await writeFile(getMetadataPath(TASK_ID), JSON.stringify(metadata(), null, 2));
  await writeFile(getKnowledgeLogPath(TASK_ID), '');
});

afterAll(async () => {
  activeTasks.delete(TASK_ID);
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('task data lock', () => {
  it('keeps visibility and transcript snapshot reads ahead of a concurrent private append', async () => {
    let releaseSnapshot!: () => void;
    const snapshotPaused = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const state = { visibility: 'public', transcript: 'public message' };

    const snapshot = withTaskDataLock('task-race', async () => {
      const visibility = state.visibility;
      await snapshotPaused;
      return { visibility, transcript: state.transcript };
    });
    let appendFinished = false;
    const append = withTaskDataLock('task-race', async () => {
      state.visibility = 'private';
      state.transcript += '\nprivate message';
      appendFinished = true;
    });

    await Promise.resolve();
    expect(appendFinished).toBe(false);
    releaseSnapshot();
    await expect(snapshot).resolves.toEqual({ visibility: 'public', transcript: 'public message' });
    await append;
    expect(state).toEqual({ visibility: 'private', transcript: 'public message\nprivate message' });
  });

  it('reloads under the lock when two detached task instances append overlapping snapshots', async () => {
    const first = new TaskCtor(TASK_ID, metadata(), []);
    const second = new TaskCtor(TASK_ID, metadata(), []);
    const root = { user: human, text: 'root', ts: '1.0' };
    const reply = { user: human, text: 'reply', ts: '2.0' };
    const latest = { user: human, text: 'latest', ts: '3.0' };

    await Promise.all([
      first.append(thread([root, reply])),
      second.append(thread([root, reply, latest])),
    ]);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log.match(/msg:1\.0/g)).toHaveLength(1);
    expect(log.match(/msg:2\.0/g)).toHaveLength(1);
    expect(log.match(/msg:3\.0/g)).toHaveLength(1);

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '3.0' });
  });

  it('redacts a verified untrusted automation and advances to the following human message', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const automation = {
      user: {
        id: 'B_UNTRUSTED', username: 'integration', realName: 'Integration',
        teamId: 'T_HOME', isBot: true,
      },
      text: 'untrusted automation payload',
      ts: '1.0',
    };

    await expect(task.append(thread([
      automation,
      { user: human, text: 'human follow-up', ts: '2.0' },
    ]))).resolves.toBe(true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('[redacted: external participant in shared channel]');
    expect(log).not.toContain('untrusted automation payload');
    expect(log).toContain('human follow-up');

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '2.0' });
  });
});
