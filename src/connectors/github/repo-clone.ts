/**
 * Git shared clone management for repo agents.
 *
 * Each agent gets an independent `git clone --shared` that borrows the base
 * repo's object store via alternates (read-only). This provides true filesystem
 * isolation — the clone has its own .git/ directory, refs, index, and HEAD.
 *
 * Replaces the old worktree approach which required shared access to the
 * base repo's .git/ directory and couldn't check out the same branch twice.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../system/logger.js';
import { fetchOrigin } from './client.js';

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
 * first use. The startup `cloneRepos()` pre-warms every plugin-declared repo,
 * but PM-spawned dynamic agents and runtime plugin refreshes can reference
 * repos whose base cache was never created — this is the lazy fallback.
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
 * Create a shared clone for a repo agent at the given path.
 *
 * Uses `git clone --shared` which creates an independent repository that
 * borrows the base repo's object store via an alternates file (read-only).
 * The clone gets its own .git/ directory, refs, index, and remote pointing
 * to GitHub. The caller is responsible for choosing where the clone lives —
 * `setupSharedClone` mkdir-p's the parent and clones into `clonePath`.
 *
 * If the base cache at `baseRepoPath` doesn't exist yet (PM-spawned dynamic
 * agent, plugin added at runtime), it's lazily cloned from `githubRepo` first.
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

// ---- Post-clone configuration ----

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
