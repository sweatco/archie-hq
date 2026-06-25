/**
 * Unit tests for GitHub PR tool handlers.
 *
 * Tests the business logic inside each tool (mergeability checks, error paths,
 * success paths) by calling handlers directly — no LLM, no MCP transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRepoToolsMcpServer,
  createCommsMcpServer,
  createOrchestrationMcpServer,
  createSchedulingMcpServer,
  hydrateBranchState,
  findBranchStateByPR,
} from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';
import type { AttachedRepo } from '../../types/task.js';

// ---- Module mocks ----

vi.mock('../../connectors/github/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/github/client.js')>();
  return {
    // Keep the real parseCheckRef (pure helper) so get_check_run parses for real.
    parseCheckRef: actual.parseCheckRef,
    getGitHubClient: vi.fn(),
    fetchOrigin: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getAgentClonePath: vi.fn((_taskId: string, agentId: string, github: string) =>
    `/sessions/task-123/agents/${agentId}/clones/${github}`,
  ),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-123/repos'),
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: vi.fn(),
    agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue(['backend-agent', 'mobile-agent']),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue(['backend-agent', 'mobile-agent']),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

// ---- Helpers ----

import { getGitHubClient } from '../../connectors/github/client.js';

const mockGitHubClient = {
  getPRStatus: vi.fn(),
  mergePullRequest: vi.fn(),
  closePullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  getPRReviews: vi.fn(),
  getPRComments: vi.fn(),
  getReviewThreads: vi.fn(),
  updatePR: vi.fn(),
  addPRComment: vi.fn(),
  addReviewComment: vi.fn(),
  replyToReviewComment: vi.fn(),
  resolveReviewThread: vi.fn(),
  requestReReview: vi.fn(),
  getCheckRunById: vi.fn(),
  getWorkflowRunById: vi.fn(),
};

function makeAgent(overrides: Partial<AgentDef> = {}): Agent {
  return {
    def: {
      id: 'backend-agent',
      key: 'backend',
      role: 'Backend engineer',
      expertise: 'Node.js',
      pluginName: 'engineering',
      visibility: 'global',
      repo: {
        repos: [{ github: 'org/backend', baseBranch: 'main' }],
        primary: 'org/backend',
      },
      ...overrides,
    },
    queue: {} as any,
    session: { active: false },
  } as Agent;
}

function makeTask(overrides: Partial<Task['metadata']> = {}): Task {
  return {
    taskId: 'task-123',
    team: [
      {
        id: 'backend-agent', key: 'backend', role: 'Backend engineer', expertise: 'Node.js',
        pluginName: 'engineering', visibility: 'global',
        repo: { repos: [{ github: 'org/backend', baseBranch: 'main' }], primary: 'org/backend' },
      },
      {
        id: 'mobile-agent', key: 'mobile', role: 'Mobile engineer', expertise: 'Mobile',
        pluginName: 'engineering', visibility: 'global',
        repo: { repos: [{ github: 'org/mobile', baseBranch: 'main' }], primary: 'org/mobile' },
      },
    ],
    metadata: {
      repositories: {
        'backend-agent': [
          {
            github: 'org/backend',
            clone_path: '/clones/backend',
            current_branch: 'feature/task-123',
            branch_states: {
              'feature/task-123': {
                base_branch: 'main',
              },
            },
          },
        ],
      },
      edit_allowed: true,
      status: 'active',
      channels: {},
      participants: [],
      agent_sessions: {},
      ...overrides,
    },
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    suspendStatus: vi.fn(),
    postToUser: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    toolSendMessage: vi.fn().mockResolvedValue('ok'),
    getAgentStatus: vi.fn().mockReturnValue([]),
    updateAgentState: vi.fn(),
    checkResearchBudget: vi.fn().mockReturnValue(true),
    incrementResearchCount: vi.fn(),
    onResearchBudgetExceeded: vi.fn(),
  } as unknown as Task;
}

/** Extract a tool handler from an MCP server by name */
function getToolFromServer(server: any, toolName: string) {
  const tools: Record<string, any> = (server.instance as any)._registeredTools
    ?? Object.fromEntries((server.instance as any)._tools ?? []);
  if (!tools[toolName]) throw new Error(`Tool '${toolName}' not found in server`);
  return tools[toolName].callback ?? tools[toolName].handler;
}

function getRepoTool(agent: Agent, task: Task, toolName: string) {
  return getToolFromServer(createRepoToolsMcpServer(agent, task), toolName);
}

// ---- Tests ----

