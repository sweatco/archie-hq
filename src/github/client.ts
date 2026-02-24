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
import type { PRStatus, PRReview, PRReviewComment, MergeableState } from '../agents/tools.js';
import { logger } from '../system/logger.js';

const execAsync = promisify(exec);

export interface GitHubClientConfig {
  appId: string;
  privateKey: string;
  installationId: number;
}

export interface CreatePRResult {
  pr_number: number;
  pr_url: string;
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
   * Parse owner and repo from a full repo identifier (e.g., "sweatco/backend")
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
   * Get all reviews and comments on a PR
   */
  async getPRReviews(githubRepo: string, prNumber: number): Promise<PRReview[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    // Get reviews
    const reviewsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    // Get review comments
    const commentsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    // Group comments by review
    const commentsByReview = new Map<number, PRReviewComment[]>();
    for (const comment of commentsResponse.data) {
      const reviewId = comment.pull_request_review_id;
      if (reviewId) {
        const existing = commentsByReview.get(reviewId) || [];
        existing.push({
          path: comment.path,
          line: comment.line || comment.original_line || 0,
          body: comment.body,
          threadId: String(comment.id),
        });
        commentsByReview.set(reviewId, existing);
      }
    }

    // Build review objects
    const reviews: PRReview[] = reviewsResponse.data.map((review) => ({
      id: String(review.id),
      user: review.user?.login || 'unknown',
      state: this.mapReviewState(review.state),
      body: review.body || '',
      comments: commentsByReview.get(review.id) || [],
    }));

    return reviews;
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
   * Update PR description
   */
  async updatePRDescription(githubRepo: string, prNumber: number, body: string): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      body,
    });

    logger.system(`GitHub: Updated PR #${prNumber} description`);
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
   * Resolve a review thread (requires GraphQL)
   */
  async resolveReviewThread(
    githubRepo: string,
    prNumber: number,
    threadId: string
  ): Promise<void> {
    const octokit = await this.getOctokit();

    // GraphQL mutation to resolve the thread
    // The threadId here is actually the comment ID, we need to find the thread
    // For now, we'll use the REST API to minimize complexity
    // In production, you'd use GraphQL with the actual thread node ID

    logger.system(
      `GitHub: Resolving review thread ${threadId} on PR #${prNumber} (requires GraphQL in production)`
    );

    // Placeholder - in production, use:
    // await octokit.graphql(`
    //   mutation {
    //     resolveReviewThread(input: {threadId: "${threadId}"}) {
    //       thread { isResolved }
    //     }
    //   }
    // `);
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
   * Get PR comments (issue comments on a PR)
   * Returns comments sorted by creation time (oldest first)
   */
  async getPRComments(
    githubRepo: string,
    prNumber: number
  ): Promise<Array<{ id: number; user: string; body: string; createdAt: string }>> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    return response.data.map((comment) => ({
      id: comment.id,
      user: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at,
    }));
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
function getGitHubAppIdentity(): { name: string; email: string } | null {
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
 * Fetch latest commits from origin for a specific branch.
 * Authentication is handled by GIT_ASKPASS environment variable.
 *
 * @param repoPath - Path to the repository (base repo or worktree)
 * @param branch - Branch to fetch (e.g., 'main')
 */
export async function fetchOrigin(repoPath: string, branch: string): Promise<void> {
  try {
    await execAsync(`git fetch origin ${branch}`, { cwd: repoPath });
    logger.system(`Fetched origin/${branch}`);
  } catch (error) {
    // Non-fatal - log and continue with existing refs
    logger.system(`Fetch failed, using existing origin/${branch}`);
  }
}
