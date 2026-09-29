/**
 * The wall-clock cap parks the task and stops any background work still in
 * flight, and the next wake tells the PM that the time limit, not a person, cut
 * that work off. Cut-off workers see Claude Code's user-denial wording on their
 * tool calls, so without the notice the PM reports a refusal nobody made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

const { writeFileMock } = vi.hoisted(() => ({ writeFileMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: writeFileMock,
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { Task, activeTasks, RUNTIME_VERSION } from '../task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { MessageQueue } from '../../agents/message-queue.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TASK_ID = 'task-20260101-0000-cappause';

function metadata(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    runtime_version: RUNTIME_VERSION,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as TaskMetadata;
}

function pmDef(): AgentDef {
  return { id: 'pm-agent', key: 'pm', visibility: 'global', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' } as AgentDef;
}

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;

let aborts: ReturnType<typeof vi.fn>[];
let addSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  aborts = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(async (agent: { handle?: unknown }) => {
    const abort = vi.fn();
    aborts.push(abort);
    agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort };
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

/** Start a task whose PM went idle with a background worker still running, then let the cap fire. */
async function parkByCap(meta: TaskMetadata): Promise<Task> {
  const task = new TaskCtor(TASK_ID, meta, pmDef());
  vi.spyOn(task, 'postToUser').mockResolvedValue(null);
  await task.sendMessage('Roll out the new copy.');
  task.agent!.updateSession(false);
  task.agent!.backgroundTasks.add('worker-1');
  task.budgets.taskStartTime = new Date(Date.now() - task.budgets.taskTimeoutMs);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(1_000);
  return task;
}

describe('wall-clock cap park', () => {
  it('stops background work even when the PM itself is idle', async () => {
    const task = await parkByCap(metadata());

    expect(task.metadata.status).toBe('completed');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toHaveBeenCalled();
  });

  it('tells the PM on the next wake, and only that wake, that the time limit stopped its work', async () => {
    await parkByCap(metadata());

    // A reply reopens the task from disk as a fresh instance.
    const written = writeFileMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/metadata.json.'));
    const meta = JSON.parse(String(written.at(-1)![1])) as TaskMetadata;
    const reopened = new TaskCtor(TASK_ID, meta, pmDef());
    await reopened.sendMessage('please continue');
    await reopened.sendMessage('any update?');

    const delivered = addSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(delivered).toEqual([
      'Roll out the new copy.',
      `${AGENT_PROMPTS.capPauseNotice}\n\nplease continue`,
      'any update?',
    ]);
    expect(meta.cap_pause_notice_pending).toBe(false);
  });
});
