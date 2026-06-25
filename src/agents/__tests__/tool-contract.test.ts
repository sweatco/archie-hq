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
  createBaseAgentMcpServer,
  createCommsMcpServer,
  createOrchestrationMcpServer,
  createSchedulingMcpServer,
} from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';

// ---- Mocks (same as pr-tools.test.ts) ----

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
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
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue(['backend-agent', 'mobile-agent']),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../connectors/slack/client.js', () => ({
  findSlackUsers: vi.fn().mockResolvedValue([]),
  findSlackChannels: vi.fn().mockResolvedValue([]),
}));

// ---- Helpers ----

function makeAgent(overrides: Partial<AgentDef> = {}): Agent {
  return {
    def: {
      id: 'backend-agent', key: 'backend', role: 'Backend', expertise: 'Node',
      pluginName: 'engineering', visibility: 'global',
      repo: { repos: [{ github: 'org/backend', baseBranch: 'main' }], primary: 'org/backend' },
      ...overrides,
    },
    queue: {} as any,
    session: { active: false },
  } as Agent;
}

function makeTask(): Task {
  return {
    taskId: 'task-123',
    team: [
      {
        id: 'backend-agent', key: 'backend', role: 'r', expertise: 'e',
        pluginName: 'engineering',
        repo: { repos: [{ github: 'org/backend', baseBranch: 'main' }], primary: 'org/backend' },
      },
    ],
    metadata: {
      repositories: {
        'backend-agent': [{
          github: 'org/backend',
          clone_path: '/wt/backend',
          current_branch: 'feat/x',
          branch_states: {
            'feat/x': { base_branch: 'main' },
          },
        }],
      },
      edit_allowed: true, status: 'active', channels: {}, participants: [], agent_sessions: {},
    },
    touch: vi.fn(), debouncedSave: vi.fn(), suspendStatus: vi.fn(),
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

const AGENT_TOOLS = [
  'mcp__agent-tools__send_message_to_agent',
  'mcp__agent-tools__log_finding',
  'mcp__agent-tools__share_artifact',
];

const PM_COMMS_TOOLS = [
  'mcp__comms-tools__post_to_user',
  'mcp__comms-tools__post_files_to_user',
  'mcp__comms-tools__find_slack_user',
  'mcp__comms-tools__find_slack_channel',
  'mcp__comms-tools__mute_channel',
  'mcp__comms-tools__react_to_message',
  'mcp__comms-tools__unreact_from_message',
  'mcp__comms-tools__get_message_reactions',
];

const PM_ORCHESTRATION_TOOLS = [
  'mcp__orchestration-tools__assign_task_owner',
  'mcp__orchestration-tools__report_completion',
  'mcp__orchestration-tools__request_edit_mode',
  'mcp__orchestration-tools__get_agents_status',
  'mcp__orchestration-tools__launch_task',
  'mcp__orchestration-tools__list_available_repos',
  'mcp__orchestration-tools__spawn_repo_agent',
];

const PM_SCHEDULING_TOOLS = [
  'mcp__scheduling-tools__parse_datetime',
  'mcp__scheduling-tools__set_reminder',
  'mcp__scheduling-tools__cancel_reminder',
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
  'mcp__repo-tools__get_pr_checks',
  'mcp__repo-tools__get_check_run',
  'mcp__repo-tools__get_pr_reviews',
  'mcp__repo-tools__get_pr_comments',
  'mcp__repo-tools__get_review_threads',
  // Security / code scanning
  'mcp__repo-tools__list_code_scanning_alerts',
  'mcp__repo-tools__get_code_scanning_alert',
  // PR write
  'mcp__repo-tools__push_branch',
  'mcp__repo-tools__create_pull_request',
  'mcp__repo-tools__update_pr',
  'mcp__repo-tools__add_pr_comment',
  'mcp__repo-tools__add_review_comment',
  'mcp__repo-tools__reply_to_review_comment',
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

describe('PM MCP server contracts', () => {
  const pmAgent = () => makeAgent({ isPm: true, repo: undefined, id: 'pm-agent' });

  it('agent-tools registers the shared base tools', () => {
    const server = createBaseAgentMcpServer(pmAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__agent-tools__${n}`);
    expect(registered.sort()).toEqual(AGENT_TOOLS.sort());
  });

  it('comms-tools registers exactly its tools', () => {
    const server = createCommsMcpServer(pmAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__comms-tools__${n}`);
    expect(registered.sort()).toEqual(PM_COMMS_TOOLS.sort());
  });

  it('orchestration-tools registers exactly its tools', () => {
    const server = createOrchestrationMcpServer(pmAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__orchestration-tools__${n}`);
    expect(registered.sort()).toEqual(PM_ORCHESTRATION_TOOLS.sort());
  });

  it('scheduling-tools registers exactly its tools', () => {
    const server = createSchedulingMcpServer(pmAgent(), makeTask());
    const registered = getRegisteredToolNames(server).map((n) => `mcp__scheduling-tools__${n}`);
    expect(registered.sort()).toEqual(PM_SCHEDULING_TOOLS.sort());
  });
});
