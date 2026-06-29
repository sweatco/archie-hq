/**
 * GitHub App Client
 *
 * Wraps @octokit/app for GitHub API operations.
 * Handles authentication, PR management, and webhook verification.
 */

import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import type {
  PRStatus,
  PRReview,
  ReviewThread,
  PRComment,
  MergeableState,
  PRChecksReport,
  PRCheckEntry,
} from '../../agents/tools.js';
import type { PrCardData } from '../../types/task.js';
import { summarizeCi } from '../../system/pr-card-format.js';
import { logger } from '../../system/logger.js';

const execAsync = promisify(exec);

/**
 * Map legacy commit-status state (success/failure/pending/error) onto the
 * check_run-style conclusion vocabulary so consumers see one shape.
 */
function mapStatusStateToConclusion(state: string): PRCheckEntry['conclusion'] {
  switch (state) {
    case 'success': return 'success';
    case 'failure': return 'failure';
    case 'error': return 'failure';
    case 'pending': return null;
    default: return null;
  }
}

export interface GitHubClientConfig {
  appId: string;
  privateKey: string;
  installationId: number;
}

export interface CreatePRResult {
  pr_number: number;
  pr_url: string;
}

export interface PRListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  author: string;
  updated_at: string;
  url: string;
}

export interface PRListFilters {
  state?: 'open' | 'closed' | 'all';
  base?: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
  per_page?: number;
}

export interface PRDetails {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'merged' | 'closed';
  head: string;
  base: string;
  diff: string;
  url: string;
}

export interface CheckRunAnnotation {
  path: string;
  startLine: number | null;
  level: string;
  message: string;
  title?: string;
}

export interface CheckRunReport {
  id: number;
  name: string;
  app: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  url: string | null;
  headSha: string | null;
  startedAt: string | null;
  completedAt: string | null;
  output?: { title?: string; summary?: string; text?: string };
  annotations?: CheckRunAnnotation[];
  logTail?: string;
}

export interface WorkflowJobEntry {
  id: number;
  name: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  url: string | null;
  logTail?: string;
}

export interface WorkflowRunReport {
  id: number;
  name: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  headSha: string | null;
  headBranch: string | null;
  url: string | null;
  jobs: WorkflowJobEntry[];
}

export interface CodeScanningAlertInstance {
  /** Git ref the instance was seen on, e.g. `refs/heads/main`. */
  ref: string | null;
  state: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** The alert message text for this instance. */
  message: string | null;
}

export interface CodeScanningAlert {
  number: number;
  /** open / dismissed / fixed (GitHub may add others). */
  state: string;
  /** Analysis tool that produced the alert, e.g. `CodeQL`. */
  tool: string;
  ruleId: string | null;
  ruleName: string | null;
  ruleDescription: string | null;
  /** Rule severity: none / note / warning / error. */
  severity: string | null;
  /** Security severity: low / medium / high / critical (when classified). */
  securitySeverity: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dismissedReason: string | null;
  dismissedComment: string | null;
  mostRecentInstance: CodeScanningAlertInstance | null;
}

export interface CodeScanningAlertFilters {
  /** Alert state filter. Defaults to `open` at the call site. */
  state?: 'open' | 'dismissed' | 'fixed';
  /** Git ref filter, e.g. `refs/heads/main` or a branch name. */
  ref?: string;
  /** Limit to a single tool, e.g. `CodeQL`. */
  toolName?: string;
  /** Severity filter (critical/high/medium/low or note/warning/error). */
  severity?: string;
  per_page?: number;
}

export interface ParsedCheckRef {
  /** `check_run` covers check-run permalinks and Actions job links (job id == check-run id). */
  kind: 'check_run' | 'workflow_run';
  id: number;
  owner?: string;
  repo?: string;
}

/**
 * Classify a GitHub CI reference — a bare numeric id or a github.com URL — into
 * the id + kind needed to hit the right API.
 *
 * Recognized URL shapes (owner/repo extracted when present):
 * - `.../pull/N/checks?check_run_id=ID`        → check_run
 * - `.../actions/runs/R/job/J` (or `/jobs/J`)  → check_run (J is the job id)
 * - `.../actions/runs/R`                       → workflow_run
 * - `.../runs/ID` (legacy check-run permalink) → check_run
 * - bare `ID`                                  → check_run
 */
