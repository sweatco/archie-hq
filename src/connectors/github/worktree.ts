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
  feature_branch: string;
  base_branch: string;
}

/**
 * Execute a git command in a directory
 */
async function gitExec(cwd: string, args: string): Promise<string> {
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
 * Setup worktree for a repository in a task
 *
 * 1. Uses provided base branch or auto-detects (main, master, etc.)
 * 2. Fetches latest from origin
 * 3. Creates worktree at <reposPath>/<repoKey>
 * 4. Creates feature branch feature/task-{taskId} from origin/<baseBranch>
 *
 * @param taskId - The task identifier
 * @param repoKey - Repository key (e.g., 'backend', 'mobile')
 * @param reposPath - Path to the repos directory (e.g., sessions/task-xxx/repos)
 * @param baseRepoPath - Path to the base repository
 * @param baseBranch - Optional base branch (e.g., 'main', 'master'). Auto-detects if not provided.
 * @returns Object with worktree_path, feature_branch, and base_branch
 */
export async function setupWorktree(
  taskId: string,
  repoKey: string,
  reposPath: string,
  baseRepoPath: string,
  baseBranch?: string
): Promise<WorktreeResult> {
  // 1. Use provided base branch or detect it
  const defaultBranch = baseBranch || await getDefaultBranch(baseRepoPath);

  // 2. Fetch latest commits from origin
  await fetchOrigin(baseRepoPath, defaultBranch);

  // 3. Create branch name
  // taskId already includes "task-" prefix (e.g., "task-01012026-1823-abc123")
  const featureBranch = `feature/${taskId}`;

  // 4. Create worktree path
  // Worktrees go in reposPath/<repoKey> (e.g., sessions/task-xxx/repos/backend)
  await fs.mkdir(reposPath, { recursive: true });

  const worktreePath = path.join(reposPath, repoKey);

  // 5. Create worktree with new branch from origin/<defaultBranch>
  logger.worktree(`Creating worktree for ${repoKey} (${featureBranch})`);

  try {
    await gitExec(baseRepoPath, `worktree add -b ${featureBranch} "${worktreePath}" origin/${defaultBranch}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // If branch already exists, try to use it
    if (errorMessage.includes('already exists')) {
      logger.worktree(`Branch ${featureBranch} already exists, creating worktree with existing branch`);
      // First check if there's already a worktree for this branch
      const worktreeList = await gitExec(baseRepoPath, 'worktree list --porcelain');
      if (worktreeList.includes(featureBranch)) {
        // Worktree already exists for this branch - this shouldn't happen in normal flow
        // but handle it gracefully by finding and returning the existing path
        const lines = worktreeList.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('worktree ') && lines[i + 2]?.includes(featureBranch)) {
            const existingPath = lines[i].replace('worktree ', '');
            logger.worktree(`Found existing worktree at ${existingPath}`);
            return {
              worktree_path: existingPath,
              feature_branch: featureBranch,
              base_branch: defaultBranch,
            };
          }
        }
      }
      // No existing worktree, just use the existing branch
      await gitExec(baseRepoPath, `worktree add "${worktreePath}" ${featureBranch}`);
    } else {
      throw error;
    }
  }

  // Identity is inherited from base repo (configured at server startup)

  return {
    worktree_path: worktreePath,
    feature_branch: featureBranch,
    base_branch: defaultBranch,
  };
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
