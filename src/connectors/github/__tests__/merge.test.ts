/**
 * Unit tests for the merge orchestrator's policy gating and ready notification.
 *
 * Drives checkAndMergeLinkedPRs against a minimal fake task (no LLM, mocked
 * GitHubClient + registry) to prove: non-auto ready PRs are held and notified
 * exactly once per continuous ready period (AC1) — including when every
 * Task.get loads a fresh instance from persisted metadata, the parked-task
 * production reality — auto repos merge as today (AC2), mixed-policy tasks
 * are evaluated per PR, the marker clears on un-ready and on merged, survives
 * reload, and a pending merge approval suppresses the ready nudge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  createGitHubClient: vi.fn(),
}));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn() },
}));

vi.mock('../../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../agents/registry.js', () => ({
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), plain: vi.fn(),
  },
}));

import { checkAndMergeLinkedPRs } from '../merge.js';
import { createGitHubClient } from '../client.js';
import { Task } from '../../../tasks/task.js';
import { appendAgentFinding } from '../../../tasks/persistence.js';
import { isAutoMergeRepo } from '../../../agents/registry.js';
import { AGENT_PROMPTS } from '../../../agents/prompts.js';
import type { TaskMetadata, BranchState } from '../../../types/task.js';

const mockGitHubClient = {
  getPRStatus: vi.fn(),
  mergePullRequest: vi.fn(),
};

const READY = { state: 'open', mergeable: true, mergeableState: 'clean', approved: true };
const NOT_READY = { state: 'open', mergeable: false, mergeableState: 'blocked', approved: true };

type FakeTask = {
  taskId: string;
  metadata: Pick<TaskMetadata, 'repositories' | 'pending_merge_approval'>;
  debouncedSave: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

function makeTask(
  repositories: TaskMetadata['repositories'],
  pendingMergeApproval?: TaskMetadata['pending_merge_approval'],
): FakeTask {
  return {
    taskId: 'task-123',
    metadata: { repositories, pending_merge_approval: pendingMergeApproval },
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Multi-instance persistence harness, modeling the production reality for an
 * inactive (parked) task: every `Task.get` call loads a *fresh* instance from
 * the persisted metadata JSON — instances share nothing in memory. Only
 * `save(true)` persists; `debouncedSave` is modeled as a lost write (in
 * production it fires 500ms later, after any concurrently loaded instance has
 * already read stale metadata, and the activated instance's own saves then
 * clobber it). A shared single-instance `Task.get` mock hides exactly this
 * class of bug — a marker set on one instance silently reaching another.
 */
