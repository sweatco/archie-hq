/**
 * Unit tests for GitHub PR tool handlers.
 *
 * Tests the business logic inside each tool (mergeability checks, error paths,
 * success paths) by calling handlers directly — no LLM, no MCP transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRepoToolsMcpServer,
  createPMAgentMcpServer,
  mirrorLegacyFields,
  hydrateBranchState,
  findBranchStateByPR,
} from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';
import type { RepositoryInfo } from '../../types/task.js';

// ---- Module mocks ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn(),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../connectors/github/worktree.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  isSymlink: vi.fn().mockResolvedValue(false),
  setupWorktree: vi.fn().mockResolvedValue({ worktree_path: '/wt', feature_branch: 'feat/x', base_branch: 'main' }),
  worktreeExists: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
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
}));

// ---- Helpers ----

import { getGitHubClient } from '../../connectors/github/client.js';

const mockGitHubClient = {
  getPRStatus: vi.fn(),
  mergePullRequest: vi.fn(),
  closePullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  getPRReviews: vi.fn(),
  updatePR: vi.fn(),
  addPRComment: vi.fn(),
  addReviewComment: vi.fn(),
  resolveReviewThread: vi.fn(),
  requestReReview: vi.fn(),
};

function makeAgent(overrides: Partial<AgentDef> = {}): Agent {
  return {
    def: {
      id: 'backend-agent',
      key: 'backend',
      role: 'Backend engineer',
      expertise: 'Node.js',
      track: 'repo',
      pluginName: 'engineering',
      repo: {
        githubRepo: 'org/backend',
        repoKey: 'backend',
        defaultPath: '/repos/backend',
        baseBranch: 'main',
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
    metadata: {
      repositories: {
        backend: {
          path: '/repos/backend',
          worktree_path: '/worktrees/backend',
          feature_branch: 'feature/task-123',
          base_branch: 'main',
          current_branch: 'feature/task-123',
          branch_states: {
            'feature/task-123': {
              owned: true,
              head_sha: 'abc123',
              base_branch: 'main',
            },
          },
        },
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

    const agent = makeAgent({ repo: { githubRepo: 'org/mobile', repoKey: 'mobile', defaultPath: '/repos/mobile' } });
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

describe('PM agent tools', () => {
  it('does not include any PR tools', () => {
    const agent = makeAgent({ track: 'pm', repo: undefined, id: 'pm-agent' });
    const task = makeTask();
    const server = createPMAgentMcpServer(agent, task);

    const registeredTools = Object.keys(
      (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []),
    );

    const prToolNames = [
      'push_branch', 'create_pull_request', 'get_pr_status', 'get_pr_reviews',
      'update_pr', 'add_pr_comment', 'add_review_comment', 'resolve_review_thread',
      'request_re_review', 'merge_pull_request', 'close_pull_request',
    ];

    for (const prTool of prToolNames) {
      expect(registeredTools, `PM server should not have tool: ${prTool}`).not.toContain(prTool);
    }
  });
});

// ---- Branch state helper tests ----

describe('mirrorLegacyFields', () => {
  it('mirrors current branch state to top-level fields', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      current_branch: 'feature/task-1',
      branch_states: {
        'feature/task-1': {
          owned: true, head_sha: 'abc', base_branch: 'main', pr_number: 42, last_processed_comment_id: 10,
        },
      },
    };
    mirrorLegacyFields(repoInfo);
    expect(repoInfo.feature_branch).toBe('feature/task-1');
    expect(repoInfo.base_branch).toBe('main');
    expect(repoInfo.pr_number).toBe(42);
    expect(repoInfo.last_processed_comment_id).toBe(10);
  });

  it('mirrors only current branch when multiple exist', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      current_branch: 'fix/bug',
      branch_states: {
        'feature/task-1': { owned: true, head_sha: 'abc', pr_number: 42 },
        'fix/bug': { owned: true, head_sha: 'def', pr_number: 99, base_branch: 'develop' },
      },
    };
    mirrorLegacyFields(repoInfo);
    expect(repoInfo.pr_number).toBe(99);
    expect(repoInfo.base_branch).toBe('develop');
    expect(repoInfo.feature_branch).toBe('fix/bug');
  });

  it('does nothing when no current branch', () => {
    const repoInfo: RepositoryInfo = { path: '/repos/backend' };
    mirrorLegacyFields(repoInfo);
    expect(repoInfo.feature_branch).toBeUndefined();
    expect(repoInfo.pr_number).toBeUndefined();
  });
});

describe('hydrateBranchState', () => {
  it('creates branch_states from a branch name', () => {
    const repoInfo: RepositoryInfo = { path: '/repos/backend' };
    hydrateBranchState(repoInfo, 'feature/task-1', 'main');

    expect(repoInfo.current_branch).toBe('feature/task-1');
    expect(repoInfo.branch_states).toBeDefined();
    expect(repoInfo.branch_states!['feature/task-1']).toEqual({
      owned: true, head_sha: '', base_branch: 'main',
    });
    // Legacy fields mirrored
    expect(repoInfo.feature_branch).toBe('feature/task-1');
    expect(repoInfo.base_branch).toBe('main');
  });

  it('preserves existing branch_states', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      branch_states: { 'existing': { owned: false, head_sha: 'xyz' } },
    };
    hydrateBranchState(repoInfo, 'feature/task-2', 'main');

    expect(repoInfo.branch_states!['existing']).toBeDefined();
    expect(repoInfo.branch_states!['feature/task-2']).toBeDefined();
  });
});

describe('findBranchStateByPR', () => {
  it('finds branch state by PR number', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      branch_states: {
        'feat/a': { owned: true, head_sha: 'abc', pr_number: 42 },
        'feat/b': { owned: true, head_sha: 'def', pr_number: 99 },
      },
    };
    const result = findBranchStateByPR(repoInfo, 99);
    expect(result).toBeDefined();
    expect(result!.branch).toBe('feat/b');
    expect(result!.state.pr_number).toBe(99);
  });

  it('returns undefined when no match', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      branch_states: {
        'feat/a': { owned: true, head_sha: 'abc', pr_number: 42 },
      },
    };
    expect(findBranchStateByPR(repoInfo, 999)).toBeUndefined();
  });

  it('returns undefined when no branch_states', () => {
    const repoInfo: RepositoryInfo = { path: '/repos/backend' };
    expect(findBranchStateByPR(repoInfo, 42)).toBeUndefined();
  });
});

describe('legacy hydration', () => {
  it('old metadata with feature_branch hydrates into branch_states', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      feature_branch: 'feature/task-old',
      base_branch: 'master',
      pr_number: 55,
      last_processed_comment_id: 20,
    };

    // Simulate the hydration from spawn.ts
    if (repoInfo.feature_branch && !repoInfo.branch_states) {
      hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
      const state = repoInfo.branch_states![repoInfo.feature_branch];
      state.pr_number = repoInfo.pr_number;
      state.last_processed_comment_id = repoInfo.last_processed_comment_id;
    }

    expect(repoInfo.current_branch).toBe('feature/task-old');
    expect(repoInfo.branch_states!['feature/task-old']).toEqual({
      owned: true,
      head_sha: '',
      base_branch: 'master',
      pr_number: 55,
      last_processed_comment_id: 20,
    });
  });

  it('new metadata with branch_states skips hydration', () => {
    const repoInfo: RepositoryInfo = {
      path: '/repos/backend',
      feature_branch: 'feature/task-new',
      current_branch: 'feature/task-new',
      branch_states: {
        'feature/task-new': { owned: true, head_sha: 'abc', base_branch: 'main', pr_number: 10 },
      },
    };

    // Hydration guard
    if (repoInfo.feature_branch && !repoInfo.branch_states) {
      hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
    }

    // Should be unchanged
    expect(repoInfo.branch_states!['feature/task-new'].pr_number).toBe(10);
    expect(repoInfo.branch_states!['feature/task-new'].head_sha).toBe('abc');
  });

  it('empty metadata without feature_branch does not crash', () => {
    const repoInfo: RepositoryInfo = { path: '/repos/backend' };

    if (repoInfo.feature_branch && !repoInfo.branch_states) {
      hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
    }

    expect(repoInfo.branch_states).toBeUndefined();
    expect(repoInfo.current_branch).toBeUndefined();
  });
});
