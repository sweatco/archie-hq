import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-completion-quiescence-test-'));
});

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/workdir.js')>()),
  SESSIONS_DIR: SESSIONS_ROOT,
}));

import { createOrchestrationMcpServer } from '../../agents/tools.js';
import { idleDecision, scheduleIdleCheck } from '../recovery.js';
import { activeTasks, shouldClearCompletionIntent, Task } from '../task.js';
import { offEvent, offTaskCompleted, onEvent, onTaskCompleted } from '../../system/event-bus.js';
import { logger } from '../../system/logger.js';
import type { Agent } from '../../agents/agent.js';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

beforeAll(async () => {
  await mkdir(join(SESSIONS_ROOT, 'task-20260817-1201-enqueue', 'shared'), { recursive: true });
});

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

function fakeAgent(opts: { active?: boolean; pendingTeardown?: boolean; bgTasks?: string[] } = {}): Agent {
  return {
    pendingTeardown: opts.pendingTeardown ? () => Promise.resolve() : undefined,
    session: { active: opts.active ?? false },
    backgroundTasks: new Set<string>(opts.bgTasks ?? []),
  } as unknown as Agent;
}

function getToolHandler(server: ReturnType<typeof createOrchestrationMcpServer>, name: string) {
  const tools = (server.instance as any)._registeredTools
    ?? Object.fromEntries((server.instance as any)._tools ?? []);
  return tools[name].callback ?? tools[name].handler;
}

function fakeTask(opts: {
  isActive?: boolean;
  completionIntent?: boolean;
  agents?: Agent[];
}): Pick<Task, 'isActive' | 'completionIntent' | 'agentProcesses'> {
  const agentProcesses = new Map<string, Agent>();
  (opts.agents ?? []).forEach((a, i) => agentProcesses.set(`agent-${i}`, a));
  return {
    isActive: opts.isActive ?? true,
    completionIntent: opts.completionIntent ?? false,
    agentProcesses,
  } as unknown as Pick<Task, 'isActive' | 'completionIntent' | 'agentProcesses'>;
}

describe('idleDecision', () => {
  it('waits when the task is not active', () => {
    expect(idleDecision(fakeTask({ isActive: false, agents: [fakeAgent()] }))).toBe('wait');
  });

  it('waits when any agent has a pending (forced-stop) teardown', () => {
    expect(
      idleDecision(fakeTask({ agents: [fakeAgent(), fakeAgent({ pendingTeardown: true })] })),
    ).toBe('wait');
  });

  it('waits when no agents are spawned (not quiescent)', () => {
    expect(idleDecision(fakeTask({ agents: [] }))).toBe('wait');
  });

  it('waits when any agent is still active (work in flight)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent({ active: true }), fakeAgent()] })),
    ).toBe('wait');
  });

  it('waits when an agent has an in-flight background task (busy, not stalled)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent({ bgTasks: ['t1'] })] })),
    ).toBe('wait');
  });

  it('completes when quiescent and PM signalled completion intent', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent(), fakeAgent()] })),
    ).toBe('complete');
  });

  it('recovers when quiescent but nobody parked (dropped ball)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: false, agents: [fakeAgent()] })),
    ).toBe('recover');
  });

  it('prioritises the forced-stop teardown guard over completion intent', () => {
    expect(
      idleDecision(
        fakeTask({ completionIntent: true, agents: [fakeAgent({ pendingTeardown: true })] }),
      ),
    ).toBe('wait');
  });
});

describe('shouldClearCompletionIntent', () => {
  it('clears on a genuine PM inactive→active edge (re-engagement)', () => {
    expect(shouldClearCompletionIntent('pm-agent', true, false)).toBe(true);
  });

  it('does NOT clear on the init re-fire of an already-active PM turn', () => {
    expect(shouldClearCompletionIntent('pm-agent', true, true)).toBe(false);
  });

  it('does NOT clear when a specialist re-engages', () => {
    expect(shouldClearCompletionIntent('mobile-agent', true, false)).toBe(false);
  });

  it('does NOT clear on PM going inactive', () => {
    expect(shouldClearCompletionIntent('pm-agent', false, true)).toBe(false);
  });
});

