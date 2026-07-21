import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyGitLabEvent,
  formatGitLabContext,
  verifyGitLabToken,
  extractBranchFromPayload,
  routeGitLabEvent,
} from '../webhooks.js';

vi.mock('../../../tasks/persistence.js', () => ({
  loadMetadata: vi.fn(),
  findTaskByPRNumber: vi.fn(),
}));

import { loadMetadata, findTaskByPRNumber } from '../../../tasks/persistence.js';

describe('verifyGitLabToken', () => {
  it('accepts a matching token, rejects a mismatch, rejects wrong length', () => {
    expect(verifyGitLabToken('secret', 'secret')).toBe(true);
    expect(verifyGitLabToken('secret', 'nope')).toBe(false);
    expect(verifyGitLabToken('secret', '')).toBe(false);
    expect(verifyGitLabToken(undefined, 'secret')).toBe(false);
  });

  it('returns false (no throw) for a multibyte token of equal UTF-16 length', () => {
    // 'sécret' has the same character count as 'secret' but a different UTF-8 byte length.
    expect(() => verifyGitLabToken('sécret', 'secret')).not.toThrow();
    expect(verifyGitLabToken('sécret', 'secret')).toBe(false);
  });

  it('accepts the correct token and rejects a wrong equal-byte-length one', () => {
    expect(verifyGitLabToken('secret', 'secret')).toBe(true);
    expect(verifyGitLabToken('sekret', 'secret')).toBe(false);
  });
});

