/**
 * Unit tests for GitHub PR tool handlers.
 *
 * Tests the business logic inside each tool (mergeability checks, error paths,
 * success paths) by calling handlers directly — no LLM, no MCP transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRepoPRMcpServer, createPMAgentMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';

// ---- Module mocks ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn(),
}));

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
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

/** Extract a tool handler from the pr-tools MCP server by name */
function getPRTool(agent: Agent, task: Task, toolName: string) {
  const server = createRepoPRMcpServer(agent, task);
  const toolDef = (server.instance as any)._registeredTools?.[toolName]
    ?? (server.instance as any)._tools?.get(toolName);

  if (!toolDef) {
    // fallback: iterate registered tools
    const tools: Record<string, any> = (server.instance as any)._registeredTools
      ?? Object.fromEntries((server.instance as any)._tools ?? []);
    if (!tools[toolName]) throw new Error(`Tool '${toolName}' not found in pr-tools server`);
    return tools[toolName].callback ?? tools[toolName].handler;
  }
  return toolDef.callback ?? toolDef.handler;
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
      state: 'merged',
      mergeable: true,
      mergeableState: 'clean',
      approved: true,
    });

    const tool = getPRTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('Cannot merge');
    expect(result.content[0].text).toContain('merged');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects when mergeableState is not clean', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open',
      mergeable: true,
      mergeableState: 'dirty',
      approved: true,
    });

    const tool = getPRTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('not ready');
    expect(result.content[0].text).toContain('dirty');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects when mergeable is false', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open',
      mergeable: false,
      mergeableState: 'blocked',
      approved: false,
    });

    const tool = getPRTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(result.content[0].text).toContain('not ready');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
  });

  it('merges when PR is open and clean', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open',
      mergeable: true,
      mergeableState: 'clean',
      approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({
      success: true,
      message: 'PR #42 merged successfully',
    });

    const tool = getPRTool(makeAgent(), makeTask(), 'merge_pull_request');
    const result = await tool({ pr_number: 42 }, {});

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 42);
    expect(result.content[0].text).toContain('merged successfully');
  });

  it('uses githubRepo from agent def', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open',
      mergeable: true,
      mergeableState: 'clean',
      approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({
      success: true,
      message: 'PR #7 merged successfully',
    });

    const agent = makeAgent({ repo: { githubRepo: 'org/mobile', repoKey: 'mobile', defaultPath: '/repos/mobile' } });
    const tool = getPRTool(agent, makeTask(), 'merge_pull_request');
    await tool({ pr_number: 7 }, {});

    expect(mockGitHubClient.getPRStatus).toHaveBeenCalledWith('org/mobile', 7);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/mobile', 7);
  });

  it('throws when GitHub client is not configured', async () => {
    vi.mocked(getGitHubClient).mockReturnValue(null as any);

    const tool = getPRTool(makeAgent(), makeTask(), 'merge_pull_request');
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

    const tool = getPRTool(makeAgent(), makeTask(), 'close_pull_request');
    const result = await tool({ pr_number: 99 }, {});

    expect(mockGitHubClient.closePullRequest).toHaveBeenCalledWith('org/backend', 99);
    expect(result.content[0].text).toContain('Closed PR #99');
  });
});

describe('get_pr_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
  });

  it('returns formatted status', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open',
      mergeable: true,
      mergeableState: 'clean',
      approved: true,
    });

    const tool = getPRTool(makeAgent(), makeTask(), 'get_pr_status');
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
      'request_re_review', 'merge_pull_request', 'close_pull_request', 'trigger_merge_check',
    ];

    for (const prTool of prToolNames) {
      expect(registeredTools, `PM server should not have tool: ${prTool}`).not.toContain(prTool);
    }
  });
});
