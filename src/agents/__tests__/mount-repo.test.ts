/**
 * `mount_repo` — the only path by which a task gets a clone.
 *
 * These cover the tool's own contract: what it validates, what it records, and
 * what it hands the clone layer. The checkout decision itself is pure and
 * lives in `decideCloneCheckout` (tested in
 * `src/connectors/github/__tests__/task-clone.test.ts`); here we assert that
 * mount_repo feeds it the task's live edit mode and task branch, since that is
 * what makes a mounted repo writable at the right moment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AttachedRepo } from '../../types/task.js';

// ---- Module mocks ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn(),
  parseCheckRef: vi.fn(),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  getArchieAttributionIdentity: vi.fn().mockReturnValue(null),
}));

vi.mock('../../connectors/github/repo-clone.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/github/repo-clone.js')>();
  return {
    gitExec: vi.fn().mockResolvedValue(''),
    // The pure reader stays real — mount_repo's "do I already know the base
    // branch?" decision is exactly what it answers.
    recordedBaseBranch: actual.recordedBaseBranch,
    ensureTaskClone: vi.fn(),
    setupSharedClone: vi.fn(),
    cloneExists: vi.fn().mockResolvedValue(false),
    fetchOrigin: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  isThreadMuted: vi.fn().mockResolvedValue(false),
  getTaskClonePath: vi.fn((taskId: string, github: string) => `/sessions/${taskId}/repos/${github}`),
}));

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/workdir.js')>()),
  getBaseCachePath: vi.fn((github: string) => `/workdir/repos/${github}`),
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(),
    system: vi.fn(), error: vi.fn(), warn: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
}));

import { getGitHubClient } from '../../connectors/github/client.js';
import { ensureTaskClone } from '../../connectors/github/repo-clone.js';

// ---- Helpers ----

const client = {
  resolveRepo: vi.fn(),
  listAccessibleRepos: vi.fn().mockResolvedValue([]),
};

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', isPm: true, pluginName: 'pm', visibility: 'global' },
    queue: {} as any,
    session: { active: false },
  } as unknown as Agent;
}

function makeTask(overrides: Partial<Task['metadata']> = {}): Task {
  return {
    taskId: 'task-123',
    metadata: {
      repositories: [],
      status: 'active',
      channels: {},
      agent_sessions: {},
      ...overrides,
    },
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    postToUser: vi.fn(),
    postInteractiveToUser: vi.fn(),
  } as unknown as Task;
}

function mountTool(agent: Agent, task: Task) {
  const server: any = createOrchestrationMcpServer(agent, task);
  const tools: Record<string, any> = server.instance._registeredTools
    ?? Object.fromEntries(server.instance._tools ?? []);
  return tools['mount_repo'].callback ?? tools['mount_repo'].handler;
}

/** The options object mount_repo handed the clone layer on call `n`. */
function ensureArgs(n = 0) {
  return vi.mocked(ensureTaskClone).mock.calls[n][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGitHubClient).mockReturnValue(client as any);
  client.resolveRepo.mockResolvedValue({ default_branch: 'trunk' });
  vi.mocked(ensureTaskClone).mockImplementation(async (opts) => {
    // Stand in for the real clone layer: record the checkout the way it would.
    opts.attached.clone_path = opts.clonePath;
    opts.attached.current_branch = opts.editAllowed ? opts.taskBranch : opts.baseBranch;
    return {
      clone_path: opts.clonePath,
      branch: opts.attached.current_branch!,
      base_branch: opts.baseBranch ?? 'main',
      created: true,
    };
  });
});

// ---- Tests ----

