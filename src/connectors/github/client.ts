/**
 * GitHub App Client
 *
 * Wraps @octokit/app for GitHub API operations.
 * Handles authentication, PR management, and webhook verification.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import type { PRStatus, MergeableState, PRChecksReport, PRCheckEntry } from '../../agents/tools.js';
import type { PrCardData } from '../../types/task.js';
import { summarizeCi } from '../../system/pr-card-format.js';
import { logger } from '../../system/logger.js';
import { sandboxReadPermissions } from './sandbox-token.js';

const execFileAsync = promisify(execFile);

/**
 * Map legacy commit-status state (success/failure/pending/error) onto the
 * check_run-style conclusion vocabulary so consumers see one shape.
 */
function mapStatusStateToConclusion(state: string): PRCheckEntry['conclusion'] {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'error':
      return 'failure';
    case 'pending':
      return null;
    default:
      return null;
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
    worktreePath: string,
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
    body: string,
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
      },
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
        `(raw: merged=${pr.merged}, mergeable_state=${pr.mergeable_state})`,
    );

    return status;
  }

  /**
   * Fetch the compact data shown on a PR card: head branch, state, head sha, and
   * a CI summary (verdict + passed/total counts). Lean by design — the PR
   * endpoint plus `listPRChecks` for CI.
   */
  async getPRCardData(githubRepo: string, prNumber: number): Promise<PrCardData> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
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
   * Update PR title, body, and/or base branch.
   */
  async updatePR(
    githubRepo: string,
    prNumber: number,
    fields: { title?: string; body?: string; base?: string },
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
    comment: string,
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
   * (e.g. `PRRT_...`).
   *
   * `githubRepo` is unused — the GraphQL node id already addresses the thread —
   * but is kept so every PR method on this client takes the same
   * `(githubRepo, prNumber, …)` shape callers rely on.
   */
  async resolveReviewThread(
    _githubRepo: string,
    prNumber: number,
    threadId: string,
  ): Promise<void> {
    const octokit = await this.getOctokit();

    await octokit.graphql(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }`,
      { threadId },
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
    comment: string,
  ): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = this.parseRepo(githubRepo);

    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      { owner, repo, pull_number: prNumber, comment_id: commentId, body: comment },
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
      },
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
      owner,
      repo,
      pull_number: prNumber,
    });
    const headSha = prResponse.data.head.sha;

    const checkRunsResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { owner, repo, ref: headSha, per_page: 100 },
    );

    const statusResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });

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
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    logger.system(
      `GitHub: PR #${prNumber} checks (head ${headSha.slice(0, 7)}): ${entries.length} total (${summary})`,
    );

    return { headSha, entries };
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
  async listAccessibleRepos(): Promise<
    Array<{ github: string; default_branch: string; description?: string }>
  > {
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

  /** Never hand a session the cached installation token: it can write. */
  async mintSandboxReadToken(): Promise<string> {
    const installation = await this.app.octokit.request(
      'GET /app/installations/{installation_id}',
      { installation_id: this.installationId },
    );
    const accessToken = await this.app.octokit.request(
      'POST /app/installations/{installation_id}/access_tokens',
      {
        installation_id: this.installationId,
        permissions: sandboxReadPermissions(installation.data.permissions),
      },
    );
    return accessToken.data.token;
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
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash',
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
      'GitHub App not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_INSTALLATION_ID',
    );
    return null;
  }

  // Read private key from file
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch {
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
 * The GitHub App bot's name and commit address.
 *
 * Only a fallback now — `getArchieAttributionIdentity()` returns this when the
 * attribution account isn't configured, so a deployment without those vars keeps
 * its prior behaviour. Nothing credits the bot deliberately: the numeric prefix
 * below is `GITHUB_APP_ID`, which is not a user ID, so GitHub resolves the
 * address to no account. See `getArchieAttributionIdentity()`.
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
 * The identity Archie is *credited* as on GitHub: the committer on every commit
 * (via `configureGitIdentity`), the `Co-Authored-By` trailer on repo-agent commits,
 * and the attribution block on PR bodies.
 *
 * Deliberately separate from `getGitHubAppIdentity()`, which is the identity Archie
 * *acts* as — the installation its API calls and git transport authenticate with.
 * Credit points at the real
 * `archie-hq` user account instead, for two reasons a bot account can't satisfy:
 * a GitHub App bot cannot be @mentioned at all, and its profile is an app page
 * rather than an account. Attribution needs no repository access, so this works
 * without granting the account anything.
 *
 * The numeric prefix must be the account's **user** ID. GitHub resolves the
 * `<id>+<login>@users.noreply.github.com` form by ID and silently drops the credit
 * when the ID disagrees with the login — it does not fall back to matching the
 * login. The bot form above synthesizes that prefix from `GITHUB_APP_ID`, which is
 * not a user ID (for this App: 2605869 vs. the bot user's 253344994), so every
 * `Co-Authored-By` line Archie has written resolved to no account: PR #264's
 * co-author comes back from the API with `login: ""`.
 *
 * Falls back to the App bot when the attribution account isn't configured, so a
 * deployment without the new vars keeps its current behaviour instead of losing
 * the trailer.
 */
export interface ArchieIdentity {
  /** Display name for the commit trailer and footer link text. */
  name: string;
  /** noreply address GitHub resolves to the account. */
  email: string;
  /** `@mention` form — GitHub auto-links it to the profile. A bot login is left bare; bots aren't mentionable. */
  mention: string;
}

export function getArchieAttributionIdentity(): ArchieIdentity | null {
  const login = process.env.ARCHIE_GITHUB_LOGIN?.trim();
  const userId = process.env.ARCHIE_GITHUB_USER_ID?.trim();

  // Both are required, and the ID must be numeric: a non-numeric or absent ID
  // would produce an address that looks right and credits nobody, which is the
  // exact failure this function exists to correct. Prefer the visibly-degraded
  // bot fallback over a silent one.
  if (login && userId && /^[0-9]+$/.test(userId)) {
    return {
      name: process.env.ARCHIE_GITHUB_NAME?.trim() || login,
      email: `${userId}+${login}@users.noreply.github.com`,
      mention: `@${login}`,
    };
  }

  const bot = getGitHubAppIdentity();
  if (!bot) return null;
  return {
    name: bot.name,
    email: bot.email,
    mention: bot.name,
  };
}

/**
 * Root every repo path must live under. Read per call rather than imported from
 * `system/workdir.ts` (which imports this module transitively) — keep the two
 * in step if the default ever changes.
 */
function workdirRoot(): string {
  return path.resolve(process.env.ARCHIE_WORKDIR || path.join(process.cwd(), 'workdir'));
}

/**
 * Delete an orphaned `config.lock` from a repo, if it has one.
 *
 * `git config` takes that lock for every write, and a hard kill mid-write
 * orphans it — after which every `git config` in the repo fails ("could not
 * lock config file"), including on the next boot, since nothing else cleans it
 * up. That cost task-20260804-1050-iat4s8 two agents during startup recovery.
 *
 * Repo paths originate in task and plugin input, so the resolved lock path is
 * confined to the workdir before anything is unlinked; a path pointing outside
 * it is left alone. Removing a lock a live `git` still holds makes that
 * writer's rename fail rather than corrupting the config, and every writer here
 * sets the same bot identity, so no staleness check is needed.
 */
async function dropOrphanedConfigLock(repoPath: string): Promise<void> {
  const root = workdirRoot();
  const lockPath = path.resolve(repoPath, '.git', 'config.lock');
  if (!lockPath.startsWith(root + path.sep)) {
    logger.warn('github', `Skipped config lock cleanup outside the workdir: ${lockPath}`);
    return;
  }
  await fs.promises.rm(lockPath, { force: true });
}

/**
 * Write Archie's git identity into a repository — the committer on every commit
 * made there, and the author too on the commits `buildCommitAuthorEnv` leaves
 * unattributed (no approver recorded: CLI approvals, pre-feature tasks).
 *
 * Uses the attribution account rather than the App bot, because both of those
 * roles are Archie being *credited*, not Archie authenticating. Push auth is the
 * installation token via `GIT_ASKPASS` and GitHub does not require the committer
 * to match the pusher, so the two are free to differ — and the App bot's synthetic
 * address resolves to no account at all (see `getArchieAttributionIdentity`),
 * which left every commit's committer line unlinked.
 *
 * Called once on server startup for each base repo; worktrees inherit the config.
 */
export async function configureGitIdentity(repoPath: string): Promise<string | null> {
  const identity = getArchieAttributionIdentity();
  if (identity) {
    await dropOrphanedConfigLock(repoPath);
    await execFileAsync('git', ['config', 'user.name', identity.name], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.email', identity.email], { cwd: repoPath });
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
    const refArgs = branch ? [branch] : [];
    await execFileAsync('git', ['fetch', '--', 'origin', ...refArgs], { cwd: repoPath });
    logger.system(branch ? `Fetched origin/${branch}` : 'Fetched origin');
  } catch {
    // Non-fatal - log and continue with existing refs
    logger.system(
      branch
        ? `Fetch failed, using existing origin/${branch}`
        : 'Fetch failed, using existing refs',
    );
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