export function parseCheckRef(input: string): ParsedCheckRef {
  const trimmed = input.trim();

  let owner: string | undefined;
  let repo: string | undefined;
  const repoMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/i);
  if (repoMatch) {
    owner = repoMatch[1];
    repo = repoMatch[2];
  }

  const checkRunQuery = trimmed.match(/[?&]check_run_id=(\d+)/);
  if (checkRunQuery) {
    return { kind: 'check_run', id: Number(checkRunQuery[1]), owner, repo };
  }

  const jobMatch = trimmed.match(/\/actions\/runs\/\d+\/jobs?\/(\d+)/);
  if (jobMatch) {
    return { kind: 'check_run', id: Number(jobMatch[1]), owner, repo };
  }

  const workflowMatch = trimmed.match(/\/actions\/runs\/(\d+)/);
  if (workflowMatch) {
    return { kind: 'workflow_run', id: Number(workflowMatch[1]), owner, repo };
  }

  const legacyMatch = trimmed.match(/\/runs\/(\d+)/);
  if (legacyMatch) {
    return { kind: 'check_run', id: Number(legacyMatch[1]), owner, repo };
  }

  const bare = trimmed.match(/^(\d+)$/);
  if (bare) {
    return { kind: 'check_run', id: Number(bare[1]) };
  }

  throw new Error(
    `Could not extract a check-run, job, or workflow-run id from: "${input}". ` +
    `Pass a numeric id or a github.com run/check/job URL.`
  );
}

/**
 * Pull the most useful slice out of a raw CI log: the rspec-style "Failures:"
 * block when present, otherwise the tail. Actions logs can be megabytes, so
 * the result is capped.
 */
function extractFailureTail(text: string, maxChars = 15000): string {
  if (!text) return '';
  const marker = text.indexOf('Failures:');
  const slice = marker >= 0 ? text.slice(marker) : text;
  if (slice.length <= maxChars) return slice;
  return marker >= 0
    ? slice.slice(0, maxChars) + '\n…(truncated)'
    : '…(truncated)\n' + slice.slice(slice.length - maxChars);
}

export class GitHubClient {
  private app: App;
  private installationId: number;
  private octokit: Octokit | null = null;

  constructor(config: GitHubClientConfig) {
    this.app = new App({
      appId: config.appId,
      privateKey: config.privateKey,
    });
    this.installationId = config.installationId;
  }

  /**
   * Get authenticated Octokit instance for the installation
   */
  private async getOctokit(): Promise<Octokit> {
    if (!this.octokit) {
      this.octokit = await this.app.getInstallationOctokit(this.installationId);
    }
    return this.octokit;
  }

  /**
   * Parse owner and repo from a full repo identifier (e.g., "acme/backend")
   */
  private parseRepo(githubRepo: string): { owner: string; repo: string } {
    const [owner, repo] = githubRepo.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo format: ${githubRepo}. Expected "owner/repo".`);
    }
    return { owner, repo };
  }

  /**
   * Push a branch to origin
   * Note: This is typically done via git CLI in the worktree,
   * but we provide this for cases where we need to push via API
   */
  async pushBranch(
    githubRepo: string,
    branch: string,
    worktreePath: string
  ): Promise<{ success: boolean; message: string }> {
    // Git push is done via CLI in worktree, not via GitHub API
    // This method is a placeholder that would execute git push
    // The actual implementation happens in task-runtime.ts via exec
    logger.system(`GitHub: pushBranch called for ${githubRepo}:${branch} from ${worktreePath}`);
    return { success: true, message: `Would push ${branch} to ${githubRepo}` };
  }

  /**
   * Create a pull request
   */
  async createPullRequest(
    githubRepo: string,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<CreatePRResult> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    logger.system(`GitHub: Creating PR for ${githubRepo} (${head} -> ${base})`);

    const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title,
      body,
      head,
      base,
    });

    logger.system(`GitHub: Created PR #${response.data.number}`);

    return {
      pr_number: response.data.number,
      pr_url: response.data.html_url,
    };
  }

