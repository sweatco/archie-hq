/**
 * Router unit tests for the mention trigger (AC1, AC8, AC11).
 *
 * Drives routeGitHubEvent pure with payload fixtures trimmed from octokit's
 * published examples; persistence lookups are mocked. Pins the new new_task
 * variant, the untouched discard paths, and byte-identical routing/formatting
 * for Archie-managed PRs and machine events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByPRNumber: vi.fn(),
  loadMetadata: vi.fn(),
  appendGitHubEvent: vi.fn(),
}));

vi.mock('../merge.js', () => ({
  checkAndMergeLinkedPRs: vi.fn(),
}));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn() },
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { routeGitHubEvent, matchesMention, formatGitHubContext, formatGitHubEvent } from '../webhooks.js';
import { findTaskByPRNumber, loadMetadata } from '../../../tasks/persistence.js';

const SLUG = 'archie-test';
const TASK_ID = 'task-20260101-1200-abc123';

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf-8'));
}

function commentPayload(body: string, author?: string): Record<string, unknown> {
  const p = loadFixture('issue-comment-created');
  (p.comment as Record<string, unknown>).body = body;
  if (author) {
    (p.sender as Record<string, unknown>).login = author;
    ((p.comment as Record<string, unknown>).user as Record<string, unknown>).login = author;
  }
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findTaskByPRNumber).mockResolvedValue(null);
  vi.mocked(loadMetadata).mockResolvedValue(null);
  vi.stubEnv('GITHUB_APP_SLUG', SLUG);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('matchesMention — word boundaries', () => {
  it('rejects prefix collisions and embedded slugs', () => {
    expect(matchesMention(`hey @${SLUG}-other look`, SLUG)).toBe(false);
    expect(matchesMention(`prefix@${SLUG} inline`, SLUG)).toBe(false);
  });

  it('accepts trailing punctuation and end-of-line, case-insensitively', () => {
    expect(matchesMention(`@${SLUG}!`, SLUG)).toBe(true);
    expect(matchesMention(`ping @${SLUG}`, SLUG)).toBe(true);
    expect(matchesMention(`@${SLUG.toUpperCase()} hello`, SLUG)).toBe(true);
    expect(matchesMention(`@${SLUG}: do the thing`, SLUG)).toBe(true);
  });
});

describe('routeGitHubEvent — mention detection (AC1)', () => {
  it('routes a mentioning issue_comment.created with no resolving task to new_task', async () => {
    const body = `@${SLUG} please investigate`;
    const route = await routeGitHubEvent('issue_comment', commentPayload(body));

    expect(route).toEqual({
      action: 'direct',
      handler: 'new_task',
      mention: {
        githubRepo: 'acme/backend',
        issueNumber: 55,
        isPr: false,
        author: 'dana',
        commentId: 9001,
        commentBody: body,
        issueTitle: 'Login button broken',
        issueBody: 'The login button 500s on tap.',
        issueAuthor: 'issue-author',
        htmlUrl: 'https://github.com/acme/backend/issues/55#issuecomment-9001',
      },
    });
  });

  it('discards a comment without a mention exactly as today', async () => {
    const route = await routeGitHubEvent('issue_comment', commentPayload('no summons here'));
    expect(route).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });

  it('does not route @slug-other (word boundary) to new_task', async () => {
    const route = await routeGitHubEvent('issue_comment', commentPayload(`hey @${SLUG}-other`));
    expect(route).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });

  it('detects a mention inside a fenced code block (markdown-unaware, accepted parity)', async () => {
    const route = await routeGitHubEvent('issue_comment', commentPayload('```\n@' + SLUG + ' help\n```'));
    expect(route).toMatchObject({ action: 'direct', handler: 'new_task' });
  });

  it('routes a newly opened issue with a body mention to new_task (AC4)', async () => {
    const p = loadFixture('issues-opened');
    (p.issue as Record<string, unknown>).body = `@${SLUG} the app crashes on startup, please investigate`;

    const route = await routeGitHubEvent('issues', p);
    expect(route).toEqual({
      action: 'direct',
      handler: 'new_task',
      mention: {
        githubRepo: 'acme/backend',
        issueNumber: 70,
        isPr: false,
        author: 'dana',
        issueTitle: 'Crash on startup',
        issueBody: `@${SLUG} the app crashes on startup, please investigate`,
        issueAuthor: 'dana',
        htmlUrl: 'https://github.com/acme/backend/issues/70',
      },
    });
  });

  it('does not trigger on a mention appearing only in the issue title', async () => {
    const p = loadFixture('issues-opened');
    (p.issue as Record<string, unknown>).title = `@${SLUG} crash on startup`;

    const route = await routeGitHubEvent('issues', p);
    expect(route).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });

  it('never triggers on issue_comment.edited, even with a newly edited-in mention', async () => {
    const p = commentPayload(`@${SLUG} edited in later`);
    p.action = 'edited';

    const route = await routeGitHubEvent('issue_comment', p);
    expect(route).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });
});

describe('routeGitHubEvent — loop safety (AC8)', () => {
  it('discards our own bot comment (ack-shaped, mention included) as Own bot event', async () => {
    const route = await routeGitHubEvent(
      'issue_comment',
      commentPayload(`On it — created ${TASK_ID}. @${SLUG} will follow up here.`, `${SLUG}[bot]`),
    );
    expect(route).toEqual({ action: 'discard', reason: 'Own bot event' });
  });

  it('skips mentions from other [bot] authors', async () => {
    const route = await routeGitHubEvent(
      'issue_comment',
      commentPayload(`@${SLUG} do the thing`, 'dependabot[bot]'),
    );
    expect(route).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });

  it('is inert with GITHUB_APP_SLUG unset: no detection, and the self-filter is off', async () => {
    vi.stubEnv('GITHUB_APP_SLUG', undefined);

    const mention = await routeGitHubEvent('issue_comment', commentPayload(`@${SLUG} anyone home?`));
    expect(mention).toEqual({ action: 'discard', reason: 'Not our branch pattern' });

    const fromBot = await routeGitHubEvent(
      'issue_comment',
      commentPayload('bot chatter', `${SLUG}[bot]`),
    );
    expect(fromBot).toEqual({ action: 'discard', reason: 'Not our branch pattern' });
  });
});

describe('routeGitHubEvent — existing routing unchanged (AC11)', () => {
  it('routes a mentioning comment on an Archie-managed PR to existing_task, not new_task', async () => {
    vi.mocked(findTaskByPRNumber).mockResolvedValue(TASK_ID);
    vi.mocked(loadMetadata).mockResolvedValue({ task_id: TASK_ID } as never);

    const p = loadFixture('issue-comment-created-pr');
    ((p.comment as Record<string, unknown>)).body = `@${SLUG} please check the failing test`;

    const route = await routeGitHubEvent('issue_comment', p);
    expect(route).toEqual({ action: 'direct', handler: 'existing_task', taskId: TASK_ID });
    expect(findTaskByPRNumber).toHaveBeenCalledWith('acme/backend', 88);
  });

  it('routes pull_request_review approvals to merge_check byte-identically', async () => {
    vi.mocked(loadMetadata).mockResolvedValue({ task_id: TASK_ID } as never);

    const route = await routeGitHubEvent('pull_request_review', loadFixture('pull-request-review-approved'));
    expect(route).toEqual({ action: 'direct', handler: 'merge_check', taskId: TASK_ID });
  });

  it('routes failed check_suite completions to checks_ready byte-identically', async () => {
    vi.mocked(loadMetadata).mockResolvedValue({ task_id: TASK_ID } as never);

    const route = await routeGitHubEvent('check_suite', loadFixture('check-suite-failure'));
    expect(route).toEqual({
      action: 'direct',
      handler: 'checks_ready',
      taskId: TASK_ID,
      githubRepo: 'acme/backend',
      prNumber: 90,
    });
  });

  it('formats an Archie PR comment byte-identically', () => {
    const context = formatGitHubContext('issue_comment', loadFixture('issue-comment-created-pr'));
    expect(formatGitHubEvent(context)).toEqual({
      from: 'dana',
      destination: 'PR #88',
      message: 'Ship it once CI is green. [comment_id=9100]',
    });
  });

  it('formats a plain-issue comment with the issue #N destination', () => {
    const context = formatGitHubContext('issue_comment', loadFixture('issue-comment-created'));
    expect(formatGitHubEvent(context)).toEqual({
      from: 'dana',
      destination: 'issue #55',
      message: 'Can someone look at this? [comment_id=9001]',
    });
  });
});
