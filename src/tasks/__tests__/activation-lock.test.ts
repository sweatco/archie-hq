/**
 * Activation-lock regression test.
 *
 * Guards against the double-spawn bug: when two reopen triggers (webhook + Slack
 * + startup recovery) race for the same parked task, each `Task.get` misses the
 * `activeTasks` cache and builds its own Task instance — and without
 * serialization, each would activate and spawn its own agent subprocess on the
 * same session id. `Task.sendMessage` funnels through `activationLock`, resolving
 * to the canonical instance inside the lock, so exactly one spawn happens and the
 * loser's message is routed onto the winner (not dropped).
 *
 * We mock `spawnAgent` (no real SDK subprocess) and use fake timers so the
 * debounced save / wall-clock interval never fire. The two Task instances are
 * built directly via the (runtime-callable) constructor — exactly the two-instance
 * situation `Task.get` produces under the race.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

// Mock the SDK spawn: no real subprocess, just flip the agent's handle to
// "running" so the per-Agent isRunning guard behaves like production.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

import { Task, activeTasks } from '../task.js';
import { MessageQueue } from '../../agents/message-queue.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

// Runtime-callable view of the private constructor — mirrors the two separate
// instances two concurrent `Task.get` misses would create for one taskId.
const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function metadata(taskId: string): TaskMetadata {
  return {
    task_id: taskId,
    visibility: 'public',
    task_owner: 'pm-agent',
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:00.000Z',
  };
}

function pmDef(): AgentDef {
  return {
    id: 'pm-agent',
    key: 'pm',
    statusLabel: '',
    role: 'PM',
    expertise: '',
    isPm: true,
    pluginName: 'pm',
  } as AgentDef;
}

const TASK_ID = 'task-20260630-0000-locktst';

describe('Task activation lock (double-spawn guard)', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    // Each spawn marks its agent running, the way spawn.ts wires the handle.
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

  it('spawns once when two separate instances send concurrently for the same taskId', async () => {
    const a = new TaskCtor(TASK_ID, metadata(TASK_ID), [pmDef()]);
    const b = new TaskCtor(TASK_ID, metadata(TASK_ID), [pmDef()]);

    await Promise.all([a.sendMessage('from-a'), b.sendMessage('from-b')]);

    // Core guarantee: the duplicate instance did NOT spawn its own subprocess.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Only the canonical instance holds an agent; the loser routed onto it.
    expect(a.agentProcesses.size + b.agentProcesses.size).toBe(1);
    const canonical = activeTasks.get(TASK_ID);
    expect(canonical === a || canonical === b).toBe(true);
    // Neither message was dropped — both landed on the one agent's queue.
    const delivered = addSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(delivered).toContain('from-a');
    expect(delivered).toContain('from-b');
  });

  it('spawns once for two concurrent sends on a single instance', async () => {
    const a = new TaskCtor(TASK_ID, metadata(TASK_ID), [pmDef()]);

    await Promise.all([a.sendMessage('m1'), a.sendMessage('m2')]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a.agentProcesses.size).toBe(1);
  });

  it('reactivates (one fresh spawn) when the canonical instance parked before the next send', async () => {
    const a = new TaskCtor(TASK_ID, metadata(TASK_ID), [pmDef()]);
    await a.sendMessage('first');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Simulate a park: the prior instance left activeTasks (complete/stop).
    activeTasks.delete(TASK_ID);

    // A new trigger builds a fresh instance and legitimately reactivates — this
    // is a fresh spawn, not a duplicate (the old subprocess was torn down).
    const b = new TaskCtor(TASK_ID, metadata(TASK_ID), [pmDef()]);
    await b.sendMessage('second');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(activeTasks.get(TASK_ID)).toBe(b);
  });
});
