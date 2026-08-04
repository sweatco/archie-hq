/**
 * Regression tests for startup recovery isolating per-agent spawn failures.
 *
 * `recoverTaskAgents` re-sends the recovery prompt to each previously-active
 * agent in one `for await` loop. With no try/catch inside it, the first failing
 * spawn aborted the loop: every agent after it was silently never messaged, and
 * since earlier agents had already incremented the counter, the "nothing came
 * back, wake PM" fallback didn't fire either. (Observed on
 * task-20260804-1050-iat4s8: mobile-agent recovered, backend-agent threw on an
 * orphaned git config lock, release-manager-agent was next and got nothing.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
const { findTasksByStatusMock, taskGetMock } = vi.hoisted(() => ({
  findTasksByStatusMock: vi.fn(),
  taskGetMock: vi.fn(),
}));
vi.mock('../persistence.js', () => ({ findTasksByStatus: findTasksByStatusMock }));
vi.mock('../task.js', () => ({ Task: { get: taskGetMock } }));

import { recoverActiveTasks } from '../recovery.js';

const TASK_ID = 'task-20260804-1050-iat4s8';

/** A task stub whose `sendMessage` fails for the named agents. */
function taskWithAgents(activeAgents: string[], failing: string[] = []) {
  const sendMessage = vi.fn(async (_prompt: string, agentName: string) => {
    if (failing.includes(agentName)) throw new Error('could not lock config file .git/config: File exists');
  });
  return {
    taskId: TASK_ID,
    metadata: {
      agent_sessions: Object.fromEntries(activeAgents.map((name) => [name, { active: true }])),
    },
    sendMessage,
  };
}

/** Agent names passed to sendMessage, in call order. */
function messaged(task: { sendMessage: ReturnType<typeof vi.fn> }): string[] {
  return task.sendMessage.mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  findTasksByStatusMock.mockResolvedValue([{ task_id: TASK_ID }]);
});

describe('recoverActiveTasks', () => {
  it('recovers the agents after a failing one instead of stopping at it', async () => {
    const task = taskWithAgents(
      ['mobile-agent', 'backend-agent', 'release-manager-agent'],
      ['backend-agent']
    );
    taskGetMock.mockResolvedValue(task);

    await recoverActiveTasks();

    // The incident's loss: release-manager-agent came after the thrower.
    expect(messaged(task)).toEqual(['mobile-agent', 'backend-agent', 'release-manager-agent']);
    expect(messaged(task)).not.toContain('pm-agent');
  });

  it('falls back to PM when every active agent fails to spawn', async () => {
    const task = taskWithAgents(['mobile-agent', 'backend-agent'], ['mobile-agent', 'backend-agent']);
    taskGetMock.mockResolvedValue(task);

    await recoverActiveTasks();

    // Otherwise the task is left in_progress with no process behind it.
    expect(messaged(task)).toEqual(['mobile-agent', 'backend-agent', 'pm-agent']);
  });

  it('still falls back to PM when metadata lists no active agent', async () => {
    const task = taskWithAgents([]);
    taskGetMock.mockResolvedValue(task);

    await recoverActiveTasks();

    expect(messaged(task)).toEqual(['pm-agent']);
  });
});
