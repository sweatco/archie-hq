/**
 * Git shared clone management.
 *
 * A task gets one independent `git clone --shared` per repo it mounts, and the
 * clone borrows the base repo's object store via alternates (read-only). This
 * provides true filesystem isolation — the clone has its own .git/ directory,
 * refs, index, and HEAD.
 *
 * The task is the isolation boundary, so clone paths are task-keyed
 * (`sessions/{taskId}/repos/{owner}/{repo}`); the caller passes the path in.
 *
 * Replaces the old worktree approach which required shared access to the
 * base repo's .git/ directory and couldn't check out the same branch twice.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../system/logger.js';
import { fetchOrigin, configureGitIdentity, getGitHubClient } from './client.js';
import { hydrateBranchState } from './branch-state.js';
import type { AttachedRepo, BranchState } from '../../types/task.js';

const execAsync = promisify(exec);

// Re-export for backwards compatibility
export { fetchOrigin };

export function githubRepoToUrl(githubRepo: string): string {
  return `https://github.com/${githubRepo}.git`;
}

// ---- Types ----

export interface CloneResult {
  clone_path: string;
  branch: string;       // branch checked out (feature or base)
  base_branch: string;
}

export type CloneCheckout =
  | { type: 'new_branch'; name: string }   // RW fresh: clone base, create branch
  | { type: 'branch'; name: string }       // RW resume or visit: clone on existing branch
  | { type: 'base' };                      // RO default: clone on base branch

// ---- Git helpers ----

export async function gitExec(cwd: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd });
    return stdout.trim();
  } catch (error: any) {
    if (error.stderr) {
      logger.error('repo-clone', `git command failed: git ${args}`);
      logger.error('repo-clone', `stderr: ${error.stderr}`);
    }
    throw error;
  }
}

/**
 * The branch a repo forks from, for callers that hold only its github id —
 * resolved the way `mount_repo` resolves it: ask GitHub for the repository
 * default; if that is unavailable (no App installation, network trouble), fall
 * back to what an existing clone already has checked out, and only then to
 * 'main'. Never throws: every failure degrades to the next fallback.
 */
export async function resolveBaseBranch(github: string, clonePath?: string): Promise<string> {
  const fromGitHub = (await getGitHubClient()?.resolveRepo(github))?.default_branch;
  if (fromGitHub) return fromGitHub;
  if (clonePath) {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: clonePath });
      const branch = stdout.trim();
      // Detached HEAD reports 'HEAD', which is not a branch name to check out.
      if (branch && branch !== 'HEAD') return branch;
    } catch {
      // No clone there, or an unreadable one — fall through to the last resort.
    }
  }
  logger.warn('repo-clone', `Could not resolve a default branch for ${github}, assuming 'main'`);
  return 'main';
}

async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await gitExec(repoPath, 'symbolic-ref refs/remotes/origin/HEAD --short');
    return ref.replace('origin/', '');
  } catch {
    try {
      await gitExec(repoPath, 'rev-parse --verify origin/main');
      return 'main';
    } catch {
      try {
        await gitExec(repoPath, 'rev-parse --verify origin/master');
        return 'master';
      } catch {
        logger.system(`Could not detect default branch, falling back to 'main'`);
        return 'main';
      }
    }
  }
}

// ---- Shared clone setup ----

/**
 * Ensure the base cache exists at `baseRepoPath` by cloning from GitHub on
 * first use. Startup warm-cloning covers the repos a deployment names up
 * front, but `mount_repo` can name any repo the GitHub App can reach — this is
 * the lazy fallback for one whose base cache was never created.
 *
 * No-op when the cache already exists. Requires `githubRepo` to be set,
 * since that's the only way we know what to clone from.
 */
async function ensureBaseCache(
  baseRepoPath: string,
  githubRepo: string | undefined,
  baseBranch: string | undefined,
): Promise<void> {
  const gitDir = path.join(baseRepoPath, '.git');
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isDirectory()) return; // already present
  } catch {
    // Falls through to clone
  }

  if (!githubRepo) {
    throw new Error(
      `Base cache missing at ${baseRepoPath} and no githubRepo provided — cannot lazy-clone.`,
    );
  }

  const url = githubRepoToUrl(githubRepo);
  await fs.mkdir(path.dirname(baseRepoPath), { recursive: true });
  const branchFlag = baseBranch ? ` -b "${baseBranch}"` : '';
  logger.system(`Base cache missing for ${githubRepo} — cloning from ${url}`);
  await execAsync(`git clone${branchFlag} "${url}" "${baseRepoPath}"`);
  logger.system(`Created base cache at ${baseRepoPath}`);
}

/**
 * Create a shared clone at the given path.
 *
 * Uses `git clone --shared` which creates an independent repository that
 * borrows the base repo's object store via an alternates file (read-only).
 * The clone gets its own .git/ directory, refs, index, and remote pointing
 * to GitHub. The caller is responsible for choosing where the clone lives —
 * `setupSharedClone` mkdir-p's the parent and clones into `clonePath`.
 *
 * If the base cache at `baseRepoPath` doesn't exist yet (a repo mounted at
 * runtime that startup never warmed), it's lazily cloned from `githubRepo` first.
 */
