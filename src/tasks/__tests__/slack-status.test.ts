import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../connectors/slack/status.js', () => ({ setSlackThreadStatus: vi.fn() }));

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
const THREAD = '1750000000.000100';

function newTask(channelId: string, muted = false): Task {
  const key = `slack:${channelId}:${THREAD}`;
  const metadata = {
    task_id: 't1',
    channels: {
      [key]: {
        type: 'slack',
        thread_id: THREAD,
        channel_id: channelId,
        channel_name: 'thread',
        last_processed_ts: THREAD,
        muted,
      },
    },
    default_channel: key,
    memory_destination: { channel_id: channelId },
    agent_sessions: {},
    repositories: [],
  } as unknown as TaskMetadata;
  return new TaskCtor('t1', metadata, PM_DEF);
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

  it('is not shown again when a stopped task’s agent wakes', async () => {
    const task = newTask('D1');
    const status = statusOf(task);
    status.clear();
    await vi.waitFor(() => expect(setSlackThreadStatus).toHaveBeenLastCalledWith('D1', THREAD, ''));

    status.setActive();
    status.note('running some checks');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setSlackThreadStatus).toHaveBeenCalledOnce();
    status.dispose();
  });

  it('is not shown on a muted thread', async () => {
    const task = newTask('C1', true);
    task.isActive = true;
    const status = statusOf(task);
    status.note('running some checks');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setSlackThreadStatus).not.toHaveBeenCalled();
    status.dispose();
  });
});
