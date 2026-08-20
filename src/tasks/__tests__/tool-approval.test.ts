/**
 * Unit tests for the MCP tool-call approval lifecycle on Task:
 * requestToolApproval / consumeToolApproval /
 * handleToolCallApproval / handleToolCallDenial.
 *
 * Calls the real prototype methods on a minimal fake task (no LLM, no SDK,
 * no Slack) — the same harness shape as merge-approval.test.ts. The properties
 * pinned here are the ones the guard depends on: the slot's presence always
 * means "a prompt exists in Slack" (a failed post clears it), one-at-a-time
 * with a 1h age-out, grants are single-use / digest-deduped / TTL-bounded, and
 * a stale or expired click resolves to a no-op instead of minting a grant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    slack: vi.fn(), agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(),
  },
}));

vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));

import { Task } from '../task.js';
import { appendAgentFinding } from '../persistence.js';
import { APPROVAL_TTL_MS, PENDING_APPROVAL_TTL_MS } from '../../agents/tool-approval-gate.js';
import type { TaskMetadata } from '../../types/task.js';

const REQUEST = {
  digest: 'd1'.padEnd(16, '0'),
  server: 'tramline',
  tool: 'retry_workflow_run',
  summary: 'Re-run this failed CI build\n*Tool:* `tramline:retry_workflow_run`\n*Arguments:* id=`wf-1`',
  heading: 'Re-run this failed CI build',
};
const OTHER_DIGEST = 'd2'.padEnd(16, '0');

type FakeTask = {
  taskId: string;
  metadata: Partial<TaskMetadata>;
  agentProcesses: Map<string, { clearPendingTeardown: ReturnType<typeof vi.fn>; deferTeardown: ReturnType<typeof vi.fn> }>;
  debouncedSave: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  postInteractiveToUser: ReturnType<typeof vi.fn>;
  suspendStatus: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function makeFakeTask(metadata: Partial<TaskMetadata> = {}): FakeTask {
  return {
    taskId: 'task-123',
    metadata,
    agentProcesses: new Map([
      ['release-manager-agent', { clearPendingTeardown: vi.fn(), deferTeardown: vi.fn() }],
      ['pm-agent', { clearPendingTeardown: vi.fn(), deferTeardown: vi.fn() }],
    ]),
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    stop: vi.fn(),
  };
}

const request = (task: FakeTask, req = REQUEST, agent = 'release-manager-agent') =>
  Task.prototype.requestToolApproval.call(task as unknown as Task, agent, req);
const consume = (task: FakeTask, digest: string) =>
  Task.prototype.consumeToolApproval.call(task as unknown as Task, digest);
const approve = (task: FakeTask, digest: string, approver = { id: 'U1', name: 'Misha' }) =>
  Task.prototype.handleToolCallApproval.call(task as unknown as Task, approver, digest);
const deny = (task: FakeTask, digest: string) =>
  Task.prototype.handleToolCallDenial.call(task as unknown as Task, digest);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('requestToolApproval', () => {
  it('writes the slot durably, posts, and parks the requesting agent', async () => {
    const task = makeFakeTask();
    expect(await request(task)).toBe('posted');

    expect(task.metadata.pending_tool_approval).toMatchObject({
      digest: REQUEST.digest,
      server: REQUEST.server,
      tool: REQUEST.tool,
      requested_by: 'release-manager-agent',
    });
    expect(task.save).toHaveBeenCalledWith(true);
    expect(task.postInteractiveToUser).toHaveBeenCalledTimes(1);
    expect(task.suspendStatus).toHaveBeenCalled();
    expect(task.agentProcesses.get('release-manager-agent')!.deferTeardown).toHaveBeenCalled();
  });

  // Regression for the review-confirmed deadlock: the slot's presence means "a
  // prompt exists in Slack". A failed post that left it set would make every
  // other action 'already-pending' for an hour, and a same-digest retry would
  // park the task against a button nobody can see.
  it('clears the slot and rethrows when the Slack post fails', async () => {
    const task = makeFakeTask();
    task.postInteractiveToUser.mockRejectedValueOnce(new Error('slack 500'));

    await expect(request(task)).rejects.toThrow('slack 500');
    expect(task.metadata.pending_tool_approval).toBeUndefined();
    // and the task is NOT parked against the nonexistent prompt
    expect(task.suspendStatus).not.toHaveBeenCalled();
    expect(task.agentProcesses.get('release-manager-agent')!.deferTeardown).not.toHaveBeenCalled();

    // the next action is not blocked
    task.postInteractiveToUser.mockResolvedValueOnce(undefined);
    expect(await request(task, { ...REQUEST, digest: OTHER_DIGEST })).toBe('posted');
  });

  it('refuses a second, different action while one is pending', async () => {
    const task = makeFakeTask();
    await request(task);
    task.postInteractiveToUser.mockClear();

    expect(await request(task, { ...REQUEST, digest: OTHER_DIGEST })).toBe('already-pending');
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
  });

  it('re-arms the park on a same-digest retry without re-posting', async () => {
    const task = makeFakeTask();
    await request(task);
    task.postInteractiveToUser.mockClear();
    task.suspendStatus.mockClear();

    expect(await request(task)).toBe('posted');
    expect(task.postInteractiveToUser).not.toHaveBeenCalled(); // no duplicate prompt
    expect(task.suspendStatus).toHaveBeenCalled();             // but the park is re-armed
  });

  // The slot's presence is what the re-arm branch and the one-at-a-time refusal
  // both trust, so a failure anywhere between setting it and the prompt landing
  // has to clear it — not only a failed post.
  it('clears the slot when the durable flush fails, before anything is posted', async () => {
    const task = makeFakeTask();
    task.save.mockRejectedValueOnce(new Error('disk full'));

    await expect(request(task)).rejects.toThrow('disk full');
    expect(task.metadata.pending_tool_approval).toBeUndefined();
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
    expect(task.suspendStatus).not.toHaveBeenCalled();
  });

  // A grant is bound to the call, not the agent, so a second agent can reach a
  // live slot with the same digest. Arming its teardown would leave a deferred
  // stop() that resolution never cancels (both paths clear `requested_by`), and
  // it would fire mid-retry and tear the task down.
  it('refuses a same-digest request from a different agent instead of parking it', async () => {
    const task = makeFakeTask();
    await request(task);
    vi.clearAllMocks();

    expect(await request(task, REQUEST, 'pm-agent')).toBe('already-pending');
    expect(task.agentProcesses.get('pm-agent')!.deferTeardown).not.toHaveBeenCalled();
    expect(task.suspendStatus).not.toHaveBeenCalled();
  });

  it('ages out a stale pending slot and replaces it', async () => {
    const task = makeFakeTask();
    await request(task);
    vi.advanceTimersByTime(PENDING_APPROVAL_TTL_MS + 1000);

    expect(await request(task, { ...REQUEST, digest: OTHER_DIGEST })).toBe('posted');
    expect(task.metadata.pending_tool_approval!.digest).toBe(OTHER_DIGEST);
  });
});

describe('handleToolCallApproval', () => {
  it('stores a single grant, clears the slot, and wakes the requesting agent', async () => {
    const task = makeFakeTask();
    await request(task);

    expect(await approve(task, REQUEST.digest)).toBe('resolved');
    expect(task.metadata.pending_tool_approval).toBeUndefined();
    expect(task.metadata.approved_tool_calls).toHaveLength(1);
    expect(task.metadata.approved_tool_calls![0]).toMatchObject({
      digest: REQUEST.digest,
      approved_by: 'U1',
    });
    expect(task.agentProcesses.get('release-manager-agent')!.clearPendingTeardown).toHaveBeenCalled();
    expect(task.sendMessage).toHaveBeenCalledWith(expect.any(String), 'release-manager-agent');
  });

  it('is a stale no-op for a digest that does not match the slot', async () => {
    const task = makeFakeTask();
    await request(task);

    expect(await approve(task, OTHER_DIGEST)).toBe('stale');
    expect(task.metadata.pending_tool_approval!.digest).toBe(REQUEST.digest); // untouched
    expect(task.metadata.approved_tool_calls ?? []).toHaveLength(0);
  });

  it('is a stale no-op with no grant for a prompt older than the pending TTL', async () => {
    const task = makeFakeTask();
    await request(task);
    vi.advanceTimersByTime(PENDING_APPROVAL_TTL_MS + 1000);

    expect(await approve(task, REQUEST.digest)).toBe('stale');
    expect(task.metadata.pending_tool_approval).toBeUndefined(); // slot cleared
    expect(task.metadata.approved_tool_calls ?? []).toHaveLength(0); // NO grant minted
    expect(vi.mocked(appendAgentFinding)).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('expired unspent'), 'decision',
    );
  });

  it('dedupes grants by digest — two approvals cannot become two spends', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    await request(task); // second prompt, same call
    await approve(task, REQUEST.digest);

    expect(task.metadata.approved_tool_calls).toHaveLength(1);
  });
});

describe('handleToolCallDenial', () => {
  it('clears the slot durably and grants nothing', async () => {
    const task = makeFakeTask();
    await request(task);
    task.save.mockClear();

    expect(await deny(task, REQUEST.digest)).toBe('resolved');
    expect(task.metadata.pending_tool_approval).toBeUndefined();
    expect(task.metadata.approved_tool_calls ?? []).toHaveLength(0);
    expect(task.save).toHaveBeenCalledWith(true);
  });

  it('is a stale no-op for a mismatched digest', async () => {
    const task = makeFakeTask();
    await request(task);
    expect(await deny(task, OTHER_DIGEST)).toBe('stale');
    expect(task.metadata.pending_tool_approval!.digest).toBe(REQUEST.digest);
  });
});

describe('consumeToolApproval', () => {
  it('spends a grant exactly once, splicing synchronously and awaiting the flush', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    task.save.mockClear();

    // The splice must land before this yields: the second call is made without
    // awaiting the first, which is exactly what two gated calls in one turn do.
    const spend = consume(task, REQUEST.digest);
    expect(consume(task, REQUEST.digest)).toBe(false); // single-use, synchronously
    expect(await spend).toBe(true);
    expect(task.metadata.approved_tool_calls).toHaveLength(0);
    expect(task.save).toHaveBeenCalledWith(true); // the spend is durable, not debounced
  });

  // Refusing a call a human approved because a write failed is worse than the
  // replay risk that write protects against.
  it('still spends the grant when the flush fails', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    task.save.mockRejectedValueOnce(new Error('disk full'));

    expect(await consume(task, REQUEST.digest)).toBe(true);
  });

  it('refuses an expired grant and prunes it', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);

    expect(consume(task, REQUEST.digest)).toBe(false);
    expect(task.metadata.approved_tool_calls).toHaveLength(0); // pruned
  });

  it('returns false with no grants on file', () => {
    expect(consume(makeFakeTask(), REQUEST.digest)).toBe(false);
  });
});
