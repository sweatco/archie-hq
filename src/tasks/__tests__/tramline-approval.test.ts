/**
 * Unit tests for the Tramline approval lifecycle on Task:
 * requestTramlineApproval / consumeTramlineApproval /
 * handleTramlineActionApproval / handleTramlineActionDenial.
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
import { APPROVAL_TTL_MS, PENDING_APPROVAL_TTL_MS } from '../../agents/tramline-guard.js';
import type { TaskMetadata } from '../../types/task.js';

const REQUEST = {
  digest: 'd1'.padEnd(16, '0'),
  tool: 'retry_workflow_run',
  summary: 'Re-run this failed CI build\n*Target:* 253.0.0 IOS · CI workflow run · (failed)',
  target: '253.0.0 IOS · CI workflow run · (failed)',
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
  Task.prototype.requestTramlineApproval.call(task as unknown as Task, agent, req);
const consume = (task: FakeTask, digest: string) =>
  Task.prototype.consumeTramlineApproval.call(task as unknown as Task, digest);
const approve = (task: FakeTask, digest: string, approver = { id: 'U1', name: 'Misha' }) =>
  Task.prototype.handleTramlineActionApproval.call(task as unknown as Task, approver, digest);
const deny = (task: FakeTask, digest: string) =>
  Task.prototype.handleTramlineActionDenial.call(task as unknown as Task, digest);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('requestTramlineApproval', () => {
  it('writes the slot durably, posts, and parks the requesting agent', async () => {
    const task = makeFakeTask();
    expect(await request(task)).toBe('posted');

    expect(task.metadata.pending_tramline_action).toMatchObject({
      digest: REQUEST.digest,
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
    expect(task.metadata.pending_tramline_action).toBeUndefined();
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

  it('ages out a stale pending slot and replaces it', async () => {
    const task = makeFakeTask();
    await request(task);
    vi.advanceTimersByTime(PENDING_APPROVAL_TTL_MS + 1000);

    expect(await request(task, { ...REQUEST, digest: OTHER_DIGEST })).toBe('posted');
    expect(task.metadata.pending_tramline_action!.digest).toBe(OTHER_DIGEST);
  });
});

describe('handleTramlineActionApproval', () => {
  it('stores a single grant, clears the slot, and wakes the requesting agent', async () => {
    const task = makeFakeTask();
    await request(task);

    expect(await approve(task, REQUEST.digest)).toBe('resolved');
    expect(task.metadata.pending_tramline_action).toBeUndefined();
    expect(task.metadata.approved_tramline_actions).toHaveLength(1);
    expect(task.metadata.approved_tramline_actions![0]).toMatchObject({
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
    expect(task.metadata.pending_tramline_action!.digest).toBe(REQUEST.digest); // untouched
    expect(task.metadata.approved_tramline_actions ?? []).toHaveLength(0);
  });

  it('is a stale no-op with no grant for a prompt older than the pending TTL', async () => {
    const task = makeFakeTask();
    await request(task);
    vi.advanceTimersByTime(PENDING_APPROVAL_TTL_MS + 1000);

    expect(await approve(task, REQUEST.digest)).toBe('stale');
    expect(task.metadata.pending_tramline_action).toBeUndefined(); // slot cleared
    expect(task.metadata.approved_tramline_actions ?? []).toHaveLength(0); // NO grant minted
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

    expect(task.metadata.approved_tramline_actions).toHaveLength(1);
  });
});

describe('handleTramlineActionDenial', () => {
  it('clears the slot durably and grants nothing', async () => {
    const task = makeFakeTask();
    await request(task);
    task.save.mockClear();

    expect(await deny(task, REQUEST.digest)).toBe('resolved');
    expect(task.metadata.pending_tramline_action).toBeUndefined();
    expect(task.metadata.approved_tramline_actions ?? []).toHaveLength(0);
    expect(task.save).toHaveBeenCalledWith(true);
  });

  it('is a stale no-op for a mismatched digest', async () => {
    const task = makeFakeTask();
    await request(task);
    expect(await deny(task, OTHER_DIGEST)).toBe('stale');
    expect(task.metadata.pending_tramline_action!.digest).toBe(REQUEST.digest);
  });
});

describe('consumeTramlineApproval', () => {
  it('spends a grant exactly once, synchronously, with a durable flush', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    task.save.mockClear();

    expect(consume(task, REQUEST.digest)).toBe(true);
    expect(consume(task, REQUEST.digest)).toBe(false); // single-use
    expect(task.metadata.approved_tramline_actions).toHaveLength(0);
    expect(task.save).toHaveBeenCalledWith(true); // the spend is durable, not debounced
  });

  it('refuses an expired grant and prunes it', async () => {
    const task = makeFakeTask();
    await request(task);
    await approve(task, REQUEST.digest);
    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);

    expect(consume(task, REQUEST.digest)).toBe(false);
    expect(task.metadata.approved_tramline_actions).toHaveLength(0); // pruned
  });

  it('returns false with no grants on file', () => {
    expect(consume(makeFakeTask(), REQUEST.digest)).toBe(false);
  });
});