describe('merge_pull_request', () => {
  beforeEach(() => {
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
    vi.clearAllMocks();
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
  });

  it('rejects when PR is not open', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'merged', mergeable: true, mergeableState: 'clean', approved: true,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('Cannot merge');
    expect(result.content[0].text).toContain('merged');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects when mergeableState is not clean', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'dirty', approved: true,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('not ready');
    expect(result.content[0].text).toContain('dirty');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects when mergeable is false', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: false, mergeableState: 'blocked', approved: false,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('not ready');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('merges when PR is open and clean', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({
      success: true, message: 'PR #42 merged successfully',
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 42);
    expect(result.content[0].text).toContain('merged successfully');
  });

  it('uses githubRepo from agent def', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({
      success: true, message: 'PR #7 merged successfully',
    });

    const agent = makeAgent({
      id: 'mobile-agent',
      repo: { repos: [{ github: 'org/mobile', baseBranch: 'main' }], primary: 'org/mobile' },
    });
    const tool = getRepoTool(agent, makeTask(), 'merge_pull_request');
    await tool({ pr_number: 7 }, {});

    expect(mockGitHubClient.getPRStatus).toHaveBeenCalledWith('org/mobile', 7);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/mobile', 7);
  });

  it('throws when GitHub client is not configured', async () => {
    vi.mocked(getGitHubClient).mockReturnValue(null as any);

    const tool = getRepoTool(makeAgent(), makeTask(), 'merge_pull_request');
    await expect(tool({ pr_number: 42 }, {})).rejects.toThrow('GitHub client not configured');
  });
});

describe('close_pull_request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
  });

  it('closes the PR', async () => {
    mockGitHubClient.closePullRequest.mockResolvedValue(undefined);

    const tool = getRepoTool(makeAgent(), makeTask(), 'close_pull_request');
    const result = await tool({ pr_number: 99 }, {});

    expect(mockGitHubClient.closePullRequest).toHaveBeenCalledWith('org/backend', 99);
    expect(result.content[0].text).toContain('Closed PR #99');
  });
});

describe('get_pr_status (read-only server)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
  });

  it('returns formatted status', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_pr_status');
    const result = await tool({ pr_number: 5 }, {});

    expect(result.content[0].text).toContain('State: open');
    expect(result.content[0].text).toContain('Mergeable: true');
    expect(result.content[0].text).toContain('Approved: true');
  });
});

