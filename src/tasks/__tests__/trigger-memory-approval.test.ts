import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';
import type { Trigger } from '../../types/trigger.js';

const state = vi.hoisted(() => ({
  trigger: null as Trigger | null,
  enable: vi.fn(),
}));

vi.mock('../../system/trigger-store.js', () => ({
  loadTrigger: vi.fn(async () => state.trigger),
  enableProposedTrigger: state.enable,
  deleteTrigger: vi.fn(),
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../system/trigger-scheduler.js', () => ({
  indexTrigger: vi.fn(),
  announceTriggerChange: vi.fn(),
  MAX_TRIGGERS_PER_USER: 20,
  MAX_TRIGGERS_PER_CHANNEL: 20,
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence.js')>()),
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() },
}));

import { Task } from '../task.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;

function pendingTrigger(): Trigger {
  return {
    id: 'trg-20260831-0000-abc123',
    status: 'pending',
    created_by: 'U07PERSON1',
    created_at: '2026-08-31T00:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C07PRIVATE1', channel_name: 'private' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-09-01T00:00:00.000Z' }],
    action: { prompt: 'Use the task context.' },
  };
}

function task(): Task {
  const value = new TaskCtor('task-20260831-0000-approve1', {
    task_id: 'task-20260831-0000-approve1', task_owner: null, participants: [],
    channels: {}, default_channel: null, memory_destination: { channel_id: 'C07PRIVATE1' },
    agent_sessions: {}, repositories: {}, status: 'in_progress',
    pending_trigger_id: 'trg-20260831-0000-abc123',
    created_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z',
  }, []);
  vi.spyOn(value, 'prepareTriggerDelivery');
  return value;
}

describe('trigger approval destination check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.trigger = pendingTrigger();
    state.enable.mockResolvedValue(state.trigger);
  });

  it('keeps a pending trigger disabled when its live destination is unsafe', async () => {
    const value = task();
    vi.mocked(value.prepareTriggerDelivery).mockRejectedValue(new Error('delivery blocked'));

    await expect(value.handleTriggerApproval('U07APPROVER')).resolves.toBeNull();

    expect(value.prepareTriggerDelivery).toHaveBeenCalledWith(state.trigger!.binding);
    expect(state.enable).not.toHaveBeenCalled();
    expect(value.metadata.pending_trigger_id).toBe(state.trigger!.id);
  });
});
