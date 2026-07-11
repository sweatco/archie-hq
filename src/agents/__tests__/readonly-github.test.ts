/**
 * Readonly-v1 enforcement for GitHub-born tasks (AC10).
 *
 * request_edit_mode / request_max_mode must fail fast on a GitHub-born task —
 * no approval prompt, no pause, edit_allowed never set — while Slack-born
 * behavior stays unchanged. Tool handlers are called directly (no LLM/MCP
 * transport), pr-tools.test.ts factory style.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// task.js must be the FIRST runtime import: task.ts ↔ persistence.ts are
// circular, and only when task.js's evaluation triggers the persistence mock
// factory does task.ts bind the mocked appendAgentFinding (importing
// persistence first would link task.ts against the real module mid-cycle).
import { Task as RealTask } from '../../tasks/task.js';
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

vi.mock('../../tasks/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tasks/persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: vi.fn(),
    agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
    agentMessage: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    plain: vi.fn(),
    slack: vi.fn(),
    server: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
  scanAgentDefs: vi.fn().mockReturnValue([]),
  synthesizeDynamicAgentDef: vi.fn(),
  buildPeerListForSender: vi.fn().mockReturnValue(''),
}));

import type { Application, Request, Response } from 'express';
import { appendAgentFinding } from '../../tasks/persistence.js';
import { emitEvent } from '../../system/event-bus.js';
import { mountApiRoutes } from '../../connectors/api/routes.js';
import { buildGitHubBornContextLine } from '../spawn.js';

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

// ---- PM spawn context line (8.2) ----

describe('buildGitHubBornContextLine', () => {
  it('names the origin thread, the delivery surface, and the readonly rule', () => {
    const line = buildGitHubBornContextLine({ channels: GITHUB_CHANNELS } as Task['metadata']);

    expect(line).toContain('acme/backend#42');
    expect(line).toContain('https://github.com/acme/backend/issues/42');
    expect(line).toContain('post_to_user');
    expect(line).toContain('read-only for its lifetime (v1)');
    expect(line).toContain('never call request_edit_mode or request_max_mode');
    expect(line).toContain('start from Slack');
  });

  it('builds a /pull/ URL for PR-born threads', () => {
    const channels = {
      'github:acme/backend#7': { type: 'github', repo: 'acme/backend', issue_number: 7, is_pr: true },
    } as unknown as Task['metadata']['channels'];
    expect(buildGitHubBornContextLine({ channels } as Task['metadata'])).toContain('https://github.com/acme/backend/pull/7');
  });

  it('is null for tasks without a github channel', () => {
    expect(buildGitHubBornContextLine({ channels: SLACK_CHANNELS } as Task['metadata'])).toBeNull();
  });
});

// ---- handleEditModeApproval guard (7.2) ----

/** Fake task carrying the real handleEditModeApproval (called with this=fake). */
function makeApprovalTask(channels: Task['metadata']['channels']) {
  const metadata = {
    task_id: 'task-123',
    task_owner: null,
    participants: [],
    channels,
    default_channel: Object.keys(channels)[0] ?? null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
  } as unknown as Task['metadata'];
  return {
    taskId: 'task-123',
    metadata,
    agentProcesses: new Map(),
    save: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isGitHubBorn(): boolean {
      return Object.values(metadata.channels).some((ch) => (ch as { type: string }).type === 'github');
    },
    handleEditModeApproval: RealTask.prototype.handleEditModeApproval,
    handleEditModeDenial: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleEditModeApproval on a GitHub-born task', () => {
  it('rejects: edit_allowed never set, no approver recorded, decision finding appended', async () => {
    const task = makeApprovalTask(GITHUB_CHANNELS);

    const disposition = await task.handleEditModeApproval({ id: 'U1', name: 'Dana' });

    expect(disposition).toBe('rejected_readonly');
    expect(task.metadata.edit_allowed).toBeUndefined();
    expect(task.metadata.edit_approved_by).toBeUndefined();
    expect(task.save).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('GitHub-born tasks are read-only in v1'), 'decision',
    );
  });

  it('approves a Slack-born task exactly as before', async () => {
    const task = makeApprovalTask(SLACK_CHANNELS);

    const disposition = await task.handleEditModeApproval({ id: 'U1', name: 'Dana' });

    expect(disposition).toBe('approved');
    expect(task.metadata.edit_allowed).toBe(true);
    expect(task.metadata.edit_approved_by).toEqual({ id: 'U1', name: 'Dana' });
    expect(task.save).toHaveBeenCalledWith(true);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', 'Edit mode approved by Dana', 'decision',
    );
    expect(task.sendMessage).toHaveBeenCalled();
  });
});

// ---- Approve API route (7.2, merge-approval-surfaces style) ----

type RouteHandler = (req: Request, res: Response) => Promise<void>;

function captureApproveRoute(): RouteHandler {
  const fakeApp = { use: vi.fn() };
  mountApiRoutes(fakeApp as unknown as Application);
  const router = fakeApp.use.mock.calls[0]![1] as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RouteHandler }> } }>;
  };
  const layer = router.stack.find((l) => l.route?.path === '/tasks/:id/approve' && l.route.methods['post']);
  return layer!.route!.stack[0]!.handle;
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('POST /tasks/:id/approve edit_mode on a GitHub-born task', () => {
  it('returns 403, leaves edit_allowed unset, and emits no approval:resolved', async () => {
    const task = makeApprovalTask(GITHUB_CHANNELS);
    const getSpy = vi.spyOn(RealTask, 'get').mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(
      { params: { id: 'task-123' }, body: { type: 'edit_mode', approve: true } } as unknown as Request,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'GitHub-born tasks are read-only in v1' });
    expect(res.json).not.toHaveBeenCalledWith({ ok: true });
    expect(task.metadata.edit_allowed).toBeUndefined();
    expect(vi.mocked(emitEvent)).not.toHaveBeenCalledWith(
      'approval:resolved', expect.anything(), expect.anything(),
    );
    getSpy.mockRestore();
  });

  it('still resolves edit_mode approval for a Slack-born task with ok + approval:resolved', async () => {
    const task = makeApprovalTask(SLACK_CHANNELS);
    const getSpy = vi.spyOn(RealTask, 'get').mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(
      { params: { id: 'task-123' }, body: { type: 'edit_mode', approve: true } } as unknown as Request,
      res,
    );

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(task.metadata.edit_allowed).toBe(true);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith(
      'approval:resolved', 'task-123', { type: 'edit_mode', approve: true },
    );
    getSpy.mockRestore();
  });
});
