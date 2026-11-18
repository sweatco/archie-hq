/**
 * GitHub webhook routing: which events reach a task, which trigger a merge
 * check, and which are dropped. A wrong answer here either wakes the PM on its
 * own comments (a reply loop) or silently loses a review, so the decisions are
 * pinned per event type against the real router with only storage mocked.
 */

import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../merge.js', () => ({ checkAndMergeLinkedPRs: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByPRNumber: vi.fn(),
  loadMetadata: vi.fn(),
  appendGitHubEvent: vi.fn(),
}));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: vi.fn() } }));

import {
  verifyWebhookSignature,
  formatGitHubContext,
  formatGitHubEvent,
  routeGitHubEvent,
  handleMergeCheckDirect,
  handleChecksReadyDirect,
} from '../webhooks.js';
import { checkAndMergeLinkedPRs } from '../merge.js';
import { findTaskByPRNumber, loadMetadata, appendGitHubEvent } from '../../../tasks/persistence.js';
import { Task } from '../../../tasks/task.js';
import { logger } from '../../../system/logger.js';

const TASK_ID = 'task-20260101-1823-abc123';
const BRANCH = `archie/${TASK_ID}`;
const REPO = 'org/backend';

const base = { repository: { full_name: REPO }, sender: { login: 'alice' } };
const pullRequest = { number: 42, head: { ref: BRANCH } };

function sign(payload: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadMetadata).mockResolvedValue({ task_id: TASK_ID } as never);
  vi.mocked(findTaskByPRNumber).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.GITHUB_APP_SLUG;
});

describe('verifyWebhookSignature', () => {
  it('accepts only the HMAC of the exact payload under the shared secret', () => {
    const payload = '{"action":"opened"}';
    expect(verifyWebhookSignature(payload, sign(payload, 's3cret'), 's3cret')).toBe(true);
    expect(verifyWebhookSignature(payload, sign(payload, 'other'), 's3cret')).toBe(false);
    expect(verifyWebhookSignature(payload + ' ', sign(payload, 's3cret'), 's3cret')).toBe(false);
  });

  it('rejects a signature of the wrong length instead of throwing', () => {
    expect(verifyWebhookSignature('{}', 'sha256=short', 's3cret')).toBe(false);
  });
});

describe('formatGitHubContext', () => {
  it('reads a PR conversation comment from the issue payload', () => {
    const context = formatGitHubContext('issue_comment', {
      ...base,
      action: 'created',
      issue: { number: 42, pull_request: {} },
      comment: { id: 900, body: 'please rename this' },
    });
    expect(context).toMatchObject({
      githubRepo: REPO,
      user: 'alice',
      prNumber: 42,
      commentId: 900,
      body: 'please rename this',
    });
  });

  it('ignores a comment on a plain issue', () => {
    const context = formatGitHubContext('issue_comment', {
      ...base,
      action: 'created',
      issue: { number: 7 },
      comment: { id: 901, body: 'unrelated' },
    });
    expect(context.prNumber).toBeUndefined();
    expect(context.body).toBeUndefined();
  });

  it('labels a PR merged or closed only on the closed action', () => {
    const closed = (merged: boolean) =>
      formatGitHubContext('pull_request', {
        ...base,
        action: 'closed',
        pull_request: { ...pullRequest, merged },
      }).state;
    expect(closed(true)).toBe('merged');
    expect(closed(false)).toBe('closed');
    expect(
      formatGitHubContext('pull_request', { ...base, action: 'opened', pull_request: pullRequest })
        .state,
    ).toBeUndefined();
  });

  it('takes branch, conclusion and PR from CI payloads', () => {
    expect(
      formatGitHubContext('check_suite', {
        ...base,
        action: 'completed',
        check_suite: {
          head_branch: BRANCH,
          conclusion: 'failure',
          pull_requests: [{ number: 42 }],
        },
      }),
    ).toMatchObject({ branch: BRANCH, state: 'failure', prNumber: 42 });
    expect(
      formatGitHubContext('check_run', {
        ...base,
        check_run: { status: 'queued', check_suite: { head_branch: BRANCH, pull_requests: [] } },
      }),
    ).toMatchObject({ branch: BRANCH, state: 'queued' });
    expect(
      formatGitHubContext('status', { ...base, state: 'pending', branches: [{ name: BRANCH }] }),
    ).toMatchObject({ branch: BRANCH, state: 'pending' });
    expect(formatGitHubContext('push', { ...base, ref: `refs/heads/${BRANCH}` }).branch).toBe(
      BRANCH,
    );
  });

  it('falls back to placeholders when repository and sender are missing', () => {
    expect(formatGitHubContext('ping', {})).toMatchObject({
      githubRepo: 'unknown/unknown',
      user: 'unknown',
      action: '',
    });
  });
});

