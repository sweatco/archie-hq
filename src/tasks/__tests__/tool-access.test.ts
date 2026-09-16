// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

const { config, membership, slack, revision } = vi.hoisted(() => ({
  config: vi.fn(), membership: vi.fn(), revision: { value: 0 },
  slack: { update: vi.fn(), ephemeral: vi.fn() },
}));
vi.mock('../../system/plugin-loader.js', async (original) => ({
  ...await original<typeof import('../../system/plugin-loader.js')>(), getRootMcpConfig: config,
}));
vi.mock('../../connectors/slack/user-groups.js', () => ({ slackGroupAccess: { requireMembership: membership, get version() { return revision.value; } } }));
vi.mock('../../system/plugin-sync.js', () => ({ syncPlugins: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (original) => ({
  ...await original<typeof import('../../connectors/slack/client.js')>(),
  getHomeTeamId: () => 'T1', getBotUserId: () => 'UBOT',
  getUserInfo: async (id: string) => ({ realName: id, teamId: 'T1' }),
  updateMessage: slack.update, postEphemeral: slack.ephemeral,
}));
vi.mock('../persistence.js', async (original) => ({
  ...await original<typeof import('../persistence.js')>(), appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  appendSlackMessage: vi.fn().mockResolvedValue(undefined), appendCliMessage: vi.fn().mockResolvedValue(undefined),
}));

import { Task, activeTasks } from '../task.js';
import { createToolApprovalHooks, type McpServerPolicy } from '../../agents/tool-approval-gate.js';
import { ToolAccessDenied } from '../../agents/tool-access.js';
import { liveMcpPolicy } from '../tool-access.js';
import { mountApiRoutes } from '../../connectors/api/routes.js';
import { registerToolApprovalHandlers } from '../../connectors/slack/events.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';
import { appendCliMessage } from '../persistence.js';

const TaskCtor = Task as unknown as new (id: string, metadata: TaskMetadata, pmDef: AgentDef) => Task;
const pmDef = { id: 'pm-agent', key: 'pm-agent' } as AgentDef;
let policy: McpServerPolicy;
let task: Task;
let save: ReturnType<typeof vi.fn<(flush?: boolean) => Promise<void>>>;
const connection = { type: 'http', url: 'https://mcp.example.com/mcp' };
const approver = { id: 'U2', name: 'Lead', principal: { teamId: 'T1', userId: 'U2' } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  revision.value = 0;
  policy = { default: 'ask', tiers: {}, titles: {}, access: { default: { approverGroups: ['S2'] } } };
  config.mockImplementation(() => ({ servers: { release: connection }, policies: { release: policy }, descriptions: {} }));
  membership.mockReset().mockImplementation(async (principal, groups) => {
    if (!principal || !groups.some((group: string) => ({ S1: ['U1'], S2: ['U2'] }[group]?.includes(principal.userId)))) {
      throw new ToolAccessDenied(`Requires membership in ${groups.join(' or ')}`);
    }
    return () => {};
  });
  const id = `test-${randomUUID()}`;
  task = new TaskCtor(id, {
    task_id: id, channels: {}, default_channel: null,
    agent_sessions: {}, repositories: [], status: 'in_progress', created_at: '', updated_at: '',
  }, pmDef);
  save = vi.fn().mockResolvedValue(undefined);
  task.save = save;
  task.sendMessage = vi.fn().mockResolvedValue(undefined);
  task.postInteractiveToUser = vi.fn().mockResolvedValue(undefined);
  task.suspendStatus = vi.fn();
  task.debouncedSave = vi.fn();
  slack.ephemeral.mockClear(); slack.update.mockClear();
});
afterEach(() => { activeTasks.clear(); vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

async function invoke(input: unknown = { release: 1 }, agentId = 'pm-agent') {
  const hook = createToolApprovalHooks({ release: policy }, {
    currentPolicy: () => liveMcpPolicy({ release: connection }),
    serverNames: ['release'],
    authorize: (call, current) => task.authorizeToolCall(call, current),
    consumeApproval: (digest, access) => task.consumeToolApproval(digest, access),
    requestApproval: (request) => task.requestToolApproval(agentId, request),
  })[0].hooks[0];
  return await hook({ tool_name: 'mcp__release__publish', tool_input: input } as any, undefined as any, {} as any);
}
function ref(): string { return task.metadata.pending_tool_approval!.approval_ref!; }
function denied(result: unknown) { expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } }); }