export async function setupSharedClone(
  clonePath: string,
  baseRepoPath: string,
  checkout: CloneCheckout,
  baseBranch?: string,
  githubRepo?: string,
): Promise<CloneResult> {
  // Lazy-clone the base cache if missing. Must happen before any operation
  // that reads from `baseRepoPath` (fetchOrigin, getDefaultBranch, git clone
  // --shared) — all of those require an existing git repo.
  await ensureBaseCache(baseRepoPath, githubRepo, baseBranch);

  const defaultBranch = baseBranch || await getDefaultBranch(baseRepoPath);
  const githubUrl = githubRepo ? githubRepoToUrl(githubRepo) : undefined;
  const label = githubRepo || clonePath;

  await fetchOrigin(baseRepoPath);
  await fs.mkdir(path.dirname(clonePath), { recursive: true });

  // Determine which branch to clone and what to do after
  let cloneBranch: string;
  let resultBranch: string;

  if (checkout.type === 'new_branch') {
    logger.system(`Creating shared clone for ${label} (new branch: ${checkout.name})`);
    cloneBranch = defaultBranch;
    resultBranch = checkout.name;
  } else if (checkout.type === 'branch') {
    logger.system(`Creating shared clone for ${label} (branch: ${checkout.name})`);
    await fetchOrigin(baseRepoPath, checkout.name);
    cloneBranch = checkout.name;
    resultBranch = checkout.name;
  } else {
    logger.system(`Creating shared clone for ${label} (base: ${defaultBranch})`);
    cloneBranch = defaultBranch;
    resultBranch = defaultBranch;
  }

  // Update the base repo's local branch to match remote before cloning from it
  // (git clone --shared clones from local branches, not remote tracking refs)
  try {
    await gitExec(baseRepoPath, `checkout "${cloneBranch}"`);
    await gitExec(baseRepoPath, `reset --hard "origin/${cloneBranch}"`);
  } catch {
    // Non-fatal — clone will use whatever state the base repo has
  }

  // Clone and initialize submodules (before remote change, so submodules resolve from local base repo)
  await execAsync(`git clone --shared --branch ${cloneBranch} "${baseRepoPath}" "${clonePath}"`);
  await gitExec(clonePath, 'submodule update --init --recursive').catch(() => {});
  if (githubUrl) {
    await gitExec(clonePath, `remote set-url origin ${githubUrl}`);
  }
  // Create feature branch if needed
  if (checkout.type === 'new_branch') {
    await gitExec(clonePath, `checkout -b ${checkout.name}`);
  }

  return { clone_path: clonePath, branch: resultBranch, base_branch: defaultBranch };
}

// ---- Task-clone lifecycle ----

/**
 * Which branch a task's clone of a repo belongs on, given the task's edit mode
 * and whatever branch state the task already carries for that repo.
 *
 * Read-only tasks sit on the repository's base branch. In edit mode the task
 * works on its own branch: `taskBranch` cut from base the first time, and the
 * branch the task was last on whenever it is re-created later.
 *
 * A branch the task actually worked on always has a `branch_states` entry —
 * that is where its base branch, PR number and stash live — while a clone
 * sitting on the repository's base branch has none. So the presence of an
 * entry is what distinguishes "restore this branch" from "cut the task branch
 * from base"; `current_branch` alone cannot, because it also names the base
 * branch a read-only clone is parked on.
 *
 * Pure: no filesystem, no git. This is the one place the mapping lives, so the
 * mount tool and the edit-mode approval path cannot drift apart.
 */
export function decideCloneCheckout(opts: {
  editAllowed: boolean;
  taskBranch: string;
  currentBranch?: string;
  branchStates?: Record<string, BranchState>;
}): CloneCheckout {
  if (!opts.editAllowed) return { type: 'base' };
  const previous = opts.currentBranch;
  if (previous && opts.branchStates?.[previous]) return { type: 'branch', name: previous };
  return { type: 'new_branch', name: opts.taskBranch };
}

