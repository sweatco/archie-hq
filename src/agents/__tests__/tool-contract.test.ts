/**
 * MCP server contract tests.
 *
 * Verifies that every tool registered in an MCP server has a matching entry
 * in spawn.ts's allowedTools list (with the correct mcp__<server>__ prefix),
 * and vice versa. Catches mismatches between tool definitions and permissions.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRepoPRMcpServer, createPMAgentMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';

// ---- Mocks (same as pr-tools.test.ts) ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
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
      repositories: { backend: { path: '/repos/backend', worktree_path: '/wt/backend', feature_branch: 'feat/x', base_branch: 'main' } },
      edit_allowed: true, status: 'active', channels: {}, participants: [], agent_sessions: {},
    },
    touch: vi.fn(), debouncedSave: vi.fn(),
    postToUser: vi.fn(), postInteractiveToUser: vi.fn(),
    stop: vi.fn(), complete: vi.fn(), toolSendMessage: vi.fn(), getAgentStatus: vi.fn(),
    updateAgentState: vi.fn(), checkResearchBudget: vi.fn(), incrementResearchCount: vi.fn(), onResearchBudgetExceeded: vi.fn(),
  } as unknown as Task;
}

function getRegisteredToolNames(server: ReturnType<typeof createRepoPRMcpServer>): string[] {
  const raw = (server.instance as any)._registeredTools
    ?? Object.fromEntries((server.instance as any)._tools ?? []);
  return Object.keys(raw);
}

// ---- Expected tool lists (must stay in sync with spawn.ts) ----

// These are the mcp__ entries from spawn.ts for each server
const SPAWN_PM_TOOLS = [
  'mcp__pm-agent-tools__send_message_to_agent',
  'mcp__pm-agent-tools__post_to_slack',
  'mcp__pm-agent-tools__assign_task_owner',
  'mcp__pm-agent-tools__report_completion',
  'mcp__pm-agent-tools__request_edit_mode',
  'mcp__pm-agent-tools__get_agents_status',
];

const SPAWN_PR_TOOLS = [
  'mcp__pr-tools__push_branch',
  'mcp__pr-tools__create_pull_request',
  'mcp__pr-tools__get_pr_status',
  'mcp__pr-tools__get_pr_reviews',
  'mcp__pr-tools__update_pr',
  'mcp__pr-tools__add_pr_comment',
  'mcp__pr-tools__add_review_comment',
  'mcp__pr-tools__resolve_review_thread',
  'mcp__pr-tools__request_re_review',
  'mcp__pr-tools__merge_pull_request',
  'mcp__pr-tools__close_pull_request',
];

// ---- Tests ----

describe('pr-tools MCP server contract', () => {
  it('registers exactly the tools listed in spawn.ts allowedTools', () => {
    const server = createRepoPRMcpServer(makeAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__pr-tools__${n}`);

    expect(registered.sort()).toEqual(SPAWN_PR_TOOLS.sort());
  });

  it('every spawn.ts pr-tool has a matching registered tool', () => {
    const server = createRepoPRMcpServer(makeAgent(), makeTask());
    const registered = new Set(getRegisteredToolNames(server).map((n) => `mcp__pr-tools__${n}`));

    for (const tool of SPAWN_PR_TOOLS) {
      expect(registered, `spawn.ts lists '${tool}' but it is not registered in pr-tools server`).toContain(tool);
    }
  });

  it('no extra tools registered beyond what spawn.ts allows', () => {
    const server = createRepoPRMcpServer(makeAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__pr-tools__${n}`);
    const allowed = new Set(SPAWN_PR_TOOLS);

    for (const tool of registered) {
      expect(allowed, `'${tool}' is registered but not in spawn.ts allowedTools`).toContain(tool);
    }
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
