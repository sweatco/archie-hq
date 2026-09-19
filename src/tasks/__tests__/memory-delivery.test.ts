import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

const { classifyMock, getChannelInfoMock } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
  getChannelInfoMock: vi.fn(),
}));
const { memoryReady } = vi.hoisted(() => ({ memoryReady: { value: true } }));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackMemoryScope: classifyMock,
  getChannelInfo: getChannelInfoMock,
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../memory/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/paths.js')>()),
  isMemoryReady: () => memoryReady.value,
}));
vi.mock('../../system/logger.js', () => ({ logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() } }));

import { Task } from '../task.js';
import { authorizeTaskMemory } from '../../memory/tools.js';
const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;
const PM_DEF = {
  id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'core', visibility: 'global', isPm: true,
} as AgentDef;

function task(channelId?: string): Task {
  return new TaskCtor('task-1', {
    task_id: 'task-1', channels: {}, default_channel: null,
    ...(channelId ? { memory_destination: { channel_id: channelId } } : {}),
    agent_sessions: {}, repositories: [], memory_authors: {}, status: 'in_progress',
    created_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z',
  }, PM_DEF);
}

describe('prepareMemoryDelivery', () => {
  beforeEach(() => {
    classifyMock.mockReset();
    getChannelInfoMock.mockReset();
    memoryReady.value = true;
  });

  it.each([
    ['public', { kind: 'public' }],
    ['denied', { kind: 'none' }],
    ['classification failure', new Error('lookup failed')],
  ])('allows the exact destination without checking %s memory authorization', async (_label, result) => {
    if (result instanceof Error) classifyMock.mockRejectedValue(result);
    else classifyMock.mockResolvedValue(result);

    await expect(task('C1').prepareMemoryDelivery('C1')).resolves.toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects different and missing destinations when memory readiness is %s', async (ready) => {
    memoryReady.value = ready;
    await expect(task('C1').prepareMemoryDelivery('C2')).rejects.toThrow(/different Slack destination/);
    await expect(task().prepareMemoryDelivery('C1')).rejects.toThrow(/different Slack destination/);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('keeps exact-destination delivery working when memory is unavailable', async () => {
    memoryReady.value = false;

    await expect(task('C1').prepareMemoryDelivery('C1')).resolves.toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('denies new memory after an audience change without blocking same-destination delivery', async () => {
    const value = task('C1');
    classifyMock.mockResolvedValueOnce({ kind: 'public' });
    await expect(authorizeTaskMemory(value)).resolves.toMatchObject({ allowPublic: true });
    classifyMock.mockResolvedValueOnce({ kind: 'none' });
    await expect(authorizeTaskMemory(value)).resolves.toBeNull();

    classifyMock.mockClear();
    await expect(value.prepareMemoryDelivery('C1')).resolves.toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('authorizes channel trigger delivery only for the same destination', async () => {
    await expect(task('C1').prepareTriggerDelivery({
      type: 'channel', channel_id: 'C1', channel_name: 'one',
    })).resolves.toBeUndefined();
    await expect(task('C1').prepareTriggerDelivery({
      type: 'channel', channel_id: 'C2', channel_name: 'two',
    })).rejects.toThrow(/different Slack destination/);
    expect(classifyMock).not.toHaveBeenCalled();
    expect(getChannelInfoMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('authorizes an exact DM trigger recipient when memory readiness is %s', async (ready) => {
    memoryReady.value = ready;
    getChannelInfoMock.mockResolvedValue({ id: 'D1', name: 'DM', isPrivate: true, isIm: true, imUserId: 'U1' });
    await expect(task('D1').prepareTriggerDelivery({ type: 'user', user_id: 'U1' })).resolves.toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong user', { id: 'D1', name: 'DM', isPrivate: true, isIm: true, imUserId: 'U2' }],
    ['non-DM', { id: 'D1', name: 'channel', isPrivate: false, isIm: false }],
    ['missing partner', { id: 'D1', name: 'DM', isPrivate: true, isIm: true }],
    ['failed resolution fallback', { id: 'D1', name: 'D1', isPrivate: false, isIm: false }],
  ])('rejects a user trigger for a %s destination resolution', async (_label, channelInfo) => {
    getChannelInfoMock.mockResolvedValue(channelInfo);
    await expect(task('D1').prepareTriggerDelivery({ type: 'user', user_id: 'U1' }))
      .rejects.toThrow(/different Slack destination/);
    expect(classifyMock).not.toHaveBeenCalled();
  });
});
