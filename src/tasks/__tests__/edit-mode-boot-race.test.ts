/**
 * Regression test for ensureAgentSpawned reconciling a repo agent that booted
 * read-only just as edit mode was approved.
 *
 * A repo agent's sandbox mount and repo-tool allowlist are frozen from
 * edit_allowed at spawn time (spawn.ts). handleEditModeApproval restarts the
 * repo agents that are *running* at approval, but one still mid-boot then (no
 * live handle yet) slips past its isRunning check, finishes booting read-only,
 * and stays read-only — create_branch and every write is denied (reproduced
 * live). ensureAgentSpawned catches it the next time work is delivered: it tears
 * the read-only agent down (abort + stop queue) and drops it so a fresh, writable
 * spawn replaces it, resuming the same session. Non-repo agents (PM) and agents
 * that already booted writable are left alone.
 *
 * spawnAgent is mocked: it assigns a handle and records editModeAtSpawn from the
 * live edit_allowed flag, exactly as the real repo branch does — no SDK subprocess.
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
  team: AgentDef[],
) => Task;

const TASK_ID = 'task-20260708-bootrace-test';

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
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
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

// Mock spawn: assign a handle and record what edit mode the process booted under,
// mirroring the real repo branch (agent.editModeAtSpawn = editAllowed).
function installSpawnMock() {
  spawnMock.mockImplementation(async (agent: Agent, task: Task) => {
    (agent as unknown as { handle: unknown }).handle = {
      isRunning: true,
      running: new Promise<void>(() => {}),
      abort: vi.fn(),
    };
    if (agent.def.repo) {
      agent.editModeAtSpawn = task.metadata.edit_allowed === true;
    }
  });
}

describe('ensureAgentSpawned — reconcile a read-only boot that raced edit-mode approval', () => {
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

  it('restarts a read-only repo agent (fresh, writable, same session) on the next message once edit mode is approved', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef(), backendDef()]);

    // Backend boots read-only (edit mode not yet approved).
    await task.sendMessage('investigate read-only', 'backend-agent');
    const roAgent = task.agentProcesses.get('backend-agent')!;
    expect(roAgent.editModeAtSpawn).toBe(false);
    roAgent.session.session_id = 'sess-boot'; // SDK assigned one during the read-only boot
    const roAbort = (roAgent.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    // Edit mode approved, but this agent was mid-boot then, so the approval
    // restart loop missed it — simulate by flipping the flag directly.
    task.metadata.edit_allowed = true;

    // Next message to it must reconcile: tear down + fresh writable spawn.
    await task.sendMessage('now make the change', 'backend-agent');
    const rwAgent = task.agentProcesses.get('backend-agent')!;

    expect(roAbort).toHaveBeenCalled(); // read-only process torn down
    expect(rwAgent).not.toBe(roAgent); // replaced with a fresh Agent
    expect(rwAgent.editModeAtSpawn).toBe(true); // re-spawned writable
    expect(rwAgent.session.session_id).toBe('sess-boot'); // same SDK session resumed
  });

  it('does not restart a repo agent that already booted writable', async () => {
    const meta = metadata();
    meta.edit_allowed = true;
    const task = new TaskCtor(TASK_ID, meta, [pmDef(), backendDef()]);

    await task.sendMessage('work', 'backend-agent');
    const first = task.agentProcesses.get('backend-agent')!;
    expect(first.editModeAtSpawn).toBe(true);
    const abort = (first.handle as unknown as { abort: ReturnType<typeof vi.fn> }).abort;

    await task.sendMessage('more work', 'backend-agent');
    expect(task.agentProcesses.get('backend-agent')).toBe(first); // same agent, no restart
    expect(abort).not.toHaveBeenCalled();
  });

  it('never reconciles PM (not a repo agent) even with edit mode approved', async () => {
    const meta = metadata();
    meta.edit_allowed = true;
    const task = new TaskCtor(TASK_ID, meta, [pmDef(), backendDef()]);

    await task.sendMessage('hi', 'pm-agent');
    const pm = task.agentProcesses.get('pm-agent')!;
    expect(pm.editModeAtSpawn).toBeUndefined(); // never set for non-repo agents

    await task.sendMessage('hi again', 'pm-agent');
    expect(task.agentProcesses.get('pm-agent')).toBe(pm); // same agent, no restart
  });
});