describe('group-restricted MCP execution', () => {
  it('requires only approver membership, then spends once across delegated agents', async () => {
    denied(await invoke());
    expect(membership).not.toHaveBeenCalled();
    await expect(task.handleToolCallApproval(approver, ref())).resolves.toBe('resolved');
    expect(await invoke({ release: 1 }, 'release-agent')).toEqual({ continue: true });
    expect(task.metadata.approved_tool_calls).toHaveLength(0);
    denied(await invoke());
  });

  it('refuses a claimed API approver without a verified principal and leaves the prompt intact', async () => {
    await invoke();
    const pending = task.metadata.pending_tool_approval;
    await expect(task.handleToolCallApproval({ id: 'U2', name: 'Lead' }, ref())).rejects.toThrow(ToolAccessDenied);
    expect(task.metadata.pending_tool_approval).toBe(pending);
    expect(task.metadata.approved_tool_calls).toBeUndefined();
  });

  it('runs allow-tier tools without membership checks or approval prompts', async () => {
    policy.default = 'allow';
    expect(await invoke()).toEqual({ continue: true });
    expect(membership).not.toHaveBeenCalled();
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
  });

  it('requires explicit approval for a scheduled task', async () => {
    policy.access = { default: { approverGroups: ['S2'] } };
    task.metadata.triggered_by = 'trg-scheduled';
    denied(await invoke());
    await task.handleToolCallApproval(approver, ref());
    expect(await invoke()).toEqual({ continue: true });
  });

  it('requires a fresh prompt if policy changed while approval was pending', async () => {
    await invoke();
    const old = ref();
    policy.access!.default!.approverGroups = ['S3'];
    await expect(task.handleToolCallApproval(approver, ref())).rejects.toThrow('policy changed');
    expect(task.metadata.approved_tool_calls).toBeUndefined();
    denied(await invoke());
    expect(ref()).not.toBe(old);
    expect(task.metadata.pending_tool_approval?.access?.rule.approverGroups).toEqual(['S3']);
    await expect(task.handleToolCallApproval(approver, old)).resolves.toBe('stale');
  });

  it('does not let a legacy pending call skip newly introduced group requirements', async () => {
    const access = policy.access;
    delete policy.access;
    await invoke();
    const oldRef = task.metadata.pending_tool_approval!.digest;
    policy.access = access;
    await expect(task.handleToolCallApproval(approver, oldRef)).rejects.toThrow('now requires group');
    denied(await invoke());
    expect(task.metadata.pending_tool_approval?.access).toBeDefined();
  });

  it('rechecks membership at spend and refuses after removal', async () => {
    await invoke();
    await task.handleToolCallApproval(approver, ref());
    membership.mockRejectedValue(new ToolAccessDenied('User removed from group'));
    denied(await invoke());
    expect(task.metadata.approved_tool_calls).toHaveLength(1);
  });

  it('does not redirect a grant to changed arguments', async () => {
    await invoke();
    await task.handleToolCallApproval(approver, ref());
    denied(await invoke({ release: 2 }));
  });

  it('mints only one grant for concurrent approvals and spends once for concurrent retries', async () => {
    await invoke(); const prompt = ref();
    const results = await Promise.all([task.handleToolCallApproval(approver, prompt), task.handleToolCallApproval(approver, prompt)]);
    expect(results.sort()).toEqual(['resolved', 'stale']);
    const calls = await Promise.all([invoke(), invoke()]);
    expect(calls.filter((result) => 'continue' in result && result.continue)).toHaveLength(1);
  });

  it('does not let an old button approve a later identical operation', async () => {
    await invoke(); const old = ref();
    await task.handleToolCallApproval(approver, old); await invoke();
    await invoke();
    expect(ref()).not.toBe(old);
    await expect(task.handleToolCallApproval(approver, old)).resolves.toBe('stale');
  });

  it('preserves bindings on reload and refuses a grant moved to another task', async () => {
    await invoke(); await task.handleToolCallApproval(approver, ref());
    const persisted = JSON.stringify(task.metadata);
    task = new TaskCtor(task.taskId, JSON.parse(persisted), pmDef);
    task.save = save;
    expect(await invoke()).toEqual({ continue: true });
    task = new TaskCtor(`other-${randomUUID()}`, JSON.parse(persisted), pmDef);
    const moved = task.metadata.approved_tool_calls![0];
    await expect(task.consumeToolApproval(moved.digest, moved.access)).rejects.toThrow('policy changed');
  });

  it('denies a group change during asynchronous approval verification without consuming the prompt', async () => {
    await invoke();
    const pending = task.metadata.pending_tool_approval;
    membership.mockImplementationOnce(async () => { revision.value++; return () => {}; });
    await expect(task.handleToolCallApproval(approver, ref())).rejects.toThrow('membership changed');
    expect(task.metadata.pending_tool_approval).toBe(pending);
    expect(task.metadata.approved_tool_calls).toBeUndefined();
  });

  it('fails closed if durable consumption fails or a group event arrives during the write', async () => {
    await invoke(); await task.handleToolCallApproval(approver, ref());
    save.mockRejectedValueOnce(new Error('disk full'));
    denied(await invoke());
    expect(task.metadata.approved_tool_calls).toHaveLength(0);
    await invoke(); await task.handleToolCallApproval(approver, ref());
    save.mockImplementationOnce(async () => { revision.value++; });
    denied(await invoke());
  });

  it('preserves the specific approval when another participant adds input', async () => {
    await invoke(); await task.handleToolCallApproval(approver, ref());
    await task.append({ channel: { id: 'C1', name: 'release' }, threadId: '1', currentMessageTs: '2', shared: false, rootAuthorWasBot: false,
      messages: [{ user: { id: 'U3', username: 'other', realName: 'Other', teamId: 'T1' }, ownText: 'publish', ts: '2' }] });
    expect(await invoke()).toEqual({ continue: true });
    expect(task.metadata.approved_tool_calls).toHaveLength(0);
  });

  it('shares inactive task metadata across concurrent loaders without reusing agent processes', async () => {
    const [a, b] = await Promise.all([Task.get(task.taskId), Task.get(task.taskId)]);
    expect(a).toBe(b);
    expect(a.metadata).toBe(task.metadata);
    const c = await Task.get(task.taskId);
    expect(c).not.toBe(a);
    expect(c.metadata).toBe(a.metadata);
  });
});