  /**
   * Get PR status including mergeable state
   */
  async getPRStatus(githubRepo: string, prNumber: number): Promise<PRStatus> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    // Get PR details
    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
    });

    // Get reviews to check approval status
    const reviewsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    // Check if any review is approved (latest per user)
    const reviewsByUser = new Map<string, string>();
    for (const review of reviewsResponse.data) {
      if (review.user?.login && review.state !== 'COMMENTED') {
        reviewsByUser.set(review.user.login, review.state);
      }
    }
    const approved = Array.from(reviewsByUser.values()).some((state) => state === 'APPROVED');

    const pr = prResponse.data;

    // Determine state: GitHub API returns 'open' or 'closed', need to check 'merged' separately
    let state: 'open' | 'merged' | 'closed';
    if (pr.merged) {
      state = 'merged';
    } else {
      state = pr.state as 'open' | 'closed';
    }

    const status: PRStatus = {
      state,
      mergeable: pr.mergeable ?? false,
      mergeableState: (pr.mergeable_state || 'unknown') as MergeableState,
      approved,
    };

    // Detailed logging for debugging merge issues
    logger.system(
      `GitHub: PR #${prNumber} status: ` +
        `state=${status.state}, ` +
        `mergeable=${status.mergeable}, ` +
        `mergeableState=${status.mergeableState}, ` +
        `approved=${status.approved} ` +
        `(raw: merged=${pr.merged}, mergeable_state=${pr.mergeable_state})`
    );

    return status;
  }

  /**
   * Get PR details: title, body, diff, state, head/base branches
   */
  async getPRDetails(githubRepo: string, prNumber: number): Promise<PRDetails> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber,
    });

    // Fetch diff via Accept header
    const diffResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });

    const pr = prResponse.data;
    return {
      number: prNumber,
      title: pr.title,
      body: pr.body || '',
      state: pr.merged ? 'merged' : (pr.state as 'open' | 'closed'),
      head: pr.head.ref,
      base: pr.base.ref,
      diff: String(diffResponse.data),
      url: pr.html_url,
    };
  }

  /**
   * Fetch the compact data shown on a PR card: head branch, state, head sha, and
   * a CI summary (verdict + passed/total counts). Lean by design — the PR
   * endpoint plus `listPRChecks` for CI; avoids `getPRDetails` (full diff).
   */
  async getPRCardData(githubRepo: string, prNumber: number): Promise<PrCardData> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber,
    });
    const pr = prResponse.data;
    const state: PrCardData['state'] = pr.merged ? 'merged' : (pr.state as 'open' | 'closed');

    let ci = { state: 'none' as PrCardData['ci'], passed: 0, total: 0 };
    try {
      const checks = await this.listPRChecks(githubRepo, prNumber);
      ci = summarizeCi(checks.entries);
    } catch (error) {
      // CI is best-effort — a card without a verdict is better than no card.
      logger.warn('GitHub', `Failed to fetch checks for PR #${prNumber} card`, error);
    }

    return {
      repo: githubRepo,
      prNumber,
      url: pr.html_url,
      headRef: pr.head.ref,
      state,
      head_sha: pr.head.sha,
      ci: ci.state,
      ciPassed: ci.passed,
      ciTotal: ci.total,
    };
  }

  /**
   * List PRs with optional filters
   */
  async listPRs(githubRepo: string, filters: PRListFilters = {}): Promise<PRListItem[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
      owner, repo,
      state: filters.state || 'open',
      base: filters.base,
      sort: filters.sort || 'updated',
      direction: filters.direction || 'desc',
      per_page: filters.per_page || 10,
    });

    return response.data.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state as 'open' | 'closed',
      head: pr.head.ref,
      base: pr.base.ref,
      author: pr.user?.login || 'unknown',
      updated_at: pr.updated_at,
      url: pr.html_url,
    }));
  }

  /**
   * Get review-level summary for a PR (approvals, change requests, review bodies).
   * Line-level comments are returned by `getReviewThreads` instead.
   */
  async getPRReviews(githubRepo: string, prNumber: number): Promise<PRReview[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const reviewsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { owner, repo, pull_number: prNumber }
    );

    return reviewsResponse.data.map((review) => ({
      id: String(review.id),
      user: review.user?.login || 'unknown',
      state: this.mapReviewState(review.state),
      body: review.body || '',
      submittedAt: review.submitted_at || '',
    }));
  }

  /**
   * Get all review threads on a PR via GraphQL.
   * Returns thread node IDs (for resolveReviewThread) plus each comment's REST id
   * (for replyToReviewComment via in_reply_to).
   */
  async getReviewThreads(githubRepo: string, prNumber: number): Promise<ReviewThread[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                comments(first: 100) {
                  nodes {
                    databaseId
                    author { login }
                    body
                    createdAt
                    url
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await octokit.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string;
              line: number | null;
              comments: {
                nodes: Array<{
                  databaseId: number;
                  author: { login: string } | null;
                  body: string;
                  createdAt: string;
                  url: string;
                }>;
              };
            }>;
          };
        };
      };
    }>(query, { owner, repo, pr: prNumber });

    return result.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
      threadId: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      comments: thread.comments.nodes.map((c) => ({
        commentId: c.databaseId,
        author: c.author?.login || 'unknown',
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
      })),
    }));
  }

  private mapReviewState(state: string): 'approved' | 'changes_requested' | 'commented' {
    switch (state.toUpperCase()) {
      case 'APPROVED':
        return 'approved';
      case 'CHANGES_REQUESTED':
        return 'changes_requested';
      default:
        return 'commented';
    }
  }

  /**
   * Update PR title, body, and/or base branch.
   */
  async updatePR(
    githubRepo: string,
    prNumber: number,
    fields: { title?: string; body?: string; base?: string }
  ): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);
    const patch: Record<string, string> = {};
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.body !== undefined) patch.body = fields.body;
    if (fields.base !== undefined) patch.base = fields.base;

    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      ...patch,
    });

    logger.system(`GitHub: Updated PR #${prNumber}`);
  }

  /**
   * Add a general comment to a PR (issue comment)
   */
  async addPRComment(githubRepo: string, prNumber: number, comment: string): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo,
      issue_number: prNumber,
      body: comment,
    });

    logger.system(`GitHub: Added comment to PR #${prNumber}`);
  }

  /**
   * Add a review comment on a specific line
   */
  async addReviewComment(
    githubRepo: string,
    prNumber: number,
    path: string,
    line: number,
    comment: string
  ): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    // Get the PR to find the latest commit
    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
    });

    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner,
      repo,
      pull_number: prNumber,
      body: comment,
      commit_id: prResponse.data.head.sha,
      path,
      line,
    });

    logger.system(`GitHub: Added review comment to ${path}:${line} on PR #${prNumber}`);
  }

  /**
   * Resolve a review thread via GraphQL. `threadId` must be the GraphQL node id
   * (e.g. `PRRT_...`) obtained from `getReviewThreads`.
   */
  async resolveReviewThread(
    githubRepo: string,
    prNumber: number,
    threadId: string
  ): Promise<void> {
    const octokit = await this.getOctokit();

    await octokit.graphql(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }`,
      { threadId }
    );

    logger.system(`GitHub: Resolved review thread ${threadId} on PR #${prNumber}`);
  }

  /**
   * Reply to an existing review comment inside its thread.
   * `commentId` is the REST numeric id of any comment in the thread.
   */
  async replyToReviewComment(
    githubRepo: string,
    prNumber: number,
    commentId: number,
    comment: string
  ): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      { owner, repo, pull_number: prNumber, comment_id: commentId, body: comment }
    );

    logger.system(`GitHub: Replied to review comment ${commentId} on PR #${prNumber}`);
  }

  /**
   * Request re-review from previous reviewers
   */
  async requestReReview(githubRepo: string, prNumber: number): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    // Get existing reviews to find reviewers
    const reviewsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    // Get unique reviewers
    const reviewers = new Set<string>();
    for (const review of reviewsResponse.data) {
      if (review.user?.login) {
        reviewers.add(review.user.login);
      }
    }

    if (reviewers.size > 0) {
      await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner,
        repo,
        pull_number: prNumber,
        reviewers: Array.from(reviewers),
      });

      logger.system(`GitHub: Requested re-review from ${Array.from(reviewers).join(', ')}`);
    }
  }

  /**
   * Get top-level PR conversation comments (issue comments on a PR).
   * Returns comments sorted by creation time (oldest first).
   */
  async getPRComments(githubRepo: string, prNumber: number): Promise<PRComment[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner, repo, issue_number: prNumber, per_page: 100 }
    );

    return response.data.map((comment) => ({
      id: comment.id,
      author: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at,
      url: comment.html_url,
    }));
  }

  /**
   * List all checks attached to a PR's HEAD commit.
   *
   * Combines two GitHub APIs:
   * - `/commits/{ref}/check-runs` — modern GitHub Apps (Actions, most CIs)
   * - `/commits/{ref}/status` — legacy commit statuses (older CIs, e.g. CircleCI v1)
   *
   * Both surfaces matter for "is the PR green?": some checks publish only as
   * statuses. Output is normalized to a single `entries[]` shape.
   */
  async listPRChecks(githubRepo: string, prNumber: number): Promise<PRChecksReport> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber,
    });
    const headSha = prResponse.data.head.sha;

    const checkRunsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { owner, repo, ref: headSha, per_page: 100 }
    );

    const statusResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/status',
      { owner, repo, ref: headSha, per_page: 100 }
    );

    const entries: PRCheckEntry[] = [];

    for (const run of checkRunsResponse.data.check_runs) {
      const entry: PRCheckEntry = {
        source: 'check_run',
        name: run.name,
        app: run.app?.slug || 'unknown',
        status: run.status,
        conclusion: run.conclusion as PRCheckEntry['conclusion'],
        url: run.html_url ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
      };
      const output = run.output;
      if (output && (output.title || output.summary || output.text)) {
        entry.output = {
          title: output.title ?? undefined,
          summary: output.summary ?? undefined,
          text: output.text ?? undefined,
        };
      }
      entries.push(entry);
    }

    for (const status of statusResponse.data.statuses) {
      entries.push({
        source: 'status',
        name: status.context,
        app: status.context, // legacy statuses have no app slug
        status: 'completed',
        conclusion: mapStatusStateToConclusion(status.state),
        url: status.target_url ?? null,
        startedAt: status.created_at ?? null,
        completedAt: status.updated_at ?? null,
        output: status.description ? { summary: status.description } : undefined,
      });
    }

    // Log a one-line summary by conclusion for debugging.
    const counts: Record<string, number> = {};
    for (const e of entries) {
      const k = e.conclusion || e.status;
      counts[k] = (counts[k] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
    logger.system(`GitHub: PR #${prNumber} checks (head ${headSha.slice(0, 7)}): ${entries.length} total (${summary})`);

    return { headSha, entries };
  }

  /**
   * Best-effort fetch of an Actions job log tail. For GitHub Actions, a job's
   * id equals its check-run id, so a check-run permalink id works here too.
   * Returns undefined for non-Actions checks (the endpoint 404s) or any error.
   */
  private async tryFetchJobLogTail(owner: string, repo: string, jobId: number): Promise<string | undefined> {
    try {
      const octokit = await this.getOctokit();
      const res = await octokit.request(
        'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
        { owner, repo, job_id: jobId }
      );
      const text = typeof res.data === 'string' ? res.data : '';
      const tail = extractFailureTail(text);
      return tail || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch a single check run by id, resolving the failure detail an agent
   * actually needs: the check output, any annotations, and — for Actions jobs
   * (where job id == check-run id) — the failing slice of the job log.
   */
  async getCheckRunById(githubRepo: string, checkRunId: number): Promise<CheckRunReport> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const res = await octokit.request(
      'GET /repos/{owner}/{repo}/check-runs/{check_run_id}',
      { owner, repo, check_run_id: checkRunId }
    );
    const run = res.data;

    const report: CheckRunReport = {
      id: run.id,
      name: run.name,
      app: run.app?.slug || 'unknown',
      status: run.status,
      conclusion: run.conclusion as PRCheckEntry['conclusion'],
      url: run.html_url ?? null,
      headSha: run.head_sha ?? null,
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
    };

    const output = run.output;
    if (output && (output.title || output.summary || output.text)) {
      report.output = {
        title: output.title ?? undefined,
        summary: output.summary ?? undefined,
        text: output.text ?? undefined,
      };
    }

    if (output?.annotations_count && output.annotations_count > 0) {
      try {
        const ann = await octokit.request(
          'GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations',
          { owner, repo, check_run_id: checkRunId, per_page: 50 }
        );
        report.annotations = ann.data.map((a) => ({
          path: a.path,
          startLine: a.start_line ?? null,
          level: a.annotation_level ?? 'notice',
          message: a.message ?? '',
          title: a.title ?? undefined,
        }));
      } catch {
        // annotations are best-effort
      }
    }

    const logTail = await this.tryFetchJobLogTail(owner, repo, checkRunId);
    if (logTail) report.logTail = logTail;

    logger.system(
      `GitHub: check run ${checkRunId} (${report.name}): ${report.conclusion ?? report.status}` +
      `${report.annotations ? `, ${report.annotations.length} annotations` : ''}` +
      `${report.logTail ? ', log captured' : ''}`
    );

    return report;
  }

  /**
   * Fetch a workflow run by id plus its jobs. Failed jobs include a tail of
   * their log so an agent can see what broke without a PR in hand.
   */
  async getWorkflowRunById(githubRepo: string, runId: number): Promise<WorkflowRunReport> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const runRes = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      { owner, repo, run_id: runId }
    );
    const run = runRes.data;

    const jobsRes = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      { owner, repo, run_id: runId, per_page: 100 }
    );

    const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
    const jobs: WorkflowJobEntry[] = [];
    for (const job of jobsRes.data.jobs) {
      const entry: WorkflowJobEntry = {
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion as PRCheckEntry['conclusion'],
        url: job.html_url ?? null,
      };
      if (job.conclusion && FAILED.has(job.conclusion)) {
        const logTail = await this.tryFetchJobLogTail(owner, repo, job.id);
        if (logTail) entry.logTail = logTail;
      }
      jobs.push(entry);
    }

    logger.system(
      `GitHub: workflow run ${runId} (${run.name ?? 'unknown'}): ` +
      `${run.conclusion ?? run.status}, ${jobs.length} jobs`
    );

    return {
      id: run.id,
      name: run.name ?? 'unknown',
      status: run.status ?? 'unknown',
      conclusion: run.conclusion as PRCheckEntry['conclusion'],
      headSha: run.head_sha ?? null,
      headBranch: run.head_branch ?? null,
      url: run.html_url ?? null,
      jobs,
    };
  }

  /**
   * Normalize a raw code-scanning alert payload (list item or single alert)
   * into the trimmed shape agents consume.
   */
  private mapCodeScanningAlert(a: any): CodeScanningAlert {
    const instance = a.most_recent_instance;
    return {
      number: a.number,
      state: a.state,
      tool: a.tool?.name ?? 'unknown',
      ruleId: a.rule?.id ?? null,
      ruleName: a.rule?.name ?? null,
      ruleDescription: a.rule?.description ?? a.rule?.full_description ?? null,
      severity: a.rule?.severity ?? null,
      securitySeverity: a.rule?.security_severity_level ?? null,
      url: a.html_url ?? null,
      createdAt: a.created_at ?? null,
      updatedAt: a.updated_at ?? null,
      dismissedReason: a.dismissed_reason ?? null,
      dismissedComment: a.dismissed_comment ?? null,
      mostRecentInstance: instance
        ? {
            ref: instance.ref ?? null,
            state: instance.state ?? null,
            path: instance.location?.path ?? null,
            startLine: instance.location?.start_line ?? null,
            endLine: instance.location?.end_line ?? null,
            message: instance.message?.text ?? null,
          }
        : null,
    };
  }

  /**
   * List code scanning (e.g. CodeQL) alerts — the findings shown in a repo's
   * Security tab. Requires the App's "Code scanning alerts" read permission;
   * 403 if it's missing, 404 if code scanning isn't enabled for the repo.
   */
  async listCodeScanningAlerts(
    githubRepo: string,
    filters: CodeScanningAlertFilters = {}
  ): Promise<CodeScanningAlert[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/code-scanning/alerts',
      {
        owner,
        repo,
        state: filters.state,
        ref: filters.ref,
        tool_name: filters.toolName,
        severity: filters.severity,
        sort: 'created',
        direction: 'desc',
        per_page: filters.per_page ?? 30,
      }
    );

    const alerts = response.data.map((a: any) => this.mapCodeScanningAlert(a));
    logger.system(
      `GitHub: code scanning alerts for ${githubRepo}` +
        `${filters.state ? ` (state=${filters.state})` : ''}: ${alerts.length}`
    );
    return alerts;
  }

  /**
   * Fetch a single code scanning alert by its number.
   */
  async getCodeScanningAlert(
    githubRepo: string,
    alertNumber: number
  ): Promise<CodeScanningAlert> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}',
      { owner, repo, alert_number: alertNumber }
    );

    logger.system(`GitHub: code scanning alert #${alertNumber} for ${githubRepo}`);
    return this.mapCodeScanningAlert(response.data);
  }

  /**
   * Close a pull request without merging
   */
  async closePullRequest(githubRepo: string, prNumber: number): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      state: 'closed',
    });
    logger.system(`GitHub: Closed PR #${prNumber}`);
  }

  /**
   * List every repository this GitHub App installation can reach.
   * Used by the PM's `list_available_repos` tool. Paginates the installation
   * repositories endpoint and returns lightweight identifiers.
   */
  async listAccessibleRepos(): Promise<Array<{ github: string; default_branch: string; description?: string }>> {
    const octokit = await this.getOctokit();
    const results: Array<{ github: string; default_branch: string; description?: string }> = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const response = await octokit.request('GET /installation/repositories', {
        per_page: perPage,
        page,
      });
      const repos = (response.data?.repositories ?? []) as Array<{
        full_name: string;
        default_branch: string;
        description?: string | null;
      }>;
      for (const r of repos) {
        results.push({
          github: r.full_name,
          default_branch: r.default_branch,
          description: r.description || undefined,
        });
      }
      if (repos.length < perPage) break;
      page += 1;
    }
    return results;
  }

  /**
   * Resolve a repo's default branch, or null if the installation can't reach it.
   * Used by `spawn_repo_agent` to validate each requested repo is available and
   * to fill in a default base branch.
   */
  async resolveRepo(githubRepo: string): Promise<{ default_branch: string } | null> {
    try {
      const octokit = await this.getOctokit();
      const { owner, repo } = this.parseRepo(githubRepo);
      const response = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      return { default_branch: (response.data as { default_branch: string }).default_branch };
    } catch {
      return null;
    }
  }

  /**
   * Merge a pull request
   */
  async mergePullRequest(
    githubRepo: string,
    prNumber: number,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'
  ): Promise<{ success: boolean; message: string }> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    try {
      await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        owner,
        repo,
        pull_number: prNumber,
        merge_method: mergeMethod,
      });

      logger.system(`GitHub: Merged PR #${prNumber} using ${mergeMethod}`);
      return { success: true, message: `PR #${prNumber} merged successfully` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('GitHub', `Failed to merge PR #${prNumber}: ${message}`);
      return { success: false, message };
    }
  }
}

