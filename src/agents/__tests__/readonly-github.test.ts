/**
 * Readonly-v1 enforcement for GitHub-born tasks (AC10).
 *
 * request_edit_mode / request_max_mode must fail fast on a GitHub-born task —
 * no approval prompt, no pause, edit_allowed never set — while Slack-born
 * behavior stays unchanged. Tool handlers are called directly (no LLM/MCP
 * transport), pr-tools.test.ts factory style.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

vi.mock('../../connectors/github/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/github/client.js')>();
  return {
    parseCheckRef: actual.parseCheckRef,
    getGitHubClient: vi.fn(),
    fetchOrigin: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn(),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getAgentClonePath: vi.fn(),
  getReposPath: vi.fn(),
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
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
}));

import { appendAgentFinding } from '../../tasks/persistence.js';

const GITHUB_CHANNELS = {
  'github:acme/backend#42': { type: 'github', repo: 'acme/backend', issue_number: 42, is_pr: false },
} as unknown as Task['metadata']['channels'];

const SLACK_CHANNELS = {
  'slack:C1:111.222': {
    type: 'slack', thread_id: '111.222', channel_id: 'C1', channel_name: 'general', last_processed_ts: '111.222',
  },
} as unknown as Task['metadata']['channels'];

function makeAgent(): Agent {
  return {
    def: {
      id: 'pm-agent',
      key: 'pm',
      role: 'PM',
      expertise: 'Coordination',
      pluginName: 'pm',
      visibility: 'global',
    },
    queue: {} as never,
    session: { active: false },
    pendingTeardown: undefined,
    deferTeardown: vi.fn(),
    clearPendingTeardown: vi.fn(),
  } as unknown as Agent;
}

function makeTask(channels: Task['metadata']['channels']): Task {
  const metadata = {
    task_id: 'task-123',
    task_owner: null,
    participants: [],
    channels,
    default_channel: Object.keys(channels)[0] ?? null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
  };
  return {
    taskId: 'task-123',
    team: [],
    metadata,
    agentProcesses: new Map(),
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    suspendStatus: vi.fn(),
    postToUser: vi.fn().mockResolvedValue(null),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isGitHubBorn(): boolean {
      return Object.values(metadata.channels).some((ch) => (ch as { type: string }).type === 'github');
    },
  } as unknown as Task;
}

function getToolFromServer(server: unknown, toolName: string) {
  const instance = (server as { instance: Record<string, unknown> }).instance;
  const tools: Record<string, { callback?: unknown; handler?: unknown }> =
    (instance as { _registeredTools?: Record<string, never> })._registeredTools
    ?? Object.fromEntries(((instance as { _tools?: Iterable<[string, never]> })._tools ?? []) as never);
  if (!tools[toolName]) throw new Error(`Tool '${toolName}' not found in server`);
  return (tools[toolName].callback ?? tools[toolName].handler) as (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

function getOrchTool(agent: Agent, task: Task, toolName: string) {
  return getToolFromServer(createOrchestrationMcpServer(agent, task), toolName);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['request_edit_mode', 'read-only in v1'],
  ['request_max_mode', 'no approval surface'],
] as const)('%s on a GitHub-born task (AC10)', (toolName, declineMarker) => {
  it('declines fast: explanation, no prompt, no pause, edit_allowed never set', async () => {
    const agent = makeAgent();
    const task = makeTask(GITHUB_CHANNELS);
    const tool = getOrchTool(agent, task, toolName);

    const result = await tool({ reason: 'need to change code' }, {});

    expect(result.content[0]!.text).toContain(declineMarker);
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
    expect(task.suspendStatus).not.toHaveBeenCalled();
    expect(agent.deferTeardown).not.toHaveBeenCalled();
    expect(task.metadata.edit_allowed).toBeUndefined();
    expect(appendAgentFinding).not.toHaveBeenCalled();
  });
});

describe('request_edit_mode on a Slack-born task', () => {
  it('behaves exactly as before: posts the approval prompt and pauses', async () => {
    const agent = makeAgent();
    const task = makeTask(SLACK_CHANNELS);
    const tool = getOrchTool(agent, task, 'request_edit_mode');

    const result = await tool({ reason: 'need to change code' }, {});

    expect(result.content[0]!.text).toContain('Edit mode request sent');
    expect(task.postInteractiveToUser).toHaveBeenCalledWith(
      expect.stringContaining('Edit mode request'), expect.anything(), 'edit_mode', undefined,
    );
    expect(task.suspendStatus).toHaveBeenCalled();
    expect(agent.deferTeardown).toHaveBeenCalled();
  });
});

describe('request_max_mode on a Slack-born task', () => {
  it('behaves exactly as before: posts the approval prompt and pauses', async () => {
    const agent = makeAgent();
    const task = makeTask(SLACK_CHANNELS);
    const tool = getOrchTool(agent, task, 'request_max_mode');

    const result = await tool({ reason: 'hard task' }, {});

    expect(result.content[0]!.text).toContain('Max mode request sent');
    expect(task.postInteractiveToUser).toHaveBeenCalledWith(
      expect.stringContaining('Max mode request'), expect.anything(), 'max_mode', undefined,
    );
    expect(task.suspendStatus).toHaveBeenCalled();
    expect(agent.deferTeardown).toHaveBeenCalled();
  });
});
