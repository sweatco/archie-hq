/**
 * Task.fireReminder applies the re-arm on the CANONICAL instance. A reminder resolved through a
 * Task.get miss is a detached copy; if a Slack event activated the task meanwhile, re-arming the
 * copy would be overwritten by the live instance's next save, resurrecting the fired reminder.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

const { loadMetadataMock, persistMock } = vi.hoisted(() => ({ loadMetadataMock: vi.fn(), persistMock: vi.fn() }));
vi.mock('../persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence.js')>()),
  loadMetadata: loadMetadataMock,
  persistTaskMetadata: persistMock,
}));

import { Task, activeTasks } from '../task.js';
import { MessageQueue } from '../../agents/message-queue.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;
const TASK_ID = 'task-20261012-0000-firerem';
// Same instant as firing(), but with milliseconds — the stored form often omits them.
const DUE = { trigger_at: '2026-10-12T09:00:00.000Z', reason: 'r', cron: '0 * * * *', tz: 'UTC' };
const NEXT = { trigger_at: '2026-10-12T10:00:00.000Z', reason: 'r', cron: '0 * * * *', tz: 'UTC' };

function metadata(reminder?: TaskMetadata['reminder']): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    created_at: '2026-10-12T00:00:00.000Z',
    updated_at: '2026-10-12T00:00:00.000Z',
    ...(reminder ? { reminder } : {}),
  };
}

const pmDef = { id: 'pm-agent', key: 'pm', visibility: 'global', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' } as AgentDef;
const firing = () => ({ trigger_at: '2026-10-12T09:00:00Z', reason: 'r', cron: '0 * * * *', tz: 'UTC' });

describe('Task.fireReminder', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    loadMetadataMock.mockReset();
    persistMock.mockReset().mockResolvedValue(undefined);
    spawnMock.mockImplementation(async (agent: { handle?: unknown }) => {
      agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort: vi.fn() };
    });
    addSpy = vi.spyOn(MessageQueue.prototype, 'addMessage');
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
    addSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('re-arms the live instance when the task was activated after the scheduler resolved a copy', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    const live = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    await live.sendMessage('slack message');

    const fired = await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r');

    expect(fired).toBe(true);
    expect(live.metadata.reminder).toEqual(NEXT);
    expect(persistMock).toHaveBeenLastCalledWith(TASK_ID, live.metadata);
    expect(addSpy.mock.calls.map((c: unknown[]) => c[0])).toContain('[reminder] r');
  });

  it('does not fire when the live instance no longer holds that reminder (cancelled meanwhile)', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    const live = new TaskCtor(TASK_ID, metadata(), pmDef);
    await live.sendMessage('slack message');
    const beforeWake = vi.fn();

    const fired = await copy.fireReminder(DUE, NEXT, beforeWake, '[reminder] r');

    expect(fired).toBe(false);
    expect(beforeWake).not.toHaveBeenCalled();
    expect(live.metadata.reminder).toBeUndefined();
  });

  it('flushes the re-arm before the wake reaches the agent', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    loadMetadataMock.mockResolvedValue(metadata(firing()));
    const order: string[] = [];
    persistMock.mockImplementation(async () => { order.push('persist'); });
    addSpy.mockImplementation(() => { order.push('wake'); });

    await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r');

    expect(order.indexOf('persist')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('wake'));
  });

  it('does not fire a parked instance cancelled in memory before disk caught up', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(), pmDef);
    loadMetadataMock.mockResolvedValue(metadata(firing()));

    expect(await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not fire over a replacement for the same instant with a different schedule', async () => {
    const replaced = { ...firing(), cron: '0 10 * * *' };
    const live = new TaskCtor(TASK_ID, metadata(replaced), pmDef);
    await live.sendMessage('slack message');
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);

    expect(await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r')).toBe(false);
    expect(live.metadata.reminder).toEqual(replaced);
  });

  it('does not fire a parked task whose reminder was cancelled on disk meanwhile', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    loadMetadataMock.mockResolvedValue(metadata());

    const fired = await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r');

    expect(fired).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fires a parked task, matching the stored time even without milliseconds', async () => {
    const copy = new TaskCtor(TASK_ID, metadata(firing()), pmDef);
    loadMetadataMock.mockResolvedValue(metadata(firing()));

    const fired = await copy.fireReminder(DUE, NEXT, () => {}, '[reminder] r');

    expect(fired).toBe(true);
    expect(copy.metadata.reminder).toEqual(NEXT);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
