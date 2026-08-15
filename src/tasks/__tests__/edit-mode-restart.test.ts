/**
 * Regression test for handleEditModeApproval restarting live repo agents.
 *
 * Edit mode only flips the sandbox at spawn time (editAllowed puts the clone in
 * allowWritePaths). A repo agent that is already running keeps its read-only
 * mount and never re-reads the flag, so writes keep hitting a read-only
 * filesystem after approval (observed on task-20260625-1122-30wkzk). Approval
 * must tear the running repo agent down so PM's delegation re-spawns it fresh
 * with a writable checkout — while leaving PM (not a repo agent) running.
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
  team: AgentDef[],
) => Task;

const TASK_ID = 'task-20260625-1122-30wkzk-test';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    visibility: 'public',
    task_owner: 'backend-agent',
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
  };
}

const pmDef = () =>
  ({ id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' }) as AgentDef;
const backendDef = () =>
  ({
    id: 'backend-agent',
    key: 'backend',
    role: 'BE',
    expertise: '',
    pluginName: 'eng',
    repo: { primary: 'sweatco/sweatcoin-backend' },
  }) as unknown as AgentDef;

describe('handleEditModeApproval — restart repo agents for a writable mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockImplementation(async (agent: { handle?: unknown }) => {
      agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort: vi.fn() };
    });
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('tears down + removes a running repo agent, keeps PM, and flushes edit_allowed', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef(), backendDef()]);

    // Backend is live before approval (the failure condition).
    await task.sendMessage('start work', 'backend-agent');
    const backend = task.agentProcesses.get('backend-agent');
    expect(backend?.isRunning).toBe(true);
    const abort = (backend!.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    await task.handleEditModeApproval({ id: 'U1', name: 'Egor' });

    // Flag set + approver recorded.
    expect(task.metadata.edit_allowed).toBe(true);
    expect(task.metadata.edit_approved_by?.name).toBe('Egor');
    // Running repo agent torn down and removed → next delegation re-spawns it RW.
    expect(abort).toHaveBeenCalled();
    expect(task.agentProcesses.has('backend-agent')).toBe(false);
    // PM is not a repo agent — the delegation kept/spawned it.
    expect(task.agentProcesses.has('pm-agent')).toBe(true);
  });

  it('leaves an idle (not-running) repo agent alone', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef(), backendDef()]);
    // No spawn — backend exists in the team but was never started.
    await task.handleEditModeApproval({ id: 'U1', name: 'Egor' });
    expect(task.metadata.edit_allowed).toBe(true);
    // Nothing to tear down; no crash.
    expect(task.agentProcesses.has('backend-agent')).toBe(false);
  });
});
