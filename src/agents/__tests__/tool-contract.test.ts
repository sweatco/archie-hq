/**
 * MCP server contract tests.
 *
 * Verifies that every tool registered in an MCP server has a matching entry
 * in spawn.ts's allowedTools list (with the correct mcp__<server>__ prefix),
 * and vice versa. Catches mismatches between tool definitions and permissions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createRepoToolsMcpServer,
  createPMAgentMcpServer,
} from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';

// ---- Mocks (same as pr-tools.test.ts) ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
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
    agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(),
    system: vi.fn(), error: vi.fn(), warn: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue(['backend-agent', 'mobile-agent']),
}));

// ---- Helpers ----

function makeAgent(overrides: Partial<AgentDef> = {}): Agent {
  return {
    def: {
      id: 'backend-agent', key: 'backend', role: 'Backend', expertise: 'Node',
      track: 'repo', pluginName: 'engineering',
      repo: { githubRepo: 'org/backend', repoKey: 'backend', defaultPath: '/repos/backend' },
      ...overrides,
    },
    queue: {} as any,
    session: { active: false },
  } as Agent;
}

function makeTask(): Task {
  return {
    taskId: 'task-123',
    metadata: {
      repositories: {
        backend: {
          path: '/repos/backend',
          worktree_path: '/wt/backend',
          feature_branch: 'feat/x',
          base_branch: 'main',
          current_branch: 'feat/x',
          branch_states: {
            'feat/x': { owned: true, head_sha: 'abc', base_branch: 'main' },
          },
        },
      },
      edit_allowed: true, status: 'active', channels: {}, participants: [], agent_sessions: {},
    },
    touch: vi.fn(), debouncedSave: vi.fn(),
    postToUser: vi.fn(), postInteractiveToUser: vi.fn(),
    stop: vi.fn(), complete: vi.fn(), toolSendMessage: vi.fn(), getAgentStatus: vi.fn(),
    updateAgentState: vi.fn(), checkResearchBudget: vi.fn(), incrementResearchCount: vi.fn(), onResearchBudgetExceeded: vi.fn(),
  } as unknown as Task;
}

function getRegisteredToolNames(server: ReturnType<typeof createRepoToolsMcpServer>): string[] {
  const raw = (server.instance as any)._registeredTools
    ?? Object.fromEntries((server.instance as any)._tools ?? []);
  return Object.keys(raw);
}

// ---- Expected tool lists (must stay in sync with spawn.ts) ----

const SPAWN_PM_TOOLS = [
  'mcp__pm-agent-tools__send_message_to_agent',
  'mcp__pm-agent-tools__post_to_slack',
  'mcp__pm-agent-tools__assign_task_owner',
  'mcp__pm-agent-tools__report_completion',
  'mcp__pm-agent-tools__request_edit_mode',
  'mcp__pm-agent-tools__get_agents_status',
];

const SPAWN_REPO_TOOLS = [
  // Git workflow
  'mcp__repo-tools__fetch',
  'mcp__repo-tools__switch_branch',
  'mcp__repo-tools__create_branch',
  'mcp__repo-tools__list_branches',
  // PR read
  'mcp__repo-tools__list_prs',
  'mcp__repo-tools__get_pr',
  'mcp__repo-tools__get_pr_status',
  'mcp__repo-tools__get_pr_reviews',
  // PR write
  'mcp__repo-tools__push_branch',
  'mcp__repo-tools__create_pull_request',
  'mcp__repo-tools__update_pr',
  'mcp__repo-tools__add_pr_comment',
  'mcp__repo-tools__add_review_comment',
  'mcp__repo-tools__resolve_review_thread',
  'mcp__repo-tools__request_re_review',
  'mcp__repo-tools__merge_pull_request',
  'mcp__repo-tools__close_pull_request',
];

// ---- Tests ----

describe('repo-tools MCP server contract', () => {
  it('registers exactly the tools referenced in spawn.ts', () => {
    const server = createRepoToolsMcpServer(makeAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__repo-tools__${n}`);

    expect(registered.sort()).toEqual(SPAWN_REPO_TOOLS.sort());
  });
});

describe('pm-agent-tools MCP server contract', () => {
  it('registers exactly the tools listed in spawn.ts allowedTools', () => {
    const agent = makeAgent({ track: 'pm', repo: undefined, id: 'pm-agent' });
    const server = createPMAgentMcpServer(agent, makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__pm-agent-tools__${n}`);

    expect(registered.sort()).toEqual(SPAWN_PM_TOOLS.sort());
  });
});
