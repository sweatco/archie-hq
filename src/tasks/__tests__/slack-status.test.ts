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
  return new TaskCtor('t1', metadata, PM_DEF);
}

describe('the Slack working indicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is not shown again when a stopped task’s agent wakes', async () => {
    const task = newDmTask();
    const status = (task as unknown as { statusController: TaskStatusController }).statusController;
    status.clear();
    await vi.waitFor(() => expect(setSlackThreadStatus).toHaveBeenLastCalledWith(DM, THREAD, ''));

    status.setActive();
    status.note('running some checks');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setSlackThreadStatus).toHaveBeenCalledOnce();
    status.dispose();
  });
});