describe('formatGitHubEvent', () => {
  const context = { action: '', githubRepo: REPO, user: 'alice', prNumber: 42 };

  it.each([
    [{ eventType: 'pull_request_review', state: 'approved' }, 'approved'],
    [
      { eventType: 'pull_request_review', state: 'changes_requested', body: 'fix the race' },
      'requested changes: fix the race',
    ],
    [{ eventType: 'pull_request_review', state: 'commented' }, 'commented'],
    [
      { eventType: 'pull_request_review_comment', body: 'nit', commentId: 5 },
      'commented on code [comment_id=5]: nit',
    ],
    [{ eventType: 'issue_comment', body: 'looks good', commentId: 6 }, 'looks good [comment_id=6]'],
    [{ eventType: 'pull_request', action: 'closed', state: 'merged' }, 'merged'],
    [{ eventType: 'pull_request', action: 'closed', state: 'closed' }, 'closed'],
  ])('renders %j as "%s" on the PR', (overrides, message) => {
    expect(formatGitHubEvent({ ...context, ...overrides })).toEqual({
      from: 'alice',
      destination: 'PR #42',
      message,
    });
  });

  it('attributes CI results to ci and addresses the branch when no PR is attached', () => {
    expect(
      formatGitHubEvent({
        eventType: 'check_suite',
        action: 'completed',
        githubRepo: REPO,
        user: 'alice',
        branch: BRANCH,
        state: 'failure',
      }),
    ).toEqual({ from: 'ci', destination: `branch:${BRANCH}`, message: 'checks failure' });
  });
});

