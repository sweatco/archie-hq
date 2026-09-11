/**
 * One-time migration notice for tasks created before the flat-PM rework.
 *
 * Every task folder that existed at the cutover was written by the multi-agent
 * engine, and the PM session inside it is conditioned on that world: it messaged
 * specialists, assigned owners and waited for replies. These cases pin the two
 * halves of the correction — the stamp that identifies such a task on load, and
 * the notice that rides the FIRST wake it receives afterwards and no later one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

// No real SDK subprocess — just flip the agent's handle to "running", the way
// spawn.ts wires it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

// Every save in these cases would otherwise write into a real sessions dir.
const { writeFileMock, mkdirMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: writeFileMock, mkdir: mkdirMock };
});

vi.mock('../../system/plugin-sync.js', () => ({ syncPlugins: vi.fn().mockResolvedValue(undefined) }));

import { Task, activeTasks, stampRuntimeVersion, RUNTIME_VERSION } from '../task.js';
import { buildMigrationNotice } from '../../agents/prompts.js';
import { MessageQueue } from '../../agents/message-queue.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TASK_ID = 'task-20260101-0000-legacy';

/** A task folder as the old engine left it: no runtime_version anywhere. */
function legacyMetadata(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as TaskMetadata;
}

function pmDef(): AgentDef {
  return { id: 'pm-agent', key: 'pm', visibility: 'global', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' } as AgentDef;
}

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;

describe('stampRuntimeVersion', () => {
  it('stamps and flags metadata written by the old engine', () => {
    const m = legacyMetadata();

    expect(stampRuntimeVersion(m)).toBe(true);
    expect(m.runtime_version).toBe(RUNTIME_VERSION);
    expect(m.migration_notice_pending).toBe(true);
  });

  it('stamps a completed legacy task too — the notice only costs anything if it is resumed', () => {
    const m = legacyMetadata({ status: 'completed' });

    expect(stampRuntimeVersion(m)).toBe(true);
    expect(m.migration_notice_pending).toBe(true);
  });

  it('is a no-op on already-stamped metadata, so the notice is never re-queued', () => {
    const m = legacyMetadata({ runtime_version: RUNTIME_VERSION });

    expect(stampRuntimeVersion(m)).toBe(false);
    expect(m.migration_notice_pending).toBeUndefined();
  });
});

describe('buildMigrationNotice', () => {
  it('names the removed tools and the replacement delegation path', () => {
    const notice = buildMigrationNotice(legacyMetadata());

    for (const tool of ['send_message_to_agent', 'assign_task_owner', 'spawn_repo_agent', 'log_finding', 'share_artifact', 'get_agents_status']) {
      expect(notice).toContain(tool);
    }
    expect(notice).toContain('Agent tool');
    expect(notice).toContain('coding worker');
    expect(notice).toContain('- none mounted');
    // A budget the PM's context has to survive: this rides in front of a real wake.
    expect(notice.split('\n').length).toBeLessThan(40);
  });

  it('lists each attached repo with its clone path, branch and edit-mode state', () => {
    const notice = buildMigrationNotice(
      legacyMetadata({
        edit_allowed: true,
        repositories: [
          { github: 'acme/backend', clone_path: '/sessions/t/repos/acme/backend', current_branch: 'archie/task-x' },
          { github: 'acme/mobile' },
        ],
      }),
    );

    expect(notice).toContain('- acme/backend — clone: /sessions/t/repos/acme/backend — branch: archie/task-x — edit mode: on');
    // A repo recorded before its clone finished still has to appear.
    expect(notice).toContain('- acme/mobile — clone: not cloned — branch: unknown — edit mode: on');
    expect(notice).toContain('mount_repo adopts these existing clones');
    expect(notice).toContain('git status');
  });

  it('reports edit mode as off when the task never got approval', () => {
    const notice = buildMigrationNotice(legacyMetadata({ repositories: [{ github: 'acme/backend' }] }));

    expect(notice).toContain('edit mode: off');
  });

  it('lists outstanding approvals, and omits the line when there are none', () => {
    const withPending = buildMigrationNotice(
      legacyMetadata({
        pending_merge_approval: { github: 'acme/backend', pr_number: 42, requested_by: 'pm-agent', requested_at: '2026-01-01T00:00:00.000Z' },
        pending_trigger_id: 'trig-7',
      }),
    );

    expect(withPending).toContain('Pending approvals: merge of acme/backend#42; trigger trig-7.');
    expect(buildMigrationNotice(legacyMetadata())).not.toContain('Pending approvals');
  });
});

describe('migration notice delivery', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockImplementation(async (agent: { handle?: unknown }) => {
      agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort: vi.fn() };
    });
    writeFileMock.mockClear();
    addSpy = vi.spyOn(MessageQueue.prototype, 'addMessage');
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
    addSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('prepends the notice to the first wake and to no later one', async () => {
    const metadata = legacyMetadata({ migration_notice_pending: true, runtime_version: RUNTIME_VERSION });
    const task = new TaskCtor(TASK_ID, metadata, pmDef());

    await task.sendMessage('Task was interrupted. Review the conversation and continue.');
    await task.sendMessage('New activity in a thread you are in.');

    const delivered = addSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('RUNTIME CHANGED WHILE THIS TASK WAS IDLE');
    // The wake's own content survives in front of nothing and behind the notice.
    expect(delivered[0].endsWith('Task was interrupted. Review the conversation and continue.')).toBe(true);
    expect(delivered[1]).toBe('New activity in a thread you are in.');
    // Cleared and flushed, so a restart before the PM answers cannot repeat it.
    expect(metadata.migration_notice_pending).toBe(false);
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('leaves a wake untouched on a task that was never flagged', async () => {
    const task = new TaskCtor(TASK_ID, legacyMetadata({ runtime_version: RUNTIME_VERSION }), pmDef());

    await task.sendMessage('New task. This is what arrived.');

    expect(addSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual(['New task. This is what arrived.']);
  });
});

describe('Task.create', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps the current runtime version and leaves no notice pending', async () => {
    const task = await Task.create();

    expect(task.metadata.runtime_version).toBe(RUNTIME_VERSION);
    expect(task.metadata.migration_notice_pending).toBeUndefined();

    // The same is true of what landed on disk — a fresh task must never be
    // re-stamped (and so re-flagged) by the next Task.get.
    const written = writeFileMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('metadata.json'));
    expect(written).toBeDefined();
    const onDisk = JSON.parse(String(written![1])) as TaskMetadata;
    expect(onDisk.runtime_version).toBe(RUNTIME_VERSION);
    expect(stampRuntimeVersion(onDisk)).toBe(false);
  });
});
