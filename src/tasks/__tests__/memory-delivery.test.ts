import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

let injectionEnabled = true;
const { classifyMock } = vi.hoisted(() => ({ classifyMock: vi.fn() }));

vi.mock('../../memory/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/paths.js')>()),
  isMemoryReady: () => true,
  isInjectionEnabled: () => injectionEnabled,
}));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackMemoryScope: classifyMock,
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn(),
  },
}));

import { Task } from '../task.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;

function taskWithPublicMemory(): Task {
  const task = new TaskCtor('task-1', {
    task_id: 'task-1',
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    memory_scope: { kind: 'public', channel_id: 'C07ORIGIN1' },
    memory_authors: {},
  } as unknown as TaskMetadata, []);
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
  return task;
}

describe('prepareMemoryDelivery', () => {
  beforeEach(() => {
    injectionEnabled = true;
    classifyMock.mockReset();
    classifyMock.mockResolvedValue({ kind: 'none' });
  });

  it('persists the fail-closed scope and blocks delivery after memory injection', async () => {
    const task = taskWithPublicMemory();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'internal' };

    await expect(task.prepareMemoryDelivery('C07OUTSIDE')).rejects.toThrow(/delivery blocked/);

    expect(task.metadata.memory_scope).toEqual({ kind: 'none' });
    expect(task.save).toHaveBeenCalledWith(true);
  });

  it('blocks an exposed task when a lookup failure classifies the destination as none', async () => {
    const task = taskWithPublicMemory();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'internal' };
    classifyMock.mockResolvedValueOnce({ kind: 'none' });

    await expect(task.prepareMemoryDelivery('C07UNAVAILABLE')).rejects.toThrow(/delivery blocked/);
    expect(task.metadata.memory_scope).toEqual({ kind: 'none' });
  });

  it('keeps ordinary cross-channel delivery available when prompt injection is off', async () => {
    injectionEnabled = false;
    const task = taskWithPublicMemory();

    await expect(task.prepareMemoryDelivery('C07OUTSIDE')).resolves.toEqual({ kind: 'none' });
  });

  it('blocks wider delivery after a tool read even when prompt injection is off', async () => {
    injectionEnabled = false;
    const task = taskWithPublicMemory();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'internal' };

    await expect(task.prepareMemoryDelivery('C07OUTSIDE')).rejects.toThrow(/delivery blocked/);
  });

  it('blocks an exposed private channel when that channel becomes public', async () => {
    const task = taskWithPublicMemory();
    task.metadata.memory_scope = { kind: 'channel', channel_id: 'C07ORIGIN1' };
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'channel', channel_id: 'C07ORIGIN1' };
    classifyMock.mockResolvedValue({ kind: 'public', channel_id: 'C07ORIGIN1' });

    await expect(task.prepareMemoryDelivery('C07ORIGIN1')).rejects.toThrow(/delivery blocked/);
  });

  it('keeps blocking retries after an incompatible delivery persisted scope none', async () => {
    const task = taskWithPublicMemory();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'internal' };

    await expect(task.prepareMemoryDelivery('C07OUTSIDE')).rejects.toThrow(/delivery blocked/);
    await expect(task.prepareMemoryDelivery('C07OUTSIDE')).rejects.toThrow(/delivery blocked/);
    expect(classifyMock).toHaveBeenCalledTimes(2);
  });
});

describe('reaction memory delivery gates', () => {
  beforeEach(() => {
    classifyMock.mockReset();
    classifyMock.mockResolvedValue({ kind: 'channel', channel_id: 'C07ORIGIN1' });
  });

  function taskWithReactionChannel(): Task {
    const task = taskWithPublicMemory();
    task.metadata.channels = {
      'slack:C07ORIGIN1:1.0': {
        type: 'slack', channel_id: 'C07ORIGIN1', channel_name: 'private',
        thread_id: '1.0', last_processed_ts: '1.0',
      },
    };
    task.metadata.default_channel = 'slack:C07ORIGIN1:1.0';
    task.metadata.memory_scope = { kind: 'channel', channel_id: 'C07ORIGIN1' };
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'channel', channel_id: 'C07ORIGIN1' };
    return task;
  }

  it.each(['reactToMessage', 'unreactFromMessage'] as const)('blocks %s when the live audience is incompatible', async (method) => {
    const task = taskWithReactionChannel();
    classifyMock.mockResolvedValue({ kind: 'public', channel_id: 'C07ORIGIN1' });

    await expect(task[method]('1.1', 'eyes')).rejects.toThrow(/delivery blocked/);
    expect(task.metadata.memory_scope).toEqual({ kind: 'channel', channel_id: 'C07ORIGIN1' });
  });

  it.each(['reactToMessage', 'unreactFromMessage'] as const)('fails closed through %s when classification fails', async (method) => {
    const task = taskWithReactionChannel();
    classifyMock.mockResolvedValue({ kind: 'none' });

    await expect(task[method]('1.1', 'eyes')).rejects.toThrow(/delivery blocked/);
    expect(task.metadata.memory_scope).toEqual({ kind: 'none' });
  });
});