describe('mount_repo', () => {
  it('clones a repo the task has not mounted and records it', async () => {
    const task = makeTask();
    const result = await mountTool(makeAgent(), task)({ github: 'org/backend' });

    expect(client.resolveRepo).toHaveBeenCalledWith('org/backend');
    expect(ensureArgs()).toMatchObject({
      clonePath: '/sessions/task-123/repos/org/backend',
      baseRepoPath: '/workdir/repos/org/backend',
      baseBranch: 'trunk',
      editAllowed: false,
      taskBranch: 'archie/task-123',
    });

    expect(task.metadata.repositories).toHaveLength(1);
    expect(task.metadata.repositories[0]).toMatchObject({
      github: 'org/backend',
      clone_path: '/sessions/task-123/repos/org/backend',
    });
    // Flushed, not debounced: the clone exists on disk, so the record that
    // points at it has to survive an immediate crash.
    expect(task.save).toHaveBeenCalledWith(true);

    const text = result.content[0].text;
    expect(text).toContain('/sessions/task-123/repos/org/backend');
    expect(text).toContain('Branch: trunk');
    expect(text).toContain('Default branch: trunk');
    expect(text).toContain('read-only');
  });

  it('cuts the task branch and reports read-write once edit mode is approved', async () => {
    const task = makeTask({ edit_allowed: true });
    const result = await mountTool(makeAgent(), task)({ github: 'org/backend' });

    expect(ensureArgs()).toMatchObject({ editAllowed: true, taskBranch: 'archie/task-123' });
    expect(result.content[0].text).toContain('Branch: archie/task-123');
    expect(result.content[0].text).toContain('read-write');
  });

  it('is idempotent: a second mount reuses the entry and re-asks nothing of GitHub', async () => {
    const task = makeTask();
    const mount = mountTool(makeAgent(), task);

    await mount({ github: 'org/backend' });
    vi.mocked(ensureTaskClone).mockResolvedValueOnce({
      clone_path: '/sessions/task-123/repos/org/backend',
      branch: 'trunk',
      base_branch: 'trunk',
      created: false,
    });
    const second = await mount({ github: 'org/backend' });

    // One attachment, not two, and the base branch is read back off it rather
    // than fetched again.
    expect(task.metadata.repositories).toHaveLength(1);
    expect(client.resolveRepo).toHaveBeenCalledTimes(1);
    expect(ensureArgs(1)).toMatchObject({ baseBranch: 'trunk' });
    expect(ensureArgs(1).attached).toBe(task.metadata.repositories[0]);
    expect(second.content[0].text).toContain('Already mounted');
  });

  it('re-mounting after edit-mode approval passes the new mode through', async () => {
    const task = makeTask();
    const mount = mountTool(makeAgent(), task);

    await mount({ github: 'org/backend' });
    task.metadata.edit_allowed = true;
    await mount({ github: 'org/backend' });

    expect(ensureArgs(0).editAllowed).toBe(false);
    expect(ensureArgs(1).editAllowed).toBe(true);
    expect(task.metadata.repositories).toHaveLength(1);
  });

  it('matches a mounted repo regardless of the casing the caller typed', async () => {
    const task = makeTask();
    const mount = mountTool(makeAgent(), task);

    await mount({ github: 'org/backend' });
    await mount({ github: 'Org/Backend' });

    expect(task.metadata.repositories).toHaveLength(1);
    expect(task.metadata.repositories[0].github).toBe('org/backend');
  });

  it('accepts a pasted GitHub URL', async () => {
    const task = makeTask();
    await mountTool(makeAgent(), task)({ github: 'https://github.com/org/backend.git' });

    expect(client.resolveRepo).toHaveBeenCalledWith('org/backend');
    expect(task.metadata.repositories[0].github).toBe('org/backend');
  });

  it('refuses something that is not an owner/repo identifier', async () => {
    const task = makeTask();
    const result = await mountTool(makeAgent(), task)({ github: 'backend' });

    expect(result.content[0].text).toContain('owner/repo');
    expect(client.resolveRepo).not.toHaveBeenCalled();
    expect(ensureTaskClone).not.toHaveBeenCalled();
    expect(task.metadata.repositories).toHaveLength(0);
  });

  it('refuses a repo the GitHub App cannot reach, recording nothing', async () => {
    client.resolveRepo.mockResolvedValue(null);
    const task = makeTask();
    const result = await mountTool(makeAgent(), task)({ github: 'other/secret' });

    expect(result.content[0].text).toContain('cannot reach');
    expect(result.content[0].text).toContain('list_available_repos');
    expect(ensureTaskClone).not.toHaveBeenCalled();
    expect(task.metadata.repositories).toHaveLength(0);
  });

  it('says GitHub is not configured rather than failing obscurely', async () => {
    vi.mocked(getGitHubClient).mockReturnValue(null as any);
    const task = makeTask();
    const result = await mountTool(makeAgent(), task)({ github: 'org/backend' });

    expect(result.content[0].text).toContain('GitHub is not configured');
    expect(ensureTaskClone).not.toHaveBeenCalled();
  });

  it('records nothing when the checkout itself fails', async () => {
    vi.mocked(ensureTaskClone).mockRejectedValue(new Error('fatal: repository not found'));
    const task = makeTask();
    const result = await mountTool(makeAgent(), task)({ github: 'org/backend' });

    expect(result.content[0].text).toContain('repository not found');
    expect(task.metadata.repositories).toHaveLength(0);
    expect(task.save).not.toHaveBeenCalled();
  });

  it('keeps an already-mounted repo recorded when a later mount fails', async () => {
    const mounted: AttachedRepo = {
      github: 'org/backend',
      clone_path: '/sessions/task-123/repos/org/backend',
      current_branch: 'trunk',
    };
    const task = makeTask({ repositories: [mounted] });
    vi.mocked(ensureTaskClone).mockRejectedValue(new Error('disk full'));

    const result = await mountTool(makeAgent(), task)({ github: 'org/backend' });

    expect(result.content[0].text).toContain('disk full');
    expect(task.metadata.repositories).toEqual([mounted]);
  });
});