describe('get_check_run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
  });

  it('resolves a legacy /runs/<id> check-run permalink and shows output + log', async () => {
    mockGitHubClient.getCheckRunById.mockResolvedValue({
      id: 78033491451, name: 'rspec', app: 'github-actions', status: 'completed',
      conclusion: 'failure', url: 'https://github.com/org/backend/runs/78033491451',
      headSha: 'abc1234def', startedAt: null, completedAt: null,
      output: { title: 'RSpec', summary: '3 failures' },
      logTail: 'Failures:\n  1) Widget flakes\n  rspec ./spec/widget_spec.rb:12',
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    const result = await tool({ ref: 'https://github.com/org/backend/runs/78033491451' }, {});

    expect(mockGitHubClient.getCheckRunById).toHaveBeenCalledWith('org/backend', 78033491451);
    const text = result.content[0].text;
    expect(text).toContain('rspec');
    expect(text).toContain('failure');
    expect(text).toContain('Failures:');
    expect(text).toContain('rspec ./spec/widget_spec.rb:12');
  });

  it('accepts a bare numeric id', async () => {
    mockGitHubClient.getCheckRunById.mockResolvedValue({
      id: 999, name: 'lint', app: 'ci', status: 'completed', conclusion: 'success',
      url: null, headSha: null, startedAt: null, completedAt: null,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    await tool({ ref: '999' }, {});

    expect(mockGitHubClient.getCheckRunById).toHaveBeenCalledWith('org/backend', 999);
  });

  it('routes an /actions/runs/<id> URL to the workflow-run path', async () => {
    mockGitHubClient.getWorkflowRunById.mockResolvedValue({
      id: 555, name: 'CI', status: 'completed', conclusion: 'failure',
      headSha: 'deadbeef', headBranch: 'main', url: 'https://github.com/org/backend/actions/runs/555',
      jobs: [
        { id: 1, name: 'build', status: 'completed', conclusion: 'success', url: null },
        { id: 2, name: 'test', status: 'completed', conclusion: 'failure', url: null, logTail: 'Failures:\n  boom' },
      ],
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    const result = await tool({ ref: 'https://github.com/org/backend/actions/runs/555' }, {});

    expect(mockGitHubClient.getWorkflowRunById).toHaveBeenCalledWith('org/backend', 555);
    expect(mockGitHubClient.getCheckRunById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('test (job 2)');
    expect(result.content[0].text).toContain('boom');
  });

  it('treats /actions/runs/<run>/job/<job> as a check-run (job id)', async () => {
    mockGitHubClient.getCheckRunById.mockResolvedValue({
      id: 42, name: 'rspec', app: 'github-actions', status: 'completed',
      conclusion: 'failure', url: null, headSha: null, startedAt: null, completedAt: null,
    });

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    await tool({ ref: 'https://github.com/org/backend/actions/runs/555/job/42' }, {});

    expect(mockGitHubClient.getCheckRunById).toHaveBeenCalledWith('org/backend', 42);
  });

  it('refuses a URL pointing at a different repo', async () => {
    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    const result = await tool({ ref: 'https://github.com/other/repo/runs/1' }, {});

    expect(result.content[0].text).toContain('Error');
    expect(result.content[0].text).toContain('other/repo');
    expect(mockGitHubClient.getCheckRunById).not.toHaveBeenCalled();
  });

  it('errors on an unparseable ref', async () => {
    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    const result = await tool({ ref: 'not-a-run' }, {});

    expect(result.content[0].text).toContain('Error');
    expect(mockGitHubClient.getCheckRunById).not.toHaveBeenCalled();
  });
});

describe('PM agent tools', () => {
  it('does not include any PR tools', () => {
    const agent = makeAgent({ isPm: true, repo: undefined, id: 'pm-agent' });
    const task = makeTask();
    const servers = [
      createCommsMcpServer(agent, task),
      createOrchestrationMcpServer(agent, task),
      createSchedulingMcpServer(agent, task),
    ];

    const registeredTools = servers.flatMap((server) =>
      Object.keys(
        (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []),
      ),
    );

    const prToolNames = [
      'push_branch', 'create_pull_request', 'get_pr_status', 'get_pr_reviews',
      'get_pr_comments', 'get_review_threads',
      'update_pr', 'add_pr_comment', 'add_review_comment', 'reply_to_review_comment',
      'resolve_review_thread', 'request_re_review', 'merge_pull_request', 'close_pull_request',
    ];

    for (const prTool of prToolNames) {
      expect(registeredTools, `PM servers should not have tool: ${prTool}`).not.toContain(prTool);
    }
  });
});

describe('request_edit_mode', () => {
  it('is a no-op when edit mode is already approved (idempotent)', async () => {
    const agent = makeAgent({ isPm: true, repo: undefined, id: 'pm-agent' });
    const task = makeTask({ edit_allowed: true });
    const handler = getToolFromServer(createOrchestrationMcpServer(agent, task), 'request_edit_mode');

    const result = await handler({ reason: 'tweak the config' });

    expect(result.content[0].text).toMatch(/already approved/i);
    // Must not prompt the user again or pause the task.
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
    expect(task.stop).not.toHaveBeenCalled();
  });

  it('posts an approval prompt when edit mode is not yet approved', async () => {
    const agent = makeAgent({ isPm: true, repo: undefined, id: 'pm-agent' });
    (agent as any).pendingTeardown = false;
    (agent as any).deferTeardown = vi.fn();
    const task = makeTask({ edit_allowed: false });
    const handler = getToolFromServer(createOrchestrationMcpServer(agent, task), 'request_edit_mode');

    const result = await handler({ reason: 'apply the fix' });

    expect(result.content[0].text).toMatch(/request sent|pending user approval/i);
    expect(task.postInteractiveToUser).toHaveBeenCalledTimes(1);
  });
});

// ---- Branch state helper tests ----

describe('hydrateBranchState', () => {
  it('creates branch_states from a branch name', () => {
    const attached: AttachedRepo = { github: 'org/backend' };
    hydrateBranchState(attached, 'feature/task-1', 'main');

    expect(attached.current_branch).toBe('feature/task-1');
    expect(attached.branch_states).toBeDefined();
    expect(attached.branch_states!['feature/task-1']).toEqual({
      base_branch: 'main',
    });
  });

  it('preserves existing branch_states', () => {
    const attached: AttachedRepo = {
      github: 'org/backend',
      branch_states: { 'existing': { } },
    };
    hydrateBranchState(attached, 'feature/task-2', 'main');

    expect(attached.branch_states!['existing']).toBeDefined();
    expect(attached.branch_states!['feature/task-2']).toBeDefined();
  });
});

describe('findBranchStateByPR', () => {
  it('finds branch state by PR number', () => {
    const attached: AttachedRepo = {
      github: 'org/backend',
      branch_states: {
        'feat/a': { pr_number: 42 },
        'feat/b': { pr_number: 99 },
      },
    };
    const result = findBranchStateByPR(attached, 99);
    expect(result).toBeDefined();
    expect(result!.branch).toBe('feat/b');
    expect(result!.state.pr_number).toBe(99);
  });

  it('returns undefined when no match', () => {
    const attached: AttachedRepo = {
      github: 'org/backend',
      branch_states: {
        'feat/a': { pr_number: 42 },
      },
    };
    expect(findBranchStateByPR(attached, 999)).toBeUndefined();
  });

  it('returns undefined when no branch_states', () => {
    const attached: AttachedRepo = { github: 'org/backend' };
    expect(findBranchStateByPR(attached, 42)).toBeUndefined();
  });
});