describe('formatGitLabContext → canonical vocabulary', () => {
  const project = { path_with_namespace: 'grp/proj' };
  const user = { username: 'dev1' };

  it('MR open → pull_request/opened → existing_task', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'open', source_branch: 'feat/x', state: 'opened' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request', action: 'opened', repo: 'grp/proj', prNumber: 5, branch: 'feat/x', user: 'dev1' });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('MR update with oldrev (commits pushed) → pull_request/synchronize → existing_task', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'update', source_branch: 'feat/x', oldrev: 'abc123' },
    });
    expect(ctx.action).toBe('synchronize');
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('MR update without oldrev (metadata-only edit) → pull_request/update → discard', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'update', source_branch: 'feat/x' },
    });
    expect(ctx.action).toBe('update');
    expect(classifyGitLabEvent(ctx)).toBe('discard');
  });

  it('MR merge → pull_request/closed state merged → existing_task', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'merge', source_branch: 'feat/x' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request', action: 'closed', state: 'merged' });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('MR approved → pull_request_review approved → existing_task', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'approved', source_branch: 'feat/x' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request_review', state: 'approved' });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('note on MR diff → pull_request_review_comment → existing_task', () => {
    const ctx = formatGitLabContext('note', {
      object_kind: 'note', project, user,
      merge_request: { iid: 9, source_branch: 'feat/y' },
      object_attributes: { id: 321, noteable_type: 'MergeRequest', type: 'DiffNote', note: 'fix this' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request_review_comment', prNumber: 9, commentId: 321 });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('plain note on MR → issue_comment/created → existing_task', () => {
    const ctx = formatGitLabContext('note', {
      object_kind: 'note', project, user,
      merge_request: { iid: 9, source_branch: 'feat/y' },
      object_attributes: { id: 322, noteable_type: 'MergeRequest', note: 'thoughts?' },
    });
    expect(ctx).toMatchObject({ eventType: 'issue_comment', action: 'created', prNumber: 9, commentId: 322 });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('push → push → discard; branch stripped from ref', () => {
    const ctx = formatGitLabContext('push', { object_kind: 'push', project, user, ref: 'refs/heads/feat/z' });
    expect(ctx).toMatchObject({ eventType: 'push', branch: 'feat/z' });
    expect(classifyGitLabEvent(ctx)).toBe('discard');
  });

  it('push without nested user falls back to user_username for the actor', () => {
    const ctx = formatGitLabContext('push', {
      object_kind: 'push', project, ref: 'refs/heads/feat/z', user_username: 'pusher1',
    });
    expect(ctx.user).toBe('pusher1');
  });

  it('pipeline success → workflow_run completed success → existing_task', () => {
    const ctx = formatGitLabContext('pipeline', {
      object_kind: 'pipeline', project, user,
      object_attributes: { ref: 'feat/z', status: 'success' },
      merge_request: { iid: 12 },
    });
    expect(ctx).toMatchObject({ eventType: 'workflow_run', action: 'completed', state: 'success', prNumber: 12 });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('pipeline failed → workflow_run completed failure → existing_task', () => {
    const ctx = formatGitLabContext('pipeline', {
      object_kind: 'pipeline', project, user,
      object_attributes: { ref: 'feat/z', status: 'failed' },
    });
    expect(ctx).toMatchObject({ eventType: 'workflow_run', action: 'completed', state: 'failure' });
    expect(classifyGitLabEvent(ctx)).toBe('existing_task');
  });

  it('pipeline running (not yet completed) → discard', () => {
    const ctx = formatGitLabContext('pipeline', {
      object_kind: 'pipeline', project, user,
      object_attributes: { ref: 'feat/z', status: 'running' },
    });
    expect(classifyGitLabEvent(ctx)).toBe('discard');
  });
});

describe('classifyGitLabEvent never produces a merge-check-shaped result', () => {
  const cases: Array<[string, unknown]> = [
    ['pull_request_review approved', { eventType: 'pull_request_review', state: 'approved', repo: 'g/p', user: 'u' }],
    ['pull_request_review changes_requested', { eventType: 'pull_request_review', state: 'changes_requested', repo: 'g/p', user: 'u' }],
    ['pull_request_review commented', { eventType: 'pull_request_review', state: 'commented', repo: 'g/p', user: 'u' }],
    ['pull_request opened', { eventType: 'pull_request', action: 'opened', repo: 'g/p', user: 'u' }],
    ['pull_request synchronize', { eventType: 'pull_request', action: 'synchronize', repo: 'g/p', user: 'u' }],
    ['pull_request closed', { eventType: 'pull_request', action: 'closed', repo: 'g/p', user: 'u' }],
    ['pull_request_review_comment', { eventType: 'pull_request_review_comment', repo: 'g/p', user: 'u' }],
    ['issue_comment created', { eventType: 'issue_comment', action: 'created', repo: 'g/p', user: 'u' }],
    ['workflow_run success', { eventType: 'workflow_run', action: 'completed', state: 'success', repo: 'g/p', user: 'u' }],
    ['workflow_run failure', { eventType: 'workflow_run', action: 'completed', state: 'failure', repo: 'g/p', user: 'u' }],
    ['push', { eventType: 'push', repo: 'g/p', user: 'u' }],
    ['unknown', { eventType: 'unknown', repo: 'g/p', user: 'u' }],
  ];

  it.each(cases)('%s → "existing_task" or "discard" only', (_label, ctx) => {
    const result = classifyGitLabEvent(ctx as Parameters<typeof classifyGitLabEvent>[0]);
    expect(['existing_task', 'discard']).toContain(result);
    expect(result).not.toBe('merge_check');
    expect(result).not.toBe('checks_ready');
  });
});

describe('extractBranchFromPayload', () => {
  it('pulls the branch from MR / push / pipeline payloads', () => {
    expect(extractBranchFromPayload('merge_request', { object_attributes: { source_branch: 'feat/a' } })).toBe('feat/a');
    expect(extractBranchFromPayload('push', { ref: 'refs/heads/feat/b' })).toBe('feat/b');
    expect(extractBranchFromPayload('pipeline', { object_attributes: { ref: 'feat/c' } })).toBe('feat/c');
    expect(extractBranchFromPayload('note', { merge_request: { source_branch: 'feat/d' } })).toBe('feat/d');
  });
});

describe('routeGitLabEvent', () => {
  const project = { path_with_namespace: 'grp/proj' };
  const TASK_ID = 'task-20260714-1200-abc123';
  const OUR_BRANCH = `archie/${TASK_ID}`;

  beforeEach(() => {
    vi.mocked(loadMetadata).mockReset();
    vi.mocked(findTaskByPRNumber).mockReset();
    delete process.env.GITLAB_BOT_USERNAME;
  });

  afterEach(() => {
    delete process.env.GITLAB_BOT_USERNAME;
  });

  it('own-bot event (non-machine) → discard, without ever hitting persistence', async () => {
    process.env.GITLAB_BOT_USERNAME = 'archie-bot';
    const result = await routeGitLabEvent('note', {
      object_kind: 'note', project, user: { username: 'archie-bot' },
      merge_request: { iid: 9, source_branch: OUR_BRANCH },
      object_attributes: { id: 1, note: 'hi' },
    });
    expect(result).toMatchObject({ action: 'discard' });
    expect(loadMetadata).not.toHaveBeenCalled();
    expect(findTaskByPRNumber).not.toHaveBeenCalled();
  });

  it('machine event (pipeline) from the bot username is NOT treated as a loop → still routes normally', async () => {
    process.env.GITLAB_BOT_USERNAME = 'archie-bot';
    vi.mocked(loadMetadata).mockResolvedValue({} as never);
    const result = await routeGitLabEvent('pipeline', {
      object_kind: 'pipeline', project, user: { username: 'archie-bot' },
      object_attributes: { ref: OUR_BRANCH, status: 'success' },
    });
    expect(result).toEqual({ action: 'direct', handler: 'existing_task', taskId: TASK_ID });
  });

  it('not-our-branch (no taskId from branch, no PR-number match) → discard', async () => {
    const result = await routeGitLabEvent('push', {
      object_kind: 'push', project, user: { username: 'dev1' },
      ref: 'refs/heads/feature/unrelated-work',
    });
    expect(result).toMatchObject({ action: 'discard' });
    expect(loadMetadata).not.toHaveBeenCalled();
  });

  it('unknown task (branch resolves a taskId, but metadata lookup misses) → discard', async () => {
    vi.mocked(loadMetadata).mockResolvedValue(null);
    const result = await routeGitLabEvent('merge_request', {
      object_kind: 'merge_request', project, user: { username: 'dev1' },
      object_attributes: { iid: 5, action: 'open', source_branch: OUR_BRANCH },
    });
    expect(result).toMatchObject({ action: 'discard' });
    expect(loadMetadata).toHaveBeenCalledWith(TASK_ID);
  });

  it('happy path: MR opened on our branch, task known → existing_task', async () => {
    vi.mocked(loadMetadata).mockResolvedValue({} as never);
    const result = await routeGitLabEvent('merge_request', {
      object_kind: 'merge_request', project, user: { username: 'dev1' },
      object_attributes: { iid: 5, action: 'open', source_branch: OUR_BRANCH },
    });
    expect(result).toEqual({ action: 'direct', handler: 'existing_task', taskId: TASK_ID });
  });

  it('falls back to findTaskByPRNumber when the branch does not carry a taskId', async () => {
    vi.mocked(findTaskByPRNumber).mockResolvedValue(TASK_ID);
    vi.mocked(loadMetadata).mockResolvedValue({} as never);
    const result = await routeGitLabEvent('note', {
      object_kind: 'note', project, user: { username: 'dev1' },
      merge_request: { iid: 42 }, // no source_branch → extractTaskIdFromBranch(undefined) misses
      object_attributes: { id: 2, noteable_type: 'MergeRequest', note: 'thoughts?' },
    });
    expect(findTaskByPRNumber).toHaveBeenCalledWith('grp/proj', 42);
    expect(result).toEqual({ action: 'direct', handler: 'existing_task', taskId: TASK_ID });
  });

  it('never returns a merge_check / checks_ready shaped result across all the above scenarios', async () => {
    process.env.GITLAB_BOT_USERNAME = 'archie-bot';
    vi.mocked(loadMetadata).mockResolvedValue(null);
    vi.mocked(findTaskByPRNumber).mockResolvedValue(null);

    const scenarios: Array<[string, Record<string, unknown>]> = [
      ['own-bot', { object_kind: 'note', project, user: { username: 'archie-bot' }, merge_request: { iid: 1, source_branch: OUR_BRANCH }, object_attributes: { id: 1, note: 'x' } }],
      ['not-our-branch', { object_kind: 'push', project, user: { username: 'dev1' }, ref: 'refs/heads/feature/nope' }],
      ['unknown-task', { object_kind: 'merge_request', project, user: { username: 'dev1' }, object_attributes: { iid: 5, action: 'open', source_branch: OUR_BRANCH } }],
    ];

    for (const [kind, payload] of scenarios) {
      const result = await routeGitLabEvent(kind, payload);
      expect(result.action).not.toBe('merge_check');
      if ('handler' in result) {
        expect(result.handler).not.toBe('merge_check');
        expect(result.handler).not.toBe('checks_ready');
      }
    }
  });
});
