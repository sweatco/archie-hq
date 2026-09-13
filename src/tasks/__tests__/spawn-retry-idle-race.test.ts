/**
 * Regression test for recovery racing the spawn loop's fresh-session retry.
 *
 * Observed live (task-20260912-2035-5t7o36, a resume whose session file was
 * gone): the failed attempt's error result marked the agent inactive, which
 * armed the 3s idle check; the spawn loop then replayed the wake into a fresh
 * query, which takes longer than 3s to boot. The check found an agent that
 * looked stalled and nudged it — and the nudge landed on the dead attempt's
 * parked generator, which yielded into the finished query's closed transport,
 * making the SDK abort the AbortController the spawn shares across attempts.
 * The healthy retry was killed ('Claude Code process aborted by user'), and the
 * respawn that followed had its wake swallowed by the next dead generator: the
 * task sat in_progress with no reply for 20+ minutes.
 *
 * The fix is two statements in spawn.ts's session-recovery catch, replayed here
 * against the real queue/generator and the real idle check: detach the
 * abandoned generator's waiter, and mark the agent active for the duration of
 * the retry.
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
import { MessageQueue, createRecoverableInputGenerator } from '../../agents/message-queue.js';
import type { Task } from '../task.js';

const TASK_ID = 'task-20260912-2035-5t7o36';

/**
 * A task whose agent has a real queue, so a nudge goes where it really would.
 * `updateAgentState` mirrors the real one in the two respects this race turns
 * on: it flips `agent.session.active`, and going inactive arms the idle check.
 */
function fakeTask(queue: MessageQueue) {
  const task = {
    taskId: TASK_ID,
    isActive: true,
    completionIntent: false,
    recoveryAttempts: 0,
    nuclearRecoveryCycles: 0,
    agent: {
      isRunning: true,
      pendingTeardown: undefined,
      session: { active: false } as { active: boolean },
      backgroundTasks: new Set<string>(),
      queue,
    },
    updateAgentState: vi.fn((active: boolean) => {
      task.agent.session.active = active;
      if (!active) scheduleIdleCheck(task as unknown as Task);
    }),
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    postToUser: vi.fn(async (_message: string) => null),
  };
  return task;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the idle check during a fresh-session retry', () => {
  it('leaves the retry alone: no nudge, no stop, one running agent', async () => {
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);
    const task = fakeTask(queue);

    // Attempt 1 — the resume. The wake streams in, then the query dies with an
    // error result, which marks the agent inactive and arms the idle check.
    queue.addMessage('the follow-up the user sent');
    const abandoned = recoverable.generator();
    await abandoned.next();
    const parked = abandoned.next();
    task.updateAgentState(false);

    // The spawn loop's catch: detach the abandoned generator, replay the wake
    // with the reset notice, and hand the agent to the fresh attempt.
    queue.detachWaiters();
    recoverable.reset('SESSION RESET — notice body');
    task.updateAgentState(true);

    // Attempt 2 — the fresh session. It reads the replayed wake and is still
    // working when the check armed by attempt 1 fires.
    const retry = recoverable.generator();
    expect((await retry.next()).value?.message.content).toContain('the follow-up the user sent');
    const reading = retry.next();

    await vi.advanceTimersByTimeAsync(3000);

    expect(task.recoveryAttempts).toBe(0); // triggerRecovery never ran
    expect(task.stop).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled(); // no second PM spawned
    expect(queue.pendingCount()).toBe(0); // no nudge enqueued
    // Nothing was handed to either generator: the retry is still reading, and
    // the abandoned one stayed dead (reviving it is what aborted the retry).
    expect(await Promise.race([reading, Promise.resolve('still reading')])).toBe('still reading');
    expect(await Promise.race([parked, Promise.resolve('still parked')])).toBe('still parked');
  });

  it('still recovers a genuinely idle agent', async () => {
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);
    const task = fakeTask(queue);

    // A turn that ended without the PM reporting anything: the agent is idle,
    // its generator is reading, and no retry is in flight.
    const reading = recoverable.generator().next();
    task.updateAgentState(false);

    await vi.advanceTimersByTimeAsync(3000);

    expect(task.recoveryAttempts).toBe(1);
    expect((await reading).value?.message.content).toContain('RECOVERY');
    expect(task.agent.session.active).toBe(true); // re-marked active after the nudge
    expect(task.stop).not.toHaveBeenCalled();
  });
});
