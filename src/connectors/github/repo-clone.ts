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
import type { RepositoryInfo } from '../../types/task.js';

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
 * Create a shared clone for a repo agent.
 *
 * Uses `git clone --shared` which creates an independent repository that
 * borrows the base repo's object store via an alternates file (read-only).
 * The clone gets its own .git/ directory, refs, index, and remote pointing
 * to GitHub.
 */
export async function setupSharedClone(
  repoKey: string,
  reposPath: string,
  baseRepoPath: string,
  checkout: CloneCheckout,
  baseBranch?: string,
  githubRepo?: string,
): Promise<CloneResult> {
  const defaultBranch = baseBranch || await getDefaultBranch(baseRepoPath);
  const githubUrl = githubRepo ? githubRepoToUrl(githubRepo) : undefined;

  await fetchOrigin(baseRepoPath);
  await fs.mkdir(reposPath, { recursive: true });
  const clonePath = path.join(reposPath, repoKey);

  // Determine which branch to clone and what to do after
  let cloneBranch: string;
  let resultBranch: string;

  if (checkout.type === 'new_branch') {
    logger.system(`Creating shared clone for ${repoKey} (new branch: ${checkout.name})`);
    cloneBranch = defaultBranch;
    resultBranch = checkout.name;
  } else if (checkout.type === 'branch') {
    logger.system(`Creating shared clone for ${repoKey} (branch: ${checkout.name})`);
    await fetchOrigin(baseRepoPath, checkout.name);
    cloneBranch = checkout.name;
    resultBranch = checkout.name;
  } else {
    logger.system(`Creating shared clone for ${repoKey} (base: ${defaultBranch})`);
    cloneBranch = defaultBranch;
    resultBranch = defaultBranch;
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

const SANDBOX_EXCLUDES = [
  '.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile',
  '.gitconfig', '.gitmodules', '.mcp.json', '.ripgreprc', '.idea', 'CLAUDE.md',
];

/**
 * Add bwrap sandbox artifacts to .git/info/exclude so they don't pollute git status.
 * Uses .git/info/exclude (per-repo, not committed) because bwrap overrides $HOME/.gitconfig
 * inside the sandbox, making global excludes ineffective.
 */
export async function configureSandboxExcludes(clonePath: string): Promise<void> {
  const excludeFile = path.join(clonePath, '.git', 'info', 'exclude');
  await fs.mkdir(path.join(clonePath, '.git', 'info'), { recursive: true });
  await fs.writeFile(excludeFile, `# bwrap sandbox artifacts\n${SANDBOX_EXCLUDES.join('\n')}\n`);
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

/**
 * Check if a path is a git worktree (legacy, for migration).
 * Worktrees have a .git file containing "gitdir: ..." pointer.
 */
export async function isWorktree(repoPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(repoPath, '.git');
    const stat = await fs.stat(gitPath);
    return stat.isFile();
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

// ---- Migration (worktree → shared clone) ----

/**
 * Migrate an existing worktree to a shared clone.
 *
 * For RO tasks: just delete and re-clone on base branch.
 * For RW tasks: capture uncommitted work, push branch if needed,
 * delete worktree, create shared clone, re-apply patch.
 *
 * Runs in spawn code (not sandboxed), has full git access via GIT_ASKPASS.
 */
export async function migrateWorktreeToClone(
  repoKey: string,
  reposPath: string,
  baseRepoPath: string,
  baseBranch: string,
  githubRepo: string,
  repoInfo: RepositoryInfo,
  editAllowed: boolean,
): Promise<CloneResult> {
  const clonePath = path.join(reposPath, repoKey);
  const branch = repoInfo.current_branch || repoInfo.feature_branch || baseBranch;
  const isRW = editAllowed && branch !== baseBranch;

  logger.system(`Migrating worktree to shared clone for ${repoKey} (${isRW ? 'RW' : 'RO'}, branch: ${branch})`);

  try {
    if (!isRW) {
      // On base branch or RO — delete worktree and create fresh clone on base
      logger.system(`[migrate] Deleting worktree and creating fresh clone on ${baseBranch}`);
      await removeWorktreeSafely(baseRepoPath, clonePath);
      logger.system(`[migrate] Worktree removed, creating shared clone`);
      const result = await setupSharedClone(repoKey, reposPath, baseRepoPath, { type: 'base' }, baseBranch, githubRepo);
      logger.system(`[migrate] Migration complete → ${result.clone_path} (${result.branch})`);
      return result;
    }

    // RW path — preserve branch and uncommitted work
    logger.system(`[migrate] RW mode — preserving branch ${branch} and uncommitted work`);

    let patch = '';
    try {
      // Stage everything (including untracked files) so diff captures all work
      await gitExec(clonePath, 'add -A');
      // Use execAsync directly — gitExec trims stdout, which corrupts the patch
      const { stdout } = await execAsync('git diff --cached HEAD', { cwd: clonePath });
      patch = stdout;
      logger.system(`[migrate] Captured patch: ${patch.trim() ? `${patch.split('\n').length} lines` : 'empty (no uncommitted changes)'}`);
    } catch (error) {
      logger.warn('repo-clone', `[migrate] Failed to capture diff: ${error}`);
    }

    // Remove worktree (branch refs are in the base repo, shared clone will find them locally)
    logger.system(`[migrate] Removing worktree at ${clonePath}`);
    await removeWorktreeSafely(baseRepoPath, clonePath);
    logger.system(`[migrate] Worktree removed`);

    // Create shared clone on the branch
    logger.system(`[migrate] Creating shared clone on branch ${branch}`);
    const result = await setupSharedClone(repoKey, reposPath, baseRepoPath, { type: 'branch', name: branch }, baseBranch, githubRepo);
    logger.system(`[migrate] Shared clone created at ${result.clone_path}`);

    // Apply patch if non-empty
    if (patch.trim()) {
      const patchFile = path.join(reposPath, `${repoKey}-migration.patch`);
      logger.system(`[migrate] Applying ${patch.split('\n').length}-line patch to preserve uncommitted work`);
      try {
        await fs.writeFile(patchFile, patch);
        await gitExec(clonePath, `apply "${patchFile}"`);
        logger.system(`[migrate] Patch applied successfully`);
      } catch (error) {
        logger.warn('repo-clone', `[migrate] Failed to apply patch: ${error}`);
      } finally {
        await fs.rm(patchFile, { force: true });
      }
    } else {
      logger.system(`[migrate] No uncommitted changes to restore`);
    }

    logger.system(`[migrate] RW migration complete → ${result.clone_path} (${result.branch})`);
    return result;
  } catch (error) {
    logger.error('repo-clone', `[migrate] Migration failed for ${repoKey}: ${error}`);
    logger.system(`[migrate] Falling back to fresh clone on ${baseBranch}`);

    // Ensure the path is clean
    await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
    return await setupSharedClone(repoKey, reposPath, baseRepoPath, { type: 'base' }, baseBranch, githubRepo);
  }
}

/**
 * Remove a worktree via git, then prune stale entries.
 */
async function removeWorktreeSafely(baseRepoPath: string, worktreePath: string): Promise<void> {
  try {
    await gitExec(baseRepoPath, `worktree remove --force "${worktreePath}"`);
  } catch {
    // If worktree remove fails, force-delete and prune
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  try {
    await gitExec(baseRepoPath, 'worktree prune');
  } catch {
    // Best effort
  }
}
