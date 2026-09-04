import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

const { classifyMock } = vi.hoisted(() => ({ classifyMock: vi.fn() }));
const { memoryReady } = vi.hoisted(() => ({ memoryReady: { value: true } }));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackMemoryScope: classifyMock,
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../memory/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/paths.js')>()),
  isMemoryReady: () => memoryReady.value,
}));
vi.mock('../../system/logger.js', () => ({ logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() } }));

import { Task } from '../task.js';
const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;

function task(channelId?: string): Task {
  return new TaskCtor('task-1', {
    task_id: 'task-1', task_owner: null, participants: [], channels: {}, default_channel: null,
    ...(channelId ? { memory_destination: { channel_id: channelId } } : {}),
    agent_sessions: {}, repositories: {}, memory_authors: {}, status: 'in_progress',
    created_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z',
  }, []);
}

describe('prepareMemoryDelivery', () => {
  beforeEach(() => {
    classifyMock.mockReset();
    memoryReady.value = true;
  });

  it('allows the exact destination when it is currently safe', async () => {
    classifyMock.mockResolvedValue({ kind: 'public' });
    await expect(task('C1').prepareMemoryDelivery('C1')).resolves.toEqual({ kind: 'public', channel_id: 'C1' });
  });

  it('rejects a different, missing, or unsafe destination', async () => {
    classifyMock.mockResolvedValue({ kind: 'public' });
    await expect(task('C1').prepareMemoryDelivery('C2')).rejects.toThrow(/different Slack destination/);
    await expect(task().prepareMemoryDelivery('C1')).rejects.toThrow(/different Slack destination/);
    classifyMock.mockResolvedValue({ kind: 'none' });
    await expect(task('C1').prepareMemoryDelivery('C1')).rejects.toThrow(/not currently safe/);
  });

  it('keeps exact-destination delivery working when memory is unavailable', async () => {
    memoryReady.value = false;

    await expect(task('C1').prepareMemoryDelivery('C1'))
      .resolves.toEqual({ kind: 'none', channel_id: 'C1' });
    expect(classifyMock).not.toHaveBeenCalled();
    await expect(task('C1').prepareMemoryDelivery('C2'))
      .rejects.toThrow(/different Slack destination/);
  });

  it('authorizes trigger delivery only for the same channel or DM partner', async () => {
    classifyMock.mockResolvedValue({ kind: 'public' });
    await expect(task('C1').prepareTriggerDelivery({
      type: 'channel', channel_id: 'C1', channel_name: 'one',
    })).resolves.toBeUndefined();
    await expect(task('C1').prepareTriggerDelivery({
      type: 'channel', channel_id: 'C2', channel_name: 'two',
    })).rejects.toThrow(/different Slack destination/);

    classifyMock.mockResolvedValue({ kind: 'user', user_id: 'U1' });
    await expect(task('D1').prepareTriggerDelivery({ type: 'user', user_id: 'U1' })).resolves.toBeUndefined();
    await expect(task('D1').prepareTriggerDelivery({ type: 'user', user_id: 'U2' }))
      .rejects.toThrow(/different Slack destination/);
  });
});
