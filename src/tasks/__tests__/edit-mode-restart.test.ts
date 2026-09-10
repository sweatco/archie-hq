/**
 * Regression test for handleEditModeApproval restarting the live agent.
 *
 * Edit mode only flips the sandbox at spawn time (editAllowed puts the clones
 * in allowWritePaths). A process that is already running keeps its read-only
 * mount and never re-reads the flag, so writes keep hitting a read-only
 * filesystem after approval (observed on task-20260625-1122-30wkzk). Approval
 * must tear the running agent down so the reactivation re-spawns it with a
 * writable checkout — resuming the same SDK session, so no context is lost.
 *
 * spawnAgent is mocked (no real SDK subprocess); fs writes are stubbed so the
 * synchronous flush and the finding append don't touch disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
}));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

import { Task, activeTasks } from '../task.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  pmDef: AgentDef,
) => Task;

const TASK_ID = 'task-20260625-1122-30wkzk-test';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
  };
}

const pmDef = () =>
  ({ id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' }) as AgentDef;

describe('handleEditModeApproval — restart for a writable mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockImplementation(async (agent: { handle?: unknown; session: { session_id?: string } }) => {
      agent.session.session_id ??= 'sess-1';
      agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort: vi.fn() };
    });
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('tears the running agent down and respawns it on the same session', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    // The agent is live before approval (the failure condition).
    await task.sendMessage('start work');
    const before = task.agent;
    expect(before?.isRunning).toBe(true);
    const abort = (before!.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    await task.handleEditModeApproval({ id: 'U1', name: 'Egor' });

    // Flag set + approver recorded.
    expect(task.metadata.edit_allowed).toBe(true);
    expect(task.metadata.edit_approved_by?.name).toBe('Egor');
    // The read-only process was torn down...
    expect(abort).toHaveBeenCalled();
    // ...and the reactivation spawned a fresh one that resumes the same session.
    expect(task.agent).toBeDefined();
    expect(task.agent).not.toBe(before);
    expect(task.agent!.session.session_id).toBe('sess-1');
  });

  it('is a no-op on the teardown when nothing is running yet', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());
    await task.handleEditModeApproval({ id: 'U1', name: 'Egor' });
    expect(task.metadata.edit_allowed).toBe(true);
    // The reactivation still spawns the agent; nothing crashed on the way.
    expect(task.agent).toBeDefined();
  });
});
