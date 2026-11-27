import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata, TaskStatus } from '../../types/task.js';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'archie-work-index-'));
  return { root, sessions: join(root, 'sessions') };
});

vi.mock('../../system/workdir.js', async (original) => ({
  ...(await original<typeof import('../../system/workdir.js')>()),
  WORKDIR: fixture.root,
  SESSIONS_DIR: fixture.sessions,
}));
vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

import { loadChannelStore } from '../../system/channel-store.js';
import { Task, activeTasks } from '../task.js';
import {
  WORK_INDEX_MAX_ROWS,
  loadWorkRows,
  rebuildWorkIndex,
  recordWorkRow,
  workRowFromMetadata,
} from '../work-index.js';

function thread(channelId: string, threadTs: string) {
  return {
    type: 'slack' as const,
    channel_id: channelId,
    thread_id: threadTs,
    channel_name: channelId.toLowerCase(),
    last_processed_ts: threadTs,
  };
}

/** A task living in one thread of `channelId`. */
function metadata(
  taskId: string,
  channelId: string,
  threadTs: string,
  over: Partial<TaskMetadata> = {},
): TaskMetadata {
  const key = `slack:${channelId}:${threadTs}`;
  return {
    task_id: taskId,
    channels: { [key]: thread(channelId, threadTs) },
    default_channel: key,
    memory_destination: { channel_id: channelId },
    agent_sessions: {},
    repositories: [],
    status: 'completed',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

async function writeTask(meta: TaskMetadata): Promise<void> {
  const dir = join(fixture.sessions, meta.task_id, 'shared');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
}

async function storedRows(channelId: string) {
  return (await loadChannelStore(channelId))?.work ?? [];
}

beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(fixture.sessions, { recursive: true });
});

afterEach(() => {
  activeTasks.clear();
});

