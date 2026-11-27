import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../connectors/slack/status.js', () => ({ setSlackThreadStatus: vi.fn() }));
vi.mock('../../connectors/slack/title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  getSlackClient: vi.fn(() => SLACK),
}));

import { Task } from '../task.js';
import type { TaskStatusController } from '../status.js';
import { setSlackThreadStatus } from '../../connectors/slack/status.js';
import { setAssistantThreadTitle } from '../../connectors/slack/title.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  pmDef: AgentDef,
) => Task;
const PM_DEF = { id: 'pm-agent', key: 'pm', role: 'PM', isPm: true } as AgentDef;
const THREAD = '1750000000.000100';
const SLACK = {};

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
    vi.mocked(setSlackThreadStatus).mockReset();
    vi.mocked(setAssistantThreadTitle).mockReset();
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

  describe('DM title', () => {
    const KEY = `slack:D1:${THREAD}`;

    async function pushStatus(task: Task, accepted: boolean, phrase = 'running some checks') {
      vi.mocked(setSlackThreadStatus).mockResolvedValueOnce(accepted);
      statusOf(task).note(phrase);
      await vi.advanceTimersByTimeAsync(1_000);
    }

    function activeDmTask(meta: Partial<TaskMetadata> = {}): Task {
      const task = newTask('D1');
      Object.assign(task.metadata, { title: 'Early title' }, meta);
      (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
      task.isActive = true;
      return task;
    }

    it('waits for the session, then is sent once and unmarked', async () => {
      vi.mocked(setAssistantThreadTitle).mockResolvedValue(true);
      const task = activeDmTask();
      await task.sendSlackTitle('D1', THREAD);
      expect(setAssistantThreadTitle).not.toHaveBeenCalled();
      expect(task.metadata.slack_title_pending).toBe(KEY);

      await pushStatus(task, true);
      expect(setAssistantThreadTitle).toHaveBeenCalledExactlyOnceWith(
        SLACK,
        'D1',
        THREAD,
        'Early title',
      );
      expect(task.metadata.slack_title_pending).toBeUndefined();

      await pushStatus(task, true, 'drafting changes');
      expect(setSlackThreadStatus).toHaveBeenCalledTimes(2);
      expect(setAssistantThreadTitle).toHaveBeenCalledOnce();
      statusOf(task).dispose();
    });

    it('is sent at once when the session exists', async () => {
      vi.mocked(setAssistantThreadTitle).mockResolvedValue(true);
      const task = activeDmTask();
      await pushStatus(task, true);
      await task.sendSlackTitle('D1', THREAD);
      expect(setAssistantThreadTitle).toHaveBeenCalledExactlyOnceWith(
        SLACK,
        'D1',
        THREAD,
        'Early title',
      );
      statusOf(task).dispose();
    });

    it('is not released by a failed status push', async () => {
      const task = activeDmTask();
      await task.sendSlackTitle('D1', THREAD);
      await pushStatus(task, false);
      expect(setAssistantThreadTitle).not.toHaveBeenCalled();
      statusOf(task).dispose();
    });

    it('is sent after a restart when still marked', async () => {
      vi.mocked(setAssistantThreadTitle).mockResolvedValue(true);
      const task = activeDmTask({ slack_title_pending: KEY });
      await pushStatus(task, true);
      expect(setAssistantThreadTitle).toHaveBeenCalledExactlyOnceWith(
        SLACK,
        'D1',
        THREAD,
        'Early title',
      );
      expect(task.metadata.slack_title_pending).toBeUndefined();
      statusOf(task).dispose();
    });

    it('is never sent for a title without the marker', async () => {
      const task = activeDmTask();
      await pushStatus(task, true);
      expect(setAssistantThreadTitle).not.toHaveBeenCalled();
      statusOf(task).dispose();
    });

    it('stays marked when the rename fails', async () => {
      vi.mocked(setAssistantThreadTitle).mockResolvedValue(false);
      const task = activeDmTask({ slack_title_pending: KEY });
      await pushStatus(task, true);
      await pushStatus(task, true, 'drafting changes');
      expect(setAssistantThreadTitle).toHaveBeenCalledOnce();
      expect(task.metadata.slack_title_pending).toBe(KEY);
      statusOf(task).dispose();
    });
  });
});