/**
 * Create a GitHub client from environment variables
 */
export function createGitHubClient(): GitHubClient | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = process.env.GITHUB_INSTALLATION_ID;

  if (!appId || !privateKeyPath || !installationId) {
    logger.warn(
      'GitHub',
      'GitHub App not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_INSTALLATION_ID'
    );
    return null;
  }

  // Read private key from file
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (error) {
    logger.error('GitHub', `Failed to read private key from ${privateKeyPath}`);
    return null;
  }

  return new GitHubClient({
    appId,
    privateKey,
    installationId: parseInt(installationId, 10),
  });
}

/**
 * Get GitHub App bot identity for git commits
 */
export function getGitHubAppIdentity(): { name: string; email: string } | null {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;

  if (!appId || !appSlug) {
    return null;
  }

  return {
    name: `${appSlug}[bot]`,
    email: `${appId}+${appSlug}[bot]@users.noreply.github.com`,
  };
}

/**
 * Configure git identity for a repository using GitHub App bot credentials.
 * Should be called once on server startup for each base repo.
 * Worktrees inherit this config from the base repo.
 */
export async function configureGitIdentity(repoPath: string): Promise<string | null> {
  const identity = getGitHubAppIdentity();
  if (identity) {
    await execAsync(`git config user.name "${identity.name}"`, { cwd: repoPath });
    await execAsync(`git config user.email "${identity.email}"`, { cwd: repoPath });
    return identity.name;
  }
  return null;
}

/**
 * Fetch latest commits from origin.
 * Authentication is handled by GIT_ASKPASS environment variable.
 *
 * @param repoPath - Path to the repository (base repo or worktree)
 * @param branch - Optional branch to fetch. If omitted, fetches all refs.
 */
export async function fetchOrigin(repoPath: string, branch?: string): Promise<void> {
  try {
    const target = branch ? `origin ${branch}` : 'origin';
    await execAsync(`git fetch ${target}`, { cwd: repoPath });
    logger.system(branch ? `Fetched origin/${branch}` : 'Fetched origin');
  } catch (error) {
    // Non-fatal - log and continue with existing refs
    logger.system(branch ? `Fetch failed, using existing origin/${branch}` : 'Fetch failed, using existing refs');
  }
}

// ---- Singleton (merged from github/singleton.ts) ----

let singletonInstance: GitHubClient | null | undefined = undefined;

export function getGitHubClient(): GitHubClient | null {
  if (singletonInstance === undefined) {
    singletonInstance = createGitHubClient();
  }
  return singletonInstance;
}