describe('approval transports', () => {
  it('keeps a pending approval when input arrives through the API', async () => {
    await invoke();
    const pending = task.metadata.pending_tool_approval;
    vi.spyOn(Task, 'get').mockResolvedValue(task);
    let router: any;
    mountApiRoutes({ use: (_path: string, value: unknown) => { router = value; } } as any);
    const handler = router.stack.find((layer: any) => layer.route?.path === '/tasks/:id/message').route.stack[0].handle;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({ params: { id: task.taskId }, body: { message: 'publish' } }, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(task.metadata.pending_tool_approval).toBe(pending);
    expect(appendCliMessage).toHaveBeenCalledWith(task.taskId, 'publish');
  });

  it('returns 403 for a forged API identity, including a forged nested principal', async () => {
    await invoke();
    vi.spyOn(Task, 'get').mockResolvedValue(task);
    let router: any;
    mountApiRoutes({ use: (_path: string, value: unknown) => { router = value; } } as any);
    const handler = router.stack.find((layer: any) => layer.route?.path === '/tasks/:id/approve').route.stack[0].handle;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({ params: { id: task.taskId }, body: { type: 'tool_call', approve: true, ref: ref(), approver } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(task.metadata.pending_tool_approval).toBeDefined();
    expect(task.metadata.approved_tool_calls).toBeUndefined();
  });

  it('accepts only a verified Slack group member and leaves buttons intact on refusal', async () => {
    await invoke();
    vi.spyOn(Task, 'get').mockResolvedValue(task);
    const handlers = new Map<string, (args: any) => Promise<void>>();
    registerToolApprovalHandlers({ action: (name: string, handler: any) => { handlers.set(name, handler); } } as any);
    const args = { ack: vi.fn(), action: { value: `${task.taskId}|${ref()}` },
      body: { user: { id: 'U3' }, team: { id: 'T1' }, channel: { id: 'C1' }, message: { ts: '3' } } };
    await handlers.get('approve_tool_call')!(args);
    expect(slack.ephemeral).toHaveBeenCalled();
    expect(slack.update).not.toHaveBeenCalled();
    expect(task.metadata.pending_tool_approval).toBeDefined();
    await handlers.get('deny_tool_call')!(args);
    expect(slack.update).not.toHaveBeenCalled();
    expect(task.metadata.pending_tool_approval).toBeDefined();
    args.body.user.id = 'U2';
    await handlers.get('approve_tool_call')!(args);
    expect(task.metadata.approved_tool_calls).toHaveLength(1);
    expect(slack.update).toHaveBeenCalled();
  });
});

// An obsolete prompt can be superseded while its posting/park is still in flight.
describe('replacing an obsolete approval', () => {
  it('keeps the new pending prompt if posting the obsolete prompt fails later', async () => {
    policy.access = { default: { approverGroups: ['S2'] } };
    let rejectOld!: (error: Error) => void;
    let entered!: () => void;
    const posting = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(task.postInteractiveToUser).mockImplementationOnce(() => {
      entered();
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    });
    const oldCall = invoke();
    await posting;
    const oldRef = ref();
    policy.titles.publish = 'Updated consequence';
    await invoke();
    const replacement = task.metadata.pending_tool_approval;
    expect(replacement?.approval_ref).not.toBe(oldRef);
    rejectOld(new Error('Old Slack post failed'));
    await oldCall;
    expect(task.metadata.pending_tool_approval).toBe(replacement);
  });

  it('does not re-arm an obsolete prompt when its post succeeds after the replacement was approved', async () => {
    const { Agent } = await import('../../agents/agent.js');
    const pm = new Agent(pmDef);
    task.agent = pm;
    let finishOld!: () => void;
    let entered!: () => void;
    const posting = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(task.postInteractiveToUser).mockImplementationOnce(() => {
      entered();
      return new Promise<void>((resolve) => { finishOld = resolve; });
    });
    const oldCall = invoke();
    await posting;
    policy.titles.publish = 'Updated consequence';
    await invoke();
    await task.handleToolCallApproval(approver, ref());
    vi.mocked(task.suspendStatus).mockClear();
    finishOld();
    await oldCall;
    expect(task.metadata.pending_tool_approval).toBeUndefined();
    expect(pm.pendingTeardown).toBeUndefined();
    expect(task.suspendStatus).not.toHaveBeenCalled();
  });

  it('clears the PM park when a policy change replaces and approves its prompt', async () => {
    policy.access = { default: { approverGroups: ['S2'] } };
    const { Agent } = await import('../../agents/agent.js');
    const pm = new Agent(pmDef);
    task.agent = pm;
    await invoke();
    expect(pm.pendingTeardown).toBeDefined();
    policy.titles.publish = 'Updated consequence';
    await invoke();
    await task.handleToolCallApproval(approver, ref());
    expect(pm.pendingTeardown).toBeUndefined();
  });
});