describe('routeGitHubEvent', () => {
  const review = (state: string) => ({
    ...base,
    action: 'submitted',
    pull_request: pullRequest,
    review: { state, body: '' },
  });

  it.each([
    ['pull_request_review', review('approved'), 'merge_check'],
    ['pull_request_review', review('changes_requested'), 'existing_task'],
    ['pull_request_review', review('commented'), 'existing_task'],
    [
      'pull_request_review_comment',
      { ...base, action: 'created', pull_request: pullRequest, comment: { id: 1, body: 'nit' } },
      'existing_task',
    ],
    ['pull_request', { ...base, action: 'closed', pull_request: pullRequest }, 'existing_task'],
    ['pull_request', { ...base, action: 'synchronize', pull_request: pullRequest }, 'merge_check'],
    ['push', { ...base, ref: `refs/heads/${BRANCH}` }, 'merge_check'],
    [
      'workflow_run',
      {
        ...base,
        action: 'completed',
        workflow_run: { head_branch: BRANCH, conclusion: 'failure' },
      },
      'existing_task',
    ],
    [
      'workflow_run',
      {
        ...base,
        action: 'completed',
        workflow_run: { head_branch: BRANCH, conclusion: 'success' },
      },
      'merge_check',
    ],
  ])('routes %s %j to %s', async (eventType, payload, handler) => {
    expect(await routeGitHubEvent(eventType, payload)).toEqual({
      action: 'direct',
      handler,
      taskId: TASK_ID,
    });
  });

  it.each([
    ['pull_request', { ...base, action: 'edited', pull_request: pullRequest }],
    ['pull_request_review', review('dismissed')],
    [
      'issue_comment',
      {
        ...base,
        action: 'deleted',
        issue: { number: 42, pull_request: {} },
        comment: { id: 1, body: 'x' },
      },
    ],
    [
      'check_suite',
      {
        ...base,
        action: 'completed',
        check_suite: {
          head_branch: BRANCH,
          conclusion: 'success',
          pull_requests: [{ number: 42 }],
        },
      },
    ],
  ])('takes no action on %s %j', async (eventType, payload) => {
    vi.mocked(findTaskByPRNumber).mockResolvedValue(TASK_ID);
    const route = await routeGitHubEvent(eventType, payload);
    expect(route.action).toBe('discard');
  });

  it('wakes the task about failed checks with the PR identity', async () => {
    const route = await routeGitHubEvent('check_suite', {
      ...base,
      action: 'completed',
      check_suite: {
        head_branch: BRANCH,
        conclusion: 'timed_out',
        pull_requests: [{ number: 42 }],
      },
    });
    expect(route).toEqual({
      action: 'direct',
      handler: 'checks_ready',
      taskId: TASK_ID,
      githubRepo: REPO,
      prNumber: 42,
    });
  });

  it('drops failed checks that have no attached PR', async () => {
    const route = await routeGitHubEvent('check_suite', {
      ...base,
      action: 'completed',
      check_suite: { head_branch: BRANCH, conclusion: 'failure', pull_requests: [] },
    });
    expect(route).toEqual({ action: 'discard', reason: 'check_suite without attached PR' });
  });

  it('finds the task by PR number when a comment carries no branch', async () => {
    vi.mocked(findTaskByPRNumber).mockResolvedValue(TASK_ID);
    const route = await routeGitHubEvent('issue_comment', {
      ...base,
      action: 'created',
      issue: { number: 42, pull_request: {} },
      comment: { id: 900, body: 'ping' },
    });
    expect(findTaskByPRNumber).toHaveBeenCalledWith(REPO, 42);
    expect(route).toEqual({ action: 'direct', handler: 'existing_task', taskId: TASK_ID });
  });

  it('still attributes pull requests opened on the legacy feature/ prefix', async () => {
    const route = await routeGitHubEvent('push', { ...base, ref: `refs/heads/feature/${TASK_ID}` });
    expect(route).toMatchObject({ handler: 'merge_check', taskId: TASK_ID });
  });

  it('drops events for branches Archie does not own and for unknown tasks', async () => {
    expect(await routeGitHubEvent('push', { ...base, ref: 'refs/heads/main' })).toEqual({
      action: 'discard',
      reason: 'Not our branch pattern',
    });
    vi.mocked(loadMetadata).mockResolvedValue(null);
    expect(await routeGitHubEvent('push', { ...base, ref: `refs/heads/${BRANCH}` })).toEqual({
      action: 'discard',
      reason: `Task ${TASK_ID} not found`,
    });
  });

  describe('events sent by our own GitHub App', () => {
    const own = { ...base, sender: { login: 'archie-hq[bot]' } };

    beforeEach(() => {
      process.env.GITHUB_APP_SLUG = 'archie-hq';
    });

    it('drops our own comments and reviews so the PM is not woken by itself', async () => {
      const route = await routeGitHubEvent('pull_request_review_comment', {
        ...own,
        action: 'created',
        pull_request: pullRequest,
        comment: { id: 1, body: 'done' },
      });
      expect(route).toEqual({ action: 'discard', reason: 'Own bot event' });
      expect(loadMetadata).not.toHaveBeenCalled();
    });

    it('keeps CI and push events, which name the bot only because it pushed the commit', async () => {
      const route = await routeGitHubEvent('push', { ...own, ref: `refs/heads/${BRANCH}` });
      expect(route).toMatchObject({ action: 'direct', handler: 'merge_check' });
    });
  });
});

describe('debounced handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs one merge check for a burst of events on the same task', async () => {
    handleMergeCheckDirect(TASK_ID);
    await vi.advanceTimersByTimeAsync(4000);
    handleMergeCheckDirect(TASK_ID);
    await vi.advanceTimersByTimeAsync(4999);
    expect(checkAndMergeLinkedPRs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkAndMergeLinkedPRs).toHaveBeenCalledExactlyOnceWith(TASK_ID);
  });

  it('logs a failed merge check instead of leaving the rejection unhandled', async () => {
    const failure = new Error('github down');
    vi.mocked(checkAndMergeLinkedPRs).mockRejectedValueOnce(failure);
    handleMergeCheckDirect(TASK_ID);
    await vi.advanceTimersByTimeAsync(5000);
    expect(logger.error).toHaveBeenCalledWith('runtime', 'Merge check failed', failure);
  });

  it('coalesces check suites per PR into one recorded event and one PM wake', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Task.get).mockResolvedValue({ sendMessage } as never);
    vi.mocked(appendGitHubEvent).mockResolvedValue('recorded line');

    handleChecksReadyDirect(TASK_ID, REPO, 42);
    await vi.advanceTimersByTimeAsync(15_000);
    handleChecksReadyDirect(TASK_ID, REPO, 42);
    handleChecksReadyDirect(TASK_ID, REPO, 43);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(vi.mocked(appendGitHubEvent).mock.calls.map((call) => call[2].destination)).toEqual([
      'PR #42',
      'PR #43',
    ]);
    expect(appendGitHubEvent).toHaveBeenCalledWith(TASK_ID, REPO, {
      from: 'ci',
      destination: 'PR #42',
      message: 'checks updated — call get_pr_checks(42) to inspect',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('recorded line'));
  });
});
