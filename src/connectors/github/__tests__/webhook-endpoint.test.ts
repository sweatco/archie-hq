/**
 * `POST /webhooks/github` over a real Express app with the real router: the
 * endpoint is unauthenticated apart from the signature, so its rejections are
 * pinned first, then the path from a signed delivery to a recorded event and a
 * PM wake. Only storage, the task and Slack-facing card refreshes are mocked.
 */

import crypto from 'crypto';
import { createRequire } from 'module';
import type { Server } from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn() }));
vi.mock('../../../system/workdir.js', () => ({ WORKDIR: '/nonexistent-archie-workdir' }));
vi.mock('../merge.js', () => ({ checkAndMergeLinkedPRs: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByPRNumber: vi.fn(),
  findTaskByBranch: vi.fn(),
  loadMetadata: vi.fn(),
  appendGitHubEvent: vi.fn(),
}));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: vi.fn() } }));

import { mountGitHubWebhook } from '../events.js';
import { checkAndMergeLinkedPRs } from '../merge.js';
import { findTaskByPRNumber, loadMetadata, appendGitHubEvent } from '../../../tasks/persistence.js';
import { Task } from '../../../tasks/task.js';
import { getIsShuttingDown } from '../../../system/shutdown.js';
import { logger } from '../../../system/logger.js';
import type { BranchState } from '../../../types/task.js';

const express = require('express') as typeof import('express');

const SECRET = 'webhook-secret';
const TASK_ID = 'task-20260101-1823-abc123';
const BRANCH = `archie/${TASK_ID}`;
const REPO = 'org/backend';

let server: Server;
let baseUrl: string;
let branchState: BranchState;
const task = {
  metadata: { repositories: [] as unknown[] },
  sendMessage: vi.fn(),
  debouncedSave: vi.fn(),
  refreshPrCardInPlace: vi.fn(),
  refreshAllPrCards: vi.fn(),
};

function deliver(
  eventType: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = JSON.stringify({
    repository: { full_name: REPO },
    sender: { login: 'alice' },
    ...payload,
  });
  const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': eventType,
      'x-hub-signature-256': signature,
      ...headers,
    },
    body,
  });
}

function prComment(commentId: number) {
  return {
    action: 'created',
    issue: { number: 42, pull_request: {} },
    comment: { id: commentId, body: 'please rename this' },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  branchState = { pr_number: 42 };
  task.metadata.repositories = [{ github: REPO, branch_states: { [BRANCH]: branchState } }];
  task.sendMessage.mockResolvedValue(undefined);
  vi.mocked(getIsShuttingDown).mockReturnValue(false);
  vi.mocked(Task.get).mockResolvedValue(task as never);
  vi.mocked(loadMetadata).mockResolvedValue({ task_id: TASK_ID } as never);
  vi.mocked(findTaskByPRNumber).mockResolvedValue(TASK_ID);
  vi.mocked(appendGitHubEvent).mockResolvedValue('recorded line');

  const app = express();
  mountGitHubWebhook(app, SECRET);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /webhooks/github rejections', () => {
  it.each([
    ['a signature made with another secret', 'sha256=' + 'a'.repeat(64)],
    ['a malformed signature', 'sha256=short'],
  ])('answers 401 to %s and processes nothing', async (_label, signature) => {
    const res = await deliver('issue_comment', prComment(900), {
      'x-hub-signature-256': signature,
    });
    expect(res.status).toBe(401);
    expect(Task.get).not.toHaveBeenCalled();
    expect(appendGitHubEvent).not.toHaveBeenCalled();
  });

  it('answers 400 when the event type header is missing', async () => {
    const res = await deliver('issue_comment', prComment(900), { 'x-github-event': '' });
    expect(res.status).toBe(400);
    expect(appendGitHubEvent).not.toHaveBeenCalled();
  });

  it('answers 503 during shutdown so GitHub redelivers later', async () => {
    vi.mocked(getIsShuttingDown).mockReturnValue(true);
    const res = await deliver('issue_comment', prComment(900));
    expect(res.status).toBe(503);
    expect(appendGitHubEvent).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github deliveries', () => {
  it('records a PR comment and wakes the PM with the recorded line', async () => {
    const res = await deliver('issue_comment', prComment(900));
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(task.sendMessage).toHaveBeenCalledTimes(1));
    expect(appendGitHubEvent).toHaveBeenCalledWith(TASK_ID, REPO, {
      from: 'alice',
      destination: 'PR #42',
      message: 'please rename this [comment_id=900]',
    });
    expect(task.sendMessage).toHaveBeenCalledWith(expect.stringContaining('recorded line'));
    expect(branchState.last_processed_comment_id).toBe(900);
    expect(task.debouncedSave).toHaveBeenCalled();
  });

  it('ignores a redelivered comment that was already processed', async () => {
    branchState.last_processed_comment_id = 900;
    await deliver('issue_comment', prComment(900));
    await deliver('issue_comment', prComment(901));

    await vi.waitFor(() => expect(task.sendMessage).toHaveBeenCalledTimes(1));
    expect(appendGitHubEvent).toHaveBeenCalledExactlyOnceWith(
      TASK_ID,
      REPO,
      expect.objectContaining({ message: 'please rename this [comment_id=901]' }),
    );
  });

  it('refreshes the PR card immediately when the PR is merged', async () => {
    await deliver('pull_request', {
      action: 'closed',
      pull_request: { number: 42, merged: true, head: { ref: BRANCH } },
    });

    await vi.waitFor(() => expect(task.sendMessage).toHaveBeenCalledTimes(1));
    expect(task.refreshPrCardInPlace).toHaveBeenCalledWith(REPO, 42);
    expect(appendGitHubEvent).toHaveBeenCalledWith(TASK_ID, REPO, {
      from: 'alice',
      destination: 'PR #42',
      message: 'merged',
    });
  });

  it('coalesces a burst of CI events on one branch into a single card refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const checkRun = { check_run: { status: 'completed', check_suite: { head_branch: BRANCH } } };
    await deliver('check_run', { action: 'completed', ...checkRun });
    await deliver('check_run', { action: 'completed', ...checkRun });
    await vi.waitFor(() =>
      expect(logger.system).toHaveBeenCalledWith(
        'GitHub: No action needed for check_run/completed',
      ),
    );
    expect(task.refreshAllPrCards).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500);
    expect(task.refreshAllPrCards).toHaveBeenCalledTimes(1);
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('acknowledges events for branches Archie does not own without touching a task', async () => {
    vi.mocked(findTaskByPRNumber).mockResolvedValue(null);
    const res = await deliver('pull_request_review', {
      action: 'submitted',
      pull_request: { number: 7, head: { ref: 'someone/feature' } },
      review: { state: 'approved' },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() =>
      expect(logger.system).toHaveBeenCalledWith('GitHub: Not our branch pattern'),
    );
    expect(Task.get).not.toHaveBeenCalled();
    expect(checkAndMergeLinkedPRs).not.toHaveBeenCalled();
    expect(appendGitHubEvent).not.toHaveBeenCalled();
  });
});