function mockPersistedTask(repositories: TaskMetadata['repositories']): {
  instances: FakeTask[];
  persisted: () => Pick<TaskMetadata, 'repositories' | 'pending_merge_approval'>;
} {
  let persisted = JSON.stringify({ repositories });
  const instances: FakeTask[] = [];
  vi.mocked(Task.get).mockImplementation(async () => {
    const task: FakeTask = {
      taskId: 'task-123',
      metadata: JSON.parse(persisted) as FakeTask['metadata'],
      debouncedSave: vi.fn(),
      save: vi.fn(async () => {
        persisted = JSON.stringify(task.metadata);
      }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    instances.push(task);
    return task as unknown as Task;
  });
  return { instances, persisted: () => JSON.parse(persisted) as FakeTask['metadata'] };
}

function singlePRRepositories(github: string, prNumber: number): TaskMetadata['repositories'] {
  return {
    'backend-agent': [
      { github, branch_states: { 'feat/x': { pr_number: prNumber, base_branch: 'main' } } },
    ],
  };
}

function branchState(task: FakeTask, agentId: string, branch: string): BranchState {
  return task.metadata.repositories[agentId]![0]!.branch_states![branch]!;
}

/** Findings that are the ready notification (decision finding naming the held PR). */
function readyNotifications(): unknown[][] {
  return vi.mocked(appendAgentFinding).mock.calls.filter(
    (call) => call[3] === 'decision' && String(call[2]).includes('do not auto-merge'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGitHubClient).mockReturnValue(mockGitHubClient as never);
  vi.mocked(isAutoMergeRepo).mockReturnValue(false);
});

describe('checkAndMergeLinkedPRs — non-auto policy (AC1)', () => {
  it('holds a ready non-auto PR and notifies exactly once across a webhook burst, with each Task.get loading a fresh instance', async () => {
    // Regression for the parked-task marker race: with per-call fresh
    // instances, a marker set on one instance is lost unless the run threads a
    // single instance through and flushes it before the PM reactivation.
    const world = mockPersistedTask(singlePRRepositories('org/backend', 42));
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');
    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    const notifications = readyNotifications();
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0]![2])).toContain('org/backend#42');

    const notifiers = world.instances.filter((i) => i.sendMessage.mock.calls.length > 0);
    expect(notifiers).toHaveLength(1);
    const notifier = notifiers[0]!;
    expect(notifier.sendMessage).toHaveBeenCalledTimes(1);
    expect(notifier.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');

    // The marker was set on the same instance that activated, and flushed
    // synchronously (save(true)) before the activating sendMessage — a
    // debounced write would be invisible to any instance loaded meanwhile.
    expect(branchState(notifier, 'backend-agent', 'feat/x').merge_ready_notified).toBe(true);
    expect(notifier.save).toHaveBeenCalledWith(true);
    expect(notifier.save.mock.invocationCallOrder[0]!)
      .toBeLessThan(notifier.sendMessage.mock.invocationCallOrder[0]!);
  });

  it('suppresses the ready nudge for a PR whose merge approval is pending', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42), {
      github: 'org/backend', pr_number: 42,
      requested_by: 'backend-agent', requested_at: '2026-07-06T00:00:00.000Z',
    });
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(readyNotifications()).toHaveLength(0);
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBeUndefined();
  });

  it('notifies again after the PR goes un-ready and becomes ready once more (marker cleared)', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);

    mockGitHubClient.getPRStatus.mockResolvedValue(NOT_READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBeUndefined();

    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(2);
  });

  it('clears the marker when the PR is observed merged, so a new PR reusing the branch is notified', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBe(true);

    // PR #42 merges (externally or on approval); the marker must not survive it.
    mockGitHubClient.getPRStatus.mockResolvedValue({
      state: 'merged', mergeable: false, mergeableState: 'unknown', approved: true,
    });
    await checkAndMergeLinkedPRs('task-123');
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBeUndefined();

    // The same BranchState later carries a new PR (create_pull_request
    // overwrites pr_number) — its first ready period must notify.
    branchState(task, 'backend-agent', 'feat/x').pr_number = 43;
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');

    const notifications = readyNotifications();
    expect(notifications).toHaveLength(2);
    expect(String(notifications[1]![2])).toContain('org/backend#43');
  });


  it('does not re-notify after a task reload — the marker reaches the persisted metadata', async () => {
    const world = mockPersistedTask(singlePRRepositories('org/backend', 42));
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);

    // The marker must be in the persisted JSON — that is what any instance
    // loaded after a restart (or any later webhook) is built from.
    const persistedState =
      world.persisted().repositories['backend-agent']![0]!.branch_states!['feat/x']!;
    expect(persistedState.merge_ready_notified).toBe(true);

    // Restart: the harness already builds every instance from the persisted
    // JSON, so the next run is exactly a post-reload check.
    await checkAndMergeLinkedPRs('task-123');

    expect(readyNotifications()).toHaveLength(1);
    expect(world.instances.at(-1)!.sendMessage).not.toHaveBeenCalled();
  });
});

describe('checkAndMergeLinkedPRs — auto policy (AC2)', () => {
  it('merges a ready PR in an auto repo as today, with no ready notification', async () => {
    vi.mocked(isAutoMergeRepo).mockReturnValue(true);
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 42);
    expect(readyNotifications()).toHaveLength(0);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('org/backend#42'), 'completion',
    );
  });
});

describe('checkAndMergeLinkedPRs — mixed-policy task', () => {
  it('merges the auto PR while the non-auto PR is held with a ready notification', async () => {
    vi.mocked(isAutoMergeRepo).mockImplementation((github: string) => github === 'org/auto');
    const task = makeTask({
      'backend-agent': [
        { github: 'org/auto', branch_states: { 'feat/a': { pr_number: 1, base_branch: 'main' } } },
      ],
      'mobile-agent': [
        { github: 'org/manual', branch_states: { 'feat/b': { pr_number: 2, base_branch: 'main' } } },
      ],
    });
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/auto', 1);
    const notifications = readyNotifications();
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0]![2])).toContain('org/manual#2');
    expect(String(notifications[0]![2])).not.toContain('org/auto#1');
    expect(branchState(task, 'mobile-agent', 'feat/b').merge_ready_notified).toBe(true);
    expect(branchState(task, 'backend-agent', 'feat/a').merge_ready_notified).toBeUndefined();
  });
});
