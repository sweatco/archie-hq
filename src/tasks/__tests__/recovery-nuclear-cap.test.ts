/**
 * Regression tests for the nuclear-recovery cap.
 *
 * Nuclear recovery stops the task and resumes it from disk, which leaves the
 * task active again. A PM that keeps going idle without reporting completion
 * therefore looped stop→resume indefinitely — eight cycles in six minutes,
 * bounded only by the wall-clock cap (observed live). Past
 * MAX_NUCLEAR_RECOVERY_CYCLES the task must be paused and handed back to the
 * user instead of respawned.
 *
 * The reload is modelled faithfully in one respect that is load-bearing: the
 * respawn re-activates the task, and `Task.activate()` zeroes
 * `nuclearRecoveryCycles`. The fake `sendMessage` below does the same, so the
 * cycle count only survives if `triggerRecovery` re-applies it afterwards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
const { findTasksByStatusMock, taskGetMock } = vi.hoisted(() => ({
  findTasksByStatusMock: vi.fn(),
  taskGetMock: vi.fn(),
}));
vi.mock('../persistence.js', () => ({ findTasksByStatus: findTasksByStatusMock }));
vi.mock('../task.js', () => ({ Task: { get: taskGetMock } }));

import { scheduleIdleCheck } from '../recovery.js';
import { logger } from '../../system/logger.js';
import type { Task } from '../task.js';

const TASK_ID = 'task-20260910-1200-stalls';

/** A task that is quiescent-but-unparked, i.e. `idleDecision` says 'recover'. */
function fakeStalledTask() {
  const task = {
    taskId: TASK_ID,
    isActive: true,
    completionIntent: false,
    recoveryAttempts: 0,
    nuclearRecoveryCycles: 0,
    agent: {
      isRunning: true,
      pendingTeardown: undefined,
      session: { active: false },
      backgroundTasks: new Set<string>(),
      queue: { addMessage: vi.fn() },
    },
    updateAgentState: vi.fn(),
    // Stands in for the respawn: the real one re-activates the reloaded task,
    // and activate() zeroes the nuclear budget.
    sendMessage: vi.fn(async () => {
      task.nuclearRecoveryCycles = 0;
    }),
    stop: vi.fn(async () => {}),
    postToUser: vi.fn(async (_message: string) => null),
  };
  return task;
}

type StalledTask = ReturnType<typeof fakeStalledTask>;

/** Drive one idle check that lands on the nuclear branch (attempts already at 2). */
async function runNuclearCycle(task: StalledTask): Promise<void> {
  task.recoveryAttempts = 2; // the two reinforcement nudges already happened
  scheduleIdleCheck(task as unknown as Task);
  await vi.advanceTimersByTimeAsync(3000);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nuclear recovery cap', () => {
  it('respawns for the first three cycles, counting them across the reload', async () => {
    const task = fakeStalledTask();
    taskGetMock.mockResolvedValue(task);

    for (let i = 1; i <= 3; i++) {
      await runNuclearCycle(task);
      expect(task.nuclearRecoveryCycles).toBe(i);
    }

    expect(task.sendMessage).toHaveBeenCalledTimes(3);
    expect(task.postToUser).not.toHaveBeenCalled();
  });

  it('pauses instead of respawning on the fourth cycle, notifying the user once', async () => {
    const task = fakeStalledTask();
    taskGetMock.mockResolvedValue(task);

    for (let i = 0; i < 3; i++) await runNuclearCycle(task);
    expect(task.sendMessage).toHaveBeenCalledTimes(3);

    await runNuclearCycle(task);

    // The loop's signature: a fourth respawn. It must not happen.
    expect(task.sendMessage).toHaveBeenCalledTimes(3);
    expect(taskGetMock).toHaveBeenCalledTimes(3);
    // Stopped and handed back to the user, exactly once.
    expect(task.stop).toHaveBeenCalledTimes(4);
    expect(task.postToUser).toHaveBeenCalledTimes(1);
    expect(task.postToUser.mock.calls[0][0]).toMatch(/paused this task/i);
    const pauseLog = vi.mocked(logger.warn).mock.calls.find(([, msg]) =>
      String(msg).includes('pausing instead of respawning'),
    );
    expect(pauseLog?.[1]).toContain(TASK_ID);
    expect(pauseLog?.[1]).toContain('cycle 4');
  });

  it('keeps the task paused: no further recovery once it is inactive', async () => {
    const task = fakeStalledTask();
    taskGetMock.mockResolvedValue(task);

    for (let i = 0; i < 4; i++) await runNuclearCycle(task);
    task.isActive = false; // what stop() leaves behind

    await runNuclearCycle(task);

    expect(task.sendMessage).toHaveBeenCalledTimes(3);
    expect(task.postToUser).toHaveBeenCalledTimes(1);
  });
});