/** The branch a clone currently has checked out, or undefined if unreadable. */
async function readCurrentBranch(clonePath: string): Promise<string | undefined> {
  try {
    const branch = await gitExec(clonePath, 'rev-parse --abbrev-ref HEAD');
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The base branch recorded for a mounted repo, or undefined when the task has
 * never mounted it.
 *
 * A clone parked on the repository's base branch records that branch in
 * `current_branch` with no `branch_states` entry, so the entry's absence is
 * what says "this IS the base branch" rather than "a feature branch whose base
 * we forgot".
 */
export function recordedBaseBranch(attached: AttachedRepo): string | undefined {
  const current = attached.current_branch;
  if (!current) return undefined;
  const state = attached.branch_states?.[current];
  return state ? state.base_branch : current;
}

export interface EnsureTaskCloneResult extends CloneResult {
  /** True when this call created the clone; false when an existing one was reused. */
  created: boolean;
}

/**
 * Ensure a task has a usable clone of one repo, and leave `attached` describing it.
 *
 * Reuses a clone that is already on disk (it may hold un-pushed commits) and
 * otherwise creates one on the branch {@link decideCloneCheckout} picks.
 * Mutates `attached` in place — `base_path`, `clone_path`, `current_branch`
 * and `branch_states` — so the caller only has to persist metadata afterwards.
 *
 * Idempotent: calling it again for a repo already mounted returns the same
 * clone. When edit mode has since been approved and the reused clone is still
 * parked on the base branch, the task branch is cut in place, so a second
 * mount after approval lands the caller where its commits belong.
 */
export async function ensureTaskClone(opts: {
  attached: AttachedRepo;
  /** Canonical task-keyed path for this clone (`getTaskClonePath`). */
  clonePath: string;
  /** Base cache this clone borrows objects from. */
  baseRepoPath: string;
  editAllowed: boolean;
  /** Branch name to cut on the first edit-mode mount (`archie/{taskId}`). */
  taskBranch: string;
  /** Repository base branch when already known (e.g. the GitHub default branch). */
  baseBranch?: string;
}): Promise<EnsureTaskCloneResult> {
  const { attached, baseRepoPath, editAllowed, taskBranch } = opts;
  attached.base_path = baseRepoPath;

  // Prefer the recorded path — a migrated task may hold a clone somewhere other
  // than today's canonical location — then the canonical path, which is where a
  // clone left behind by an interrupted mount would be.
  let existing: string | undefined;
  if (attached.clone_path && await cloneExists(attached.clone_path)) {
    existing = attached.clone_path;
  } else if (await cloneExists(opts.clonePath)) {
    existing = opts.clonePath;
  }

  if (existing) {
    attached.clone_path = existing;
    // Unconditionally, as the old per-agent spawn did: a clone left behind by an
    // interrupted mount, or one whose config predates the current attribution
    // identity, would otherwise commit as whoever git falls back to.
    await configureGitIdentity(existing);
    const branch = attached.current_branch ?? await readCurrentBranch(existing);
    if (branch) attached.current_branch = branch;
    const base = recordedBaseBranch(attached) ?? opts.baseBranch ?? await getDefaultBranch(baseRepoPath);
    // Edit mode approved while this clone sat on base: cut the task branch now,
    // so the reuse path does not hand back a checkout the task cannot commit on.
    if (editAllowed && branch && !attached.branch_states?.[branch]) {
      const moved = await checkoutTaskBranch(existing, taskBranch);
      if (moved) {
        hydrateBranchState(attached, taskBranch, base);
        logger.system(`Clone at ${existing} moved onto ${taskBranch} for edit mode`);
        return { clone_path: existing, branch: taskBranch, base_branch: base, created: false };
      }
    }
    return { clone_path: existing, branch: branch ?? base, base_branch: base, created: false };
  }

  const checkout = decideCloneCheckout({
    editAllowed,
    taskBranch,
    currentBranch: attached.current_branch,
    branchStates: attached.branch_states,
  });
  // A restored feature branch forks from whatever it forked from originally;
  // anything else uses the caller's known base, and `setupSharedClone`
  // discovers the repository default when neither is known.
  const baseBranch = recordedBaseBranch(attached) ?? opts.baseBranch;

  const result = await setupSharedClone(
    opts.clonePath, baseRepoPath, checkout, baseBranch, attached.github,
  );
  attached.clone_path = result.clone_path;
  if (result.branch !== result.base_branch) {
    hydrateBranchState(attached, result.branch, result.base_branch);
  } else {
    attached.current_branch = result.branch;
  }
  await configureGitIdentity(result.clone_path);
  return { ...result, created: true };
}

/**
 * Move an existing clone onto the task branch, creating it if needed.
 *
 * Switching to the branch is tried first and creation is the fallback, so a
 * task branch that already exists locally — with commits on it — is joined
 * rather than reset to the base commit.
 */
async function checkoutTaskBranch(clonePath: string, taskBranch: string): Promise<boolean> {
  try {
    await gitExec(clonePath, `checkout ${taskBranch}`).catch(() =>
      gitExec(clonePath, `checkout -b ${taskBranch}`),
    );
    return true;
  } catch (error) {
    logger.error('repo-clone', `Could not move ${clonePath} onto ${taskBranch}`);
    logger.error('repo-clone', error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ---- Detection helpers ----

/**
 * Check if a shared clone exists at the given path.
 * Shared clones have a .git directory (not a file like worktrees).
 */
export async function cloneExists(clonePath: string): Promise<boolean> {
  try {
    const gitPath = path.join(clonePath, '.git');
    const stat = await fs.stat(gitPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ---- Cleanup ----

/**
 * Remove a shared clone. Simple rm -rf — no git bookkeeping needed.
 */
export async function removeClone(clonePath: string): Promise<void> {
  await fs.rm(clonePath, { recursive: true, force: true });
  logger.system(`Removed clone at ${clonePath}`);
}
