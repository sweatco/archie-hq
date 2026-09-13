/**
 * Regression test for `ensurePm` reconciling an agent that booted read-only
 * just as edit mode was approved.
 *
 * The sandbox mount and repo-tool allowlist are frozen from edit_allowed at
 * spawn time (spawn.ts). handleEditModeApproval restarts the agent, but one
 * still mid-boot at that moment has no live handle to abort: it finishes
 * booting read-only and stays that way — create_branch and every write denied
 * (reproduced live, when the mount belonged to a repo agent). `ensurePm`
 * catches it the next time work is delivered: it tears the read-only process
 * down (abort + stop queue) and drops it so a fresh, writable spawn replaces
 * it, resuming the same session. An agent that already booted writable is left
 * alone.
 *
 * spawnAgent is mocked: it assigns a handle and records editModeAtSpawn from
 * the live edit_allowed flag, exactly as the real spawner does — no SDK
 * subprocess.
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
import type { Agent } from '../../agents/agent.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  pmDef: AgentDef,
) => Task;

const TASK_ID = 'task-20260708-bootrace-test';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
  };
}

const pmDef = () =>
  ({ id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' }) as AgentDef;

// Mock spawn: assign a handle and record what edit mode the process booted
// under, mirroring the real spawner (agent.editModeAtSpawn = editAllowed).
function installSpawnMock() {
  spawnMock.mockImplementation(async (agent: Agent, task: Task) => {
    (agent as unknown as { handle: unknown }).handle = {
      isRunning: true,
      running: new Promise<void>(() => {}),
      abort: vi.fn(),
    };
    agent.editModeAtSpawn = task.metadata.edit_allowed === true;
  });
}

describe('ensurePm — reconcile a read-only boot that raced edit-mode approval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    installSpawnMock();
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('restarts a read-only agent (fresh, writable, same session) on the next message once edit mode is approved', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    // The agent boots read-only (edit mode not yet approved).
    await task.sendMessage('investigate read-only');
    const roAgent = task.agent!;
    expect(roAgent.editModeAtSpawn).toBe(false);
    roAgent.session.session_id = 'sess-boot'; // SDK assigned one during the read-only boot
    const roAbort = (roAgent.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    // Edit mode approved, but this agent was mid-boot then, so the approval
    // restart missed it — simulate by flipping the flag directly.
    task.metadata.edit_allowed = true;

    // The next message must reconcile: tear down + fresh writable spawn.
    await task.sendMessage('now make the change');
    const rwAgent = task.agent!;

    expect(roAbort).toHaveBeenCalled(); // read-only process torn down
    expect(rwAgent).not.toBe(roAgent); // replaced with a fresh Agent
    expect(rwAgent.editModeAtSpawn).toBe(true); // re-spawned writable
    expect(rwAgent.session.session_id).toBe('sess-boot'); // same SDK session resumed
  });

  it('does not restart an agent that already booted writable', async () => {
    const meta = metadata();
    meta.edit_allowed = true;
    const task = new TaskCtor(TASK_ID, meta, pmDef());

    await task.sendMessage('work');
    const first = task.agent!;
    expect(first.editModeAtSpawn).toBe(true);
    const abort = (first.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    await task.sendMessage('more work');
    expect(task.agent).toBe(first); // same agent, no restart
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not restart a read-only agent while edit mode is still unapproved', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    await task.sendMessage('hi');
    const first = task.agent!;
    expect(first.editModeAtSpawn).toBe(false);

    await task.sendMessage('hi again');
    expect(task.agent).toBe(first); // same agent, no restart
  });
});
