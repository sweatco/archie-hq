import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

const { getChannelInfoMock, getUserInfoMock, isInternalMock } = vi.hoisted(() => ({
  getChannelInfoMock: vi.fn(),
  getUserInfoMock: vi.fn(),
  isInternalMock: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  getChannelInfo: getChannelInfoMock,
  getUserInfo: getUserInfoMock,
  isInternalMemoryUser: isInternalMock,
}));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../system/logger.js', () => ({ logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() } }));

import { Task } from '../task.js';
const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;
const PM_DEF = {
  id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'core', visibility: 'global', isPm: true,
} as AgentDef;

function task(channelId?: string): Task {
  return new TaskCtor('task-1', {
    task_id: 'task-1', channels: {}, default_channel: null,
    ...(channelId ? { memory_destination: { channel_id: channelId } } : {}),
    agent_sessions: {}, repositories: [], memory_authors: {}, status: 'in_progress',
    created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z',
  }, PM_DEF);
}

describe('getDmOwner', () => {
  beforeEach(() => {
    getChannelInfoMock.mockReset();
    getUserInfoMock.mockReset();
    isInternalMock.mockReset();
    getChannelInfoMock.mockResolvedValue({ id: 'D0OWNERDM', name: 'U0OWNER1', isPrivate: true, isIm: true, imUserId: 'U0OWNER1' });
    getUserInfoMock.mockResolvedValue({ name: 'owner', realName: 'Owner' });
    isInternalMock.mockReturnValue(true);
  });

  it('names the internal person on the other end of a DM destination', async () => {
    expect(await task('D0OWNERDM').getDmOwner()).toBe('U0OWNER1');
    expect(getChannelInfoMock).toHaveBeenCalledWith('D0OWNERDM');
    expect(getUserInfoMock).toHaveBeenCalledWith('U0OWNER1');
  });

  it.each([
    ['a channel', 'C0CHANNEL1'],
    ['a group', 'G0GROUP001'],
    ['no destination', undefined],
  ])('is null for %s without asking Slack', async (_label, channelId) => {
    expect(await task(channelId).getDmOwner()).toBeNull();
    expect(getChannelInfoMock).not.toHaveBeenCalled();
    expect(getUserInfoMock).not.toHaveBeenCalled();
  });

  it('is null when the destination is not a 1:1 DM', async () => {
    getChannelInfoMock.mockResolvedValue({ id: 'D0OWNERDM', name: 'D0OWNERDM', isPrivate: true, isIm: false, imUserId: 'U0OWNER1' });
    expect(await task('D0OWNERDM').getDmOwner()).toBeNull();
    expect(getUserInfoMock).not.toHaveBeenCalled();
  });

  it('is null when the DM names no person', async () => {
    getChannelInfoMock.mockResolvedValue({ id: 'D0OWNERDM', name: 'D0OWNERDM', isPrivate: true, isIm: true });
    expect(await task('D0OWNERDM').getDmOwner()).toBeNull();
    expect(getUserInfoMock).not.toHaveBeenCalled();
  });

  it('is null when the person is not internal', async () => {
    isInternalMock.mockReturnValue(false);
    expect(await task('D0OWNERDM').getDmOwner()).toBeNull();
  });

  it('is null when the person cannot be looked up', async () => {
    getUserInfoMock.mockRejectedValue(new Error('ratelimited'));
    expect(await task('D0OWNERDM').getDmOwner()).toBeNull();
  });
});
