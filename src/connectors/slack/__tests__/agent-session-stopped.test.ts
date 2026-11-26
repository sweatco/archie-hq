import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  getUserInfo: vi.fn(),
  isExternalUser: vi.fn((u: { isRestricted?: boolean }) => Boolean(u?.isRestricted)),
  getBotUserId: vi.fn(),
  getBotId: vi.fn(),
  getSlackClient: vi.fn(),
}));
vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: vi.fn() }, activeTasks: new Map() }));
vi.mock('../../../tasks/persistence.js', () => ({ findTaskByThread: vi.fn() }));
vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { handleAgentSessionStopped } from '../events.js';
import { Task } from '../../../tasks/task.js';
import { getUserInfo } from '../client.js';
import { findTaskByThread } from '../../../tasks/persistence.js';

const STOP = { channel: 'D1', thread_ts: '1750000000.000100', user: 'U1' };
const stop = vi.fn();

function taskThatIs(running: boolean): Task {
  return { isActive: running, stop } as unknown as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findTaskByThread).mockResolvedValue('t1');
  vi.mocked(Task.get).mockResolvedValue(taskThatIs(true));
  vi.mocked(getUserInfo).mockResolvedValue({ name: 'dana', realName: 'Dana' } as never);
});

describe('handleAgentSessionStopped', () => {
  it("stops the thread's running task", async () => {
    await handleAgentSessionStopped(STOP);
    expect(findTaskByThread).toHaveBeenCalledWith(STOP.thread_ts);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('ignores a thread with no task', async () => {
    vi.mocked(findTaskByThread).mockResolvedValue(null);
    await handleAgentSessionStopped(STOP);
    expect(Task.get).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('ignores a task that is not running', async () => {
    vi.mocked(Task.get).mockResolvedValue(taskThatIs(false));
    await handleAgentSessionStopped(STOP);
    expect(stop).not.toHaveBeenCalled();
  });

  it('ignores a stop pressed by an external or guest user', async () => {
    vi.mocked(getUserInfo).mockResolvedValue({ name: 'guest', isRestricted: true } as never);
    await handleAgentSessionStopped(STOP);
    expect(stop).not.toHaveBeenCalled();
  });
});
