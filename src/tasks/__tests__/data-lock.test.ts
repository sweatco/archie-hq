import { describe, expect, it, vi } from 'vitest';

const { appendSlackMessageMock } = vi.hoisted(() => ({ appendSlackMessageMock: vi.fn() }));

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendSlackMessage: appendSlackMessageMock, downloadMessageFiles: vi.fn() };
});

import { Task } from '../task.js';
import { withTaskDataLock } from '../data-lock.js';
import type { AgentDef } from '../../types/agent.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

const TASK_ID = 'task-20260820-1200-datalock';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function makeTask(): Task {
  const task = new TaskCtor(TASK_ID, {
    task_id: TASK_ID,
    visibility: 'public',
    task_owner: null,
    participants: [],
    channels: {
      'slack:C1:100.000': {
        type: 'slack',
        thread_id: '100.000',
        channel_id: 'C1',
        channel_name: 'ops',
        last_processed_ts: '100.000',
      },
    },
    default_channel: 'slack:C1:100.000',
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
  }, []);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = vi.fn();
  return task;
}

const thread: SlackThread = {
  threadId: '100.000',
  channel: { id: 'C1', name: 'ops' },
  shared: false,
  taskVisibility: 'public',
  currentMessageTs: '101.000',
  rootAuthorWasBot: false,
  messages: [{
    user: { id: 'U1', username: 'dev', realName: 'Dev', teamId: 'T_HOME' },
    ownText: 'hello',
    ts: '101.000',
  }],
};

describe('task data lock', () => {
  it('serializes append behind a held data lock — the snapshot pattern memory relies on', async () => {
    const order: string[] = [];
    appendSlackMessageMock.mockImplementation(async () => { order.push('append'); });
    const task = makeTask();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withTaskDataLock(TASK_ID, async () => {
      order.push('snapshot');
      await gate;
    });

    const appending = task.append(thread);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['snapshot']);

    release();
    await holder;
    await appending;
    expect(order).toEqual(['snapshot', 'append']);
  });
});