afterAll(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe('workRowFromMetadata', () => {
  it('describes the task by its thread in its own destination', () => {
    const meta = metadata('task-a', 'C1', '100.1', {
      title: 'Fix the login flow',
      requested_by: { id: 'U1', name: 'Dana' },
      last_reply: 'Merged the fix.',
    });

    expect(workRowFromMetadata(meta)).toEqual({
      conversation: 'C1',
      row: {
        taskId: 'task-a',
        threadTs: '100.1',
        title: 'Fix the login flow',
        state: 'waiting',
        requestedBy: 'Dana',
        updatedAt: '2026-11-01T10:00:00.000Z',
        lastReply: 'Merged the fix.',
      },
    });
  });

  it.each<[TaskStatus, string]>([
    ['preparing', 'working'],
    ['in_progress', 'working'],
    ['completed', 'waiting'],
    ['stopped', 'stopped'],
  ])('maps status %s to state %s', (status, state) => {
    expect(workRowFromMetadata(metadata('task-a', 'C1', '100.1', { status }))?.row.state).toBe(
      state,
    );
  });

  it('gives no row to a task with no thread in its destination', () => {
    const homed = metadata('task-a', 'C1', '100.1', {
      channels: {},
      default_channel: null,
      home_channel: { channel_id: 'C1', channel_name: 'c1' },
    });
    const elsewhere = metadata('task-b', 'C2', '100.2', {
      memory_destination: { channel_id: 'C1' },
    });

    expect(workRowFromMetadata(homed)).toBeNull();
    expect(workRowFromMetadata(elsewhere)).toBeNull();
  });
});

describe('recordWorkRow', () => {
  it('writes only into the destination store and replaces the earlier row of the task', async () => {
    await recordWorkRow(metadata('task-a', 'C1', '100.1', { status: 'in_progress' }));
    await recordWorkRow(metadata('task-b', 'C2', '100.2'));
    await recordWorkRow(metadata('task-a', 'C1', '100.1', { last_reply: 'Done.' }));

    expect(await storedRows('C1')).toEqual([
      expect.objectContaining({ taskId: 'task-a', state: 'waiting', lastReply: 'Done.' }),
    ]);
    expect((await storedRows('C2')).map((row) => row.taskId)).toEqual(['task-b']);
  });

  it('keeps the newest rows up to the cap', async () => {
    for (let i = 0; i < WORK_INDEX_MAX_ROWS + 2; i += 1) {
      const minute = String(i).padStart(2, '0');
      await recordWorkRow(
        metadata(`task-${minute}`, 'C1', `100.${i}`, {
          updated_at: `2026-11-01T10:${minute}:00.000Z`,
        }),
      );
    }

    const rows = await storedRows('C1');
    expect(rows).toHaveLength(WORK_INDEX_MAX_ROWS);
    expect(rows[0]?.taskId).toBe(`task-${WORK_INDEX_MAX_ROWS + 1}`);
    expect(rows.map((row) => row.taskId)).not.toContain('task-00');
  });
});

describe('rebuildWorkIndex', () => {
  it('reproduces the stored index from task metadata', async () => {
    const tasks = [
      metadata('task-a', 'C1', '100.1', { title: 'First', last_reply: 'Done.' }),
      metadata('task-b', 'C1', '100.2', {
        status: 'in_progress',
        updated_at: '2026-11-02T10:00:00.000Z',
      }),
      metadata('task-c', 'C1', '100.3', {
        status: 'stopped',
        updated_at: '2026-11-03T10:00:00.000Z',
      }),
    ];
    for (const meta of tasks) {
      await writeTask(meta);
      await recordWorkRow(meta);
    }
    const stored = await storedRows('C1');

    expect(await rebuildWorkIndex('C1')).toEqual(stored);
    expect(stored.map((row) => row.taskId)).toEqual(['task-c', 'task-b', 'task-a']);
  });

  it('leaves out a task of another conversation that only names the channel', async () => {
    const other = metadata('task-x', 'C2', '200.1');
    other.channels['slack:C1:200.2'] = thread('C1', '200.2');
    await writeTask(other);
    await writeTask(metadata('task-a', 'C1', '100.1'));

    expect((await rebuildWorkIndex('C1')).map((row) => row.taskId)).toEqual(['task-a']);
  });

  it('reads a live task from memory, ahead of its copy on disk', async () => {
    await writeTask(metadata('task-a', 'C1', '100.1', { status: 'in_progress' }));
    const live = metadata('task-a', 'C1', '100.1', { status: 'in_progress', title: 'Live title' });
    activeTasks.set('task-a', { metadata: live } as Task);

    expect((await rebuildWorkIndex('C1'))[0]?.title).toBe('Live title');
  });
});

describe('loadWorkRows', () => {
  it('backfills a conversation once, then serves the stored index', async () => {
    await writeTask(metadata('task-a', 'C1', '100.1', { title: 'Before the index' }));

    expect((await loadWorkRows('C1')).map((row) => row.title)).toEqual(['Before the index']);

    await writeTask(metadata('task-a', 'C1', '100.1', { title: 'Changed on disk only' }));
    expect((await loadWorkRows('C1')).map((row) => row.title)).toEqual(['Before the index']);
  });
});

describe('a task keeps its row current', () => {
  const TASK_ID = 'task-20261101-1000-abc123';
  const PM_DEF = {
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: '',
    pluginName: 'core',
    visibility: 'global',
    isPm: true,
  } as AgentDef;
  const TaskCtor = Task as unknown as new (
    taskId: string,
    metadata: TaskMetadata,
    pmDef: AgentDef,
  ) => Task;
  const post = vi.fn().mockResolvedValue('100.9');

  async function row() {
    return (await storedRows('C1'))[0];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('writes it on activation, park, title and stop, with the last agent reply', async () => {
    const meta = metadata(TASK_ID, 'C1', '100.1', { status: 'in_progress' });
    await writeTask(meta);
    const task = new TaskCtor(TASK_ID, meta, PM_DEF);

    await task.sendMessage('Please fix the login flow.');
    expect(await row()).toMatchObject({ taskId: TASK_ID, threadTs: '100.1', state: 'working' });

    await task.setTitle('Fix the login flow');
    expect((await row())?.title).toBe('Fix the login flow');

    await task.postToUser(`Merged.\n\n${'x'.repeat(400)}`, 'pm-agent', undefined, post);
    await task.postToUser('The task hit its time limit.', undefined, undefined, post);
    await task.complete();
    const parked = await row();
    expect(parked?.state).toBe('waiting');
    expect(parked?.lastReply).toMatch(/^Merged\. x+…$/);
    expect(parked?.lastReply).toHaveLength(300);

    await task.sendMessage('One more thing.');
    expect((await row())?.state).toBe('working');

    await task.stop();
    expect((await row())?.state).toBe('stopped');
    expect(await storedRows('C1')).toHaveLength(1);
  });
});