describe('completion quiescence wiring', () => {
  it('does not resolve graceful completion before durable subscribers finish', async () => {
    let release!: () => void;
    const durableIntent = new Promise<void>((resolve) => { release = resolve; });
    const listener = vi.fn(() => durableIntent);
    onTaskCompleted(listener);
    const task = new TaskCtor('task-20260817-1201-enqueue', {
      task_id: 'task-20260817-1201-enqueue',
      visibility: 'public',
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      edit_allowed: true,
      status: 'in_progress',
      created_at: '2026-08-15T12:00:00.000Z',
      updated_at: '2026-08-15T12:00:00.000Z',
    }, []);
    task.isActive = true;
    activeTasks.set(task.taskId, task);

    let resolved = false;
    const completion = task.complete().then(() => { resolved = true; });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    expect(task.isActive).toBe(true);
    expect(task.metadata.status).toBe('in_progress');

    release();
    await expect(completion).resolves.toBeUndefined();
    expect(resolved).toBe(true);
    offTaskCompleted(listener);
    activeTasks.delete(task.taskId);
  });

  it('keeps a task active and in progress when durable completion setup fails', async () => {
    const listener = vi.fn(async () => { throw new Error('pending queue unavailable'); });
    onTaskCompleted(listener);
    const task = new TaskCtor('task-20260817-1201-enqueue', {
      task_id: 'task-20260817-1201-enqueue',
      visibility: 'public',
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      edit_allowed: true,
      status: 'in_progress',
      created_at: '2026-08-15T12:00:00.000Z',
      updated_at: '2026-08-15T12:00:00.000Z',
    }, []);
    task.isActive = true;
    activeTasks.set(task.taskId, task);

    await expect(task.complete()).rejects.toThrow('pending queue unavailable');
    expect(task.isActive).toBe(true);
    expect(task.metadata.status).toBe('in_progress');
    expect(activeTasks.get(task.taskId)).toBe(task);

    offTaskCompleted(listener);
    activeTasks.delete(task.taskId);
  });

  it('runs durable preparation, persistence, and completion publication once for concurrent callers', async () => {
    const taskId = 'task-20260817-1202-concurrent';
    await mkdir(join(SESSIONS_ROOT, taskId, 'shared'), { recursive: true });
    const listener = vi.fn().mockResolvedValue(undefined);
    const events = vi.fn();
    onTaskCompleted(listener);
    onEvent(events);
    const task = new TaskCtor(taskId, {
      task_id: taskId,
      visibility: 'public',
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      edit_allowed: true,
      status: 'in_progress',
      created_at: '2026-08-15T12:00:00.000Z',
      updated_at: '2026-08-15T12:00:00.000Z',
    }, []);
    task.isActive = true;
    activeTasks.set(taskId, task);
    const save = vi.spyOn(task, 'save');

    await Promise.all([task.complete(), task.complete()]);

    expect(listener).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(events.mock.calls.filter(([event]) => event.type === 'task:completed')).toHaveLength(1);
    offTaskCompleted(listener);
    offEvent(events);
    activeTasks.delete(taskId);
  });

  it('logs and reschedules an idle completion after durable setup fails', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const complete = vi.fn().mockRejectedValue(new Error('pending queue unavailable'));
    const task = {
      taskId: 'task-idle-retry',
      isActive: true,
      completionIntent: true,
      agentProcesses: new Map([['pm-agent', fakeAgent()]]),
      complete,
    } as unknown as Task;

    scheduleIdleCheck(task);
    await vi.advanceTimersByTimeAsync(3000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'recovery',
      expect.stringContaining('retrying'),
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(complete).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('logs wall-clock completion failure and leaves the interval armed to retry', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const complete = vi.fn().mockRejectedValue(new Error('pending queue unavailable'));
    const task = Object.assign(Object.create(Task.prototype), {
      taskId: 'task-wall-clock-retry',
      budgets: { taskStartTime: new Date(0), taskTimeoutMs: 0 },
      agentProcesses: new Map(),
      postToUser: vi.fn().mockResolvedValue(null),
      complete,
      taskTimeoutTimer: undefined,
    }) as Task;

    (task as unknown as { startTaskTimeout(): void }).startTaskTimeout();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'budget',
      expect.stringContaining('will retry'),
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(complete).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('records report_completion intent without completing immediately', async () => {
    const task = {
      taskId: 'task-completion',
      isActive: true,
      completionIntent: false,
      metadata: { channels: {}, default_channel: null },
      touch: vi.fn(),
      resurfacePrCards: vi.fn().mockResolvedValue(undefined),
      suspendStatus: vi.fn(),
      setCompletionIntent: Task.prototype.setCompletionIntent,
      complete: vi.fn(),
    } as unknown as Task;
    const agent = { def: { id: 'pm-agent' } } as Agent;
    const handler = getToolHandler(createOrchestrationMcpServer(agent, task), 'report_completion');

    await handler({});

    expect(task.completionIntent).toBe(true);
    expect(task.complete).not.toHaveBeenCalled();
  });

  it('marks an inter-agent recipient active as soon as work is enqueued', async () => {
    const addMessage = vi.fn();
    const updateAgentState = vi.fn();
    const task = Object.assign(Object.create(Task.prototype), {
      taskId: 'task-20260817-1201-enqueue',
      isActive: true,
      team: [],
      budgets: { interAgentMessageCount: 0, interAgentMessageLimit: 100 },
      agentProcesses: new Map([
        ['backend-agent', { queue: { addMessage }, session: { active: false } }],
      ]),
      ensureAgentSpawned: vi.fn().mockResolvedValue(undefined),
      updateAgentState,
      postToUser: vi.fn().mockResolvedValue(undefined),
    }) as Task;

    await task.toolSendMessage('pm-agent', 'backend-agent', 'Investigate');

    expect(addMessage).toHaveBeenCalledWith('Investigate', 'pm-agent');
    expect(updateAgentState).toHaveBeenCalledWith('backend-agent', true);
    expect(addMessage.mock.invocationCallOrder[0]).toBeLessThan(updateAgentState.mock.invocationCallOrder[0]);
  });

  it('clears completion intent on a wired PM inactive-to-active transition', () => {
    const updateSession = vi.fn((active: boolean) => {
      pm.session.active = active;
    });
    const pm = {
      def: { id: 'pm-agent', isPm: true },
      session: { active: false },
      updateSession,
    } as unknown as Agent;
    const task = Object.assign(Object.create(Task.prototype), {
      taskId: 'task-reengage',
      completionIntent: true,
      agentProcesses: new Map([['pm-agent', pm]]),
      statusController: { setActive: vi.fn(), setIdle: vi.fn() },
      debouncedSave: vi.fn(),
    }) as Task;

    task.updateAgentState('pm-agent', true);

    expect(task.completionIntent).toBe(false);
    expect(updateSession).toHaveBeenCalledWith(true, undefined);
  });
});
