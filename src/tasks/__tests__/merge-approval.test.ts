/**
 * Unit tests for Task.handleMergeApproval / Task.handleMergeDenial.
 *
 * Calls the real prototype methods on a minimal fake task (no LLM, no SDK,
 * mocked GitHubClient) to prove the resolution semantics: the atomic
 * read-compare-clear identity gate, engine-side merge on approval with no
 * `approved` floor (AC5), failure reporting (AC4 both halves), deny without
 * any GitHub call, the supersede-during-resolution race staying a no-op, and
 * the clear-before-awaits invariant (a supersede landing mid-await survives).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../connectors/github/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/github/client.js')>();
  return { ...actual, getGitHubClient: vi.fn() };
});

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

import { Task } from '../task.js';
import { getGitHubClient } from '../../connectors/github/client.js';
import { appendAgentFinding } from '../persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import type { TaskMetadata } from '../../types/task.js';

const mockGitHubClient = {
  getPRStatus: vi.fn(),
  mergePullRequest: vi.fn(),
};

const PR1 = { github: 'org/backend', pr_number: 1 };
const PR2 = { github: 'org/backend', pr_number: 2 };

function pendingSlot(pr: { github: string; pr_number: number }): NonNullable<TaskMetadata['pending_merge_approval']> {
  return {
    github: pr.github,
    pr_number: pr.pr_number,
    requested_by: 'backend-agent',
    requested_at: '2026-07-06T00:00:00.000Z',
  };
}

type FakeTask = {
  taskId: string;
  metadata: { pending_merge_approval?: TaskMetadata['pending_merge_approval'] };
  agentProcesses: Map<string, { clearPendingTeardown: ReturnType<typeof vi.fn> }>;
  debouncedSave: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

function makeFakeTask(slot?: TaskMetadata['pending_merge_approval']): FakeTask {
  return {
    taskId: 'task-123',
    metadata: { pending_merge_approval: slot },
    agentProcesses: new Map([['backend-agent', { clearPendingTeardown: vi.fn() }]]),
    debouncedSave: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const approver = { id: 'U1', name: 'Dana' };

function approve(task: FakeTask, expected: { github: string; pr_number: number }) {
  return Task.prototype.handleMergeApproval.call(task as unknown as Task, approver, expected);
}

function deny(task: FakeTask, expected: { github: string; pr_number: number }) {
  return Task.prototype.handleMergeDenial.call(task as unknown as Task, expected);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGitHubClient).mockReturnValue(mockGitHubClient as any);
});

describe('handleMergeApproval', () => {
  it('merges, appends a completion finding, and reactivates the PM when ready (AC4)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });
    const task = makeFakeTask(pendingSlot(PR1));

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('resolved');
    expect(task.metadata.pending_merge_approval).toBeUndefined();
    expect(task.agentProcesses.get('backend-agent')!.clearPendingTeardown).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 1);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('merged on user approval by Dana'), 'completion',
    );
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });

  it('does not merge a dirty PR; appends the reason and reactivates the PM (AC4)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: false, mergeableState: 'dirty', approved: true,
    });
    const task = makeFakeTask(pendingSlot(PR1));

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('resolved');
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(task.metadata.pending_merge_approval).toBeUndefined();
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('mergeableState=dirty'), 'decision',
    );
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });

  it('does not merge a closed PR; appends the reason (AC4)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'closed', mergeable: false, mergeableState: 'unknown', approved: false,
    });
    const task = makeFakeTask(pendingSlot(PR1));

    await approve(task, PR1);

    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('state=closed'), 'decision',
    );
  });

  it('reports a merge-API failure ({success: false}) as a decision finding (AC4)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: false, message: 'Base branch was modified' });
    const task = makeFakeTask(pendingSlot(PR1));

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('resolved');
    expect(task.metadata.pending_merge_approval).toBeUndefined();
    expect(appendAgentFinding).toHaveBeenCalledTimes(1);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('Base branch was modified'), 'decision',
    );
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });

  it('reports a thrown merge error as a decision finding, slot cleared, PM reactivated (AC4)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockRejectedValue(new Error('boom from GitHub'));
    const task = makeFakeTask(pendingSlot(PR1));

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('resolved');
    expect(task.metadata.pending_merge_approval).toBeUndefined();
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('boom from GitHub'), 'decision',
    );
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });

  it('merges with zero review approvals when GitHub reports clean — no approved floor (AC5)', async () => {
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: false,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });
    const task = makeFakeTask(pendingSlot(PR1));

    await approve(task, PR1);

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 1);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.any(String), 'completion',
    );
  });

  it('is a stale no-op on an empty slot', async () => {
    const task = makeFakeTask(undefined);

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('stale');
    expect(logger.warn).toHaveBeenCalled();
    expect(mockGitHubClient.getPRStatus).not.toHaveBeenCalled();
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(appendAgentFinding).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('supersede-during-resolution: a click for PR#1 after the slot moved to PR#2 merges neither', async () => {
    // Simulated supersede: the slot was rewritten for PR#2 before the PR#1
    // click resolves. The mismatch must no-op and leave PR#2's slot intact.
    const task = makeFakeTask(pendingSlot(PR2));

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('stale');
    expect(mockGitHubClient.getPRStatus).not.toHaveBeenCalled();
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(task.metadata.pending_merge_approval).toEqual(pendingSlot(PR2));
    expect(task.sendMessage).not.toHaveBeenCalled();

    // A subsequent click for PR#2 still resolves normally.
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    const second = await approve(task, PR2);

    expect(second).toBe('resolved');
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 2);
    expect(task.metadata.pending_merge_approval).toBeUndefined();
  });

  it('supersede landing mid-await survives: the slot is cleared before any await, so PR#2 written during resolution is never wiped', async () => {
    // Exercises the clear-before-awaits invariant (the synchronous
    // read-compare-clear gate): the first awaited GitHub call synchronously
    // rewrites the slot to PR#2, simulating a supersede landing during the
    // resolution's await window. Correct code consumed PR#1's slot before the
    // await and never touches the slot again — PR#2 must survive. Code that
    // clears after the awaits would wipe the superseding PR#2 request.
    const task = makeFakeTask(pendingSlot(PR1));
    mockGitHubClient.getPRStatus.mockImplementation(async () => {
      task.metadata.pending_merge_approval = pendingSlot(PR2);
      return { state: 'open', mergeable: true, mergeableState: 'clean', approved: true };
    });
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    const disposition = await approve(task, PR1);

    expect(disposition).toBe('resolved');
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 1);
    expect(task.metadata.pending_merge_approval).toEqual(pendingSlot(PR2));

    // The superseding request is still resolvable afterwards.
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'open', mergeable: true, mergeableState: 'clean', approved: true,
    });
    const second = await approve(task, PR2);
    expect(second).toBe('resolved');
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 2);
  });
});

describe('handleMergeDenial', () => {
  it('clears the slot and never touches GitHub', async () => {
    const task = makeFakeTask(pendingSlot(PR1));

    const disposition = await deny(task, PR1);

    expect(disposition).toBe('resolved');
    expect(task.metadata.pending_merge_approval).toBeUndefined();
    expect(task.agentProcesses.get('backend-agent')!.clearPendingTeardown).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.getPRStatus).not.toHaveBeenCalled();
    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', 'Merge denied by user — PR not merged', 'decision',
    );
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });

  it('is a stale no-op on an empty slot', async () => {
    const task = makeFakeTask(undefined);

    const disposition = await deny(task, PR1);

    expect(disposition).toBe('stale');
    expect(appendAgentFinding).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('mismatched identity leaves the superseding slot untouched', async () => {
    const task = makeFakeTask(pendingSlot(PR2));

    const disposition = await deny(task, PR1);

    expect(disposition).toBe('stale');
    expect(task.metadata.pending_merge_approval).toEqual(pendingSlot(PR2));
    expect(appendAgentFinding).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
  });
});
