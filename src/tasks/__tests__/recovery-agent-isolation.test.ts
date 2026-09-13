/**
 * Regression tests for startup recovery isolating failures.
 *
 * A task runs one agent, so recovery is one message per in_progress task. What
 * still has to hold is that a task whose recovery throws does not abort the
 * others: before the per-task try/catch, one failure (an orphaned git config
 * lock, an unreadable session) left every task after it silently un-recovered
 * and in_progress with no process behind it. (Observed on
 * task-20260804-1050-iat4s8.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
const { findTaskIdsByStatusMock, taskGetMock } = vi.hoisted(() => ({
  findTaskIdsByStatusMock: vi.fn(),
  taskGetMock: vi.fn(),
}));
vi.mock('../persistence.js', () => ({ findTaskIdsByStatus: findTaskIdsByStatusMock }));
vi.mock('../task.js', () => ({ Task: { get: taskGetMock } }));

import { recoverActiveTasks } from '../recovery.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';

/** A task stub whose `sendMessage` optionally fails. */
function fakeTask(taskId: string, fails = false) {
  const sendMessage = vi.fn(async () => {
    if (fails) throw new Error('could not lock config file .git/config: File exists');
  });
  return { taskId, metadata: { agent_sessions: {} }, sendMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recoverActiveTasks', () => {
  it('sends the recovery prompt to each in_progress task', async () => {
    const task = fakeTask('task-20260804-1050-iat4s8');
    findTaskIdsByStatusMock.mockResolvedValue([task.taskId]);
    taskGetMock.mockResolvedValue(task);

    await recoverActiveTasks();

    expect(task.sendMessage).toHaveBeenCalledTimes(1);
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.recovery);
  });

  it('recovers the tasks after a failing one instead of stopping at it', async () => {
    const first = fakeTask('task-20260804-1050-aaaaaa');
    const thrower = fakeTask('task-20260804-1050-bbbbbb', true);
    const last = fakeTask('task-20260804-1050-cccccc');
    findTaskIdsByStatusMock.mockResolvedValue([first, thrower, last].map((t) => t.taskId));
    taskGetMock.mockImplementation(async (id: string) =>
      [first, thrower, last].find((t) => t.taskId === id),
    );

    await recoverActiveTasks();

    // The incident's loss: the task after the thrower got nothing.
    expect(first.sendMessage).toHaveBeenCalledTimes(1);
    expect(thrower.sendMessage).toHaveBeenCalledTimes(1);
    expect(last.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is in progress', async () => {
    findTaskIdsByStatusMock.mockResolvedValue([]);

    await recoverActiveTasks();

    expect(taskGetMock).not.toHaveBeenCalled();
  });
});
