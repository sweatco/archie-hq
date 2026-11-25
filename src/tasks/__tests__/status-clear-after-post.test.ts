/**
 * Slack's Agent surface keeps a session working until the app ends it, so the
 * clear must reach it however the task ends. A posted reply does not end it: the
 * clear used to be skipped there, because posting made the controller assume
 * Slack had cleared it. And a stopped task's agent can wake once more (e.g. a
 * background shell finishing) and must not show the indicator again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    slack: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage: vi.fn().mockResolvedValue('1750000000.000200') };
});
vi.mock('../../connectors/slack/status.js', () => ({ setSlackThreadStatus: vi.fn() }));
vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendMessageToUser: vi.fn().mockResolvedValue(undefined) };
});

import { Task } from '../task.js';
import type { TaskStatusController } from '../status.js';
import { setSlackThreadStatus } from '../../connectors/slack/status.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  pmDef: AgentDef,
) => Task;
const PM_DEF = { id: 'pm-agent', key: 'pm', role: 'PM', isPm: true } as AgentDef;
const DM = 'D1';
const THREAD = '1750000000.000100';

function newDmTask(): Task {
  const key = `slack:${DM}:${THREAD}`;
  const metadata = {
    task_id: 't1',
    channels: {
      [key]: {
        type: 'slack',
        thread_id: THREAD,
        channel_id: DM,
        channel_name: 'DM',
        last_processed_ts: THREAD,
      },
    },
    default_channel: key,
    memory_destination: { channel_id: DM },
    agent_sessions: {},
    repositories: [],
  } as unknown as TaskMetadata;
  const task = new TaskCtor('t1', metadata, PM_DEF);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
  task.isActive = true;
  return task;
}

function statusOf(task: Task): TaskStatusController {
  return (task as unknown as { statusController: TaskStatusController }).statusController;
}

describe('the Slack working indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(setSlackThreadStatus).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('is cleared when the task winds down after posting its reply', async () => {
    const task = newDmTask();
    const status = statusOf(task);
    status.note('checking Jira');
    await vi.waitFor(() =>
      expect(setSlackThreadStatus).toHaveBeenLastCalledWith(DM, THREAD, 'is checking Jira…'),
    );

    await task.postToUser('Here is the answer.', 'pm-agent');
    task.suspendStatus();

    await vi.waitFor(() => expect(setSlackThreadStatus).toHaveBeenLastCalledWith(DM, THREAD, ''));
    status.dispose();
  });

  it('is not shown again when a stopped task’s agent wakes', async () => {
    const task = newDmTask();
    const status = statusOf(task);
    task.isActive = false;
    status.clear();
    await vi.waitFor(() => expect(setSlackThreadStatus).toHaveBeenLastCalledWith(DM, THREAD, ''));

    status.setActive();
    status.note('running some checks');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setSlackThreadStatus).toHaveBeenCalledOnce();
    status.dispose();
  });
});
