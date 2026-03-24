/**
 * Git worktree management for edit mode
 *
 * Handles creation of isolated worktrees for repo agents to make changes
 * without affecting the base repository.
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

export interface WorktreeResult {
  worktree_path: string;
  feature_branch?: string;    // undefined when created in detached HEAD mode
  base_branch: string;
}

/**
 * Execute a git command in a directory
 */
export async function gitExec(cwd: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd });
    return stdout.trim();
  } catch (error: any) {
    // Only log stderr when command fails
    if (error.stderr) {
      logger.error('worktree-manager', `git command failed: git ${args}`);
      logger.error('worktree-manager', `stderr: ${error.stderr}`);
    }
    throw error;
  }
}

/**
 * Detect the default branch for a repository (main, master, etc.)
 * Uses git symbolic-ref to check what origin/HEAD points to
 */
async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    // Try to get the default branch from origin/HEAD
    const ref = await gitExec(repoPath, 'symbolic-ref refs/remotes/origin/HEAD --short');
    // Returns "origin/main" or "origin/master" - extract branch name
    return ref.replace('origin/', '');
  } catch {
    // If origin/HEAD is not set, try common defaults
    try {
      await gitExec(repoPath, 'rev-parse --verify origin/main');
      return 'main';
    } catch {
      try {
        await gitExec(repoPath, 'rev-parse --verify origin/master');
        return 'master';
      } catch {
        // Last resort fallback
        logger.worktree(`Could not detect default branch, falling back to 'main'`);
        return 'main';
      }
    }
  }
}

/**
 * Checkout target for worktree creation.
 *
 * - `{ type: 'detached' }` — detached HEAD at origin/{baseBranch}
 * - `{ type: 'detached', sha }` — detached HEAD at specific commit
 * - `{ type: 'branch', name }` — checkout existing branch (normal)
 * - `{ type: 'new_branch', name }` — create new branch from origin/{baseBranch}
 */
export type WorktreeCheckout =
  | { type: 'detached'; sha?: string }
  | { type: 'branch'; name: string }
  | { type: 'new_branch'; name: string };

/**
 * Setup worktree for a repository in a task.
 *
 * @param repoKey - Repository key (e.g., 'backend', 'mobile')
 * @param reposPath - Path to the repos directory (e.g., sessions/task-xxx/repos)
 * @param baseRepoPath - Path to the base repository
 * @param checkout - What to check out in the worktree
 * @param baseBranch - Optional base branch (e.g., 'main', 'master'). Auto-detects if not provided.
 * @returns Object with worktree_path, feature_branch (if created), and base_branch
 */
export async function setupWorktree(
  repoKey: string,
  reposPath: string,
  baseRepoPath: string,
  checkout: WorktreeCheckout,
  baseBranch?: string,
): Promise<WorktreeResult> {
  const defaultBranch = baseBranch || await getDefaultBranch(baseRepoPath);

  await fetchOrigin(baseRepoPath, defaultBranch);

  await fs.mkdir(reposPath, { recursive: true });
  const worktreePath = path.join(reposPath, repoKey);

  if (checkout.type === 'new_branch') {
    const featureBranch = checkout.name;
    logger.worktree(`Creating worktree for ${repoKey} (${featureBranch})`);

    try {
      await gitExec(baseRepoPath, `worktree add -b ${featureBranch} "${worktreePath}" origin/${defaultBranch}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('already exists')) {
        logger.worktree(`Branch ${featureBranch} already exists, reusing`);
        const worktreeList = await gitExec(baseRepoPath, 'worktree list --porcelain');
        if (worktreeList.includes(featureBranch)) {
          const lines = worktreeList.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('worktree ') && lines[i + 2]?.includes(featureBranch)) {
              const existingPath = lines[i].replace('worktree ', '');
              logger.worktree(`Found existing worktree at ${existingPath}`);
              return { worktree_path: existingPath, feature_branch: featureBranch, base_branch: defaultBranch };
            }
          }
        }
        await gitExec(baseRepoPath, `worktree add "${worktreePath}" ${featureBranch}`);
      } else {
        throw error;
      }
    }

    return { worktree_path: worktreePath, feature_branch: featureBranch, base_branch: defaultBranch };
  } else if (checkout.type === 'branch') {
    logger.worktree(`Creating worktree for ${repoKey} on existing branch ${checkout.name}`);
    await fetchOrigin(baseRepoPath, checkout.name);
    await gitExec(baseRepoPath, `worktree add "${worktreePath}" ${checkout.name}`);

    return { worktree_path: worktreePath, feature_branch: checkout.name, base_branch: defaultBranch };
  } else {
    // Detached HEAD
    const target = checkout.sha || `origin/${defaultBranch}`;
    logger.worktree(`Creating detached worktree for ${repoKey} at ${target}`);
    await gitExec(baseRepoPath, `worktree add --detach "${worktreePath}" ${target}`);

    return { worktree_path: worktreePath, base_branch: defaultBranch };
  }
}

/**
 * Check if a worktree exists at the given path
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) {
      return false;
    }
    // Check if it's actually a git worktree by looking for .git file
    const gitPath = path.join(worktreePath, '.git');
    const gitStat = await fs.stat(gitPath);
    return gitStat.isFile(); // Worktrees have a .git file, not a directory
  } catch {
    return false;
  }
}

/**
 * Get the current branch name in a worktree
 */
export async function getWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const branch = await gitExec(worktreePath, 'rev-parse --abbrev-ref HEAD');
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Remove a worktree and its directory.
 * Uses `git worktree remove --force` from the base repo.
 */
export async function removeWorktree(baseRepoPath: string, worktreePath: string): Promise<void> {
  try {
    await gitExec(baseRepoPath, `worktree remove --force "${worktreePath}"`);
    logger.worktree(`Removed worktree at ${worktreePath}`);
  } catch (error: any) {
    // If worktree is already gone, just prune
    logger.warn('worktree-manager', `Failed to remove worktree: ${error.message}`);
    try {
      await gitExec(baseRepoPath, 'worktree prune');
    } catch {
      // Best effort
    }
  }
}

/**
 * Check if a path is a symbolic link
 */
export async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
