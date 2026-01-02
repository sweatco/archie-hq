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

const execAsync = promisify(exec);

export interface WorktreeResult {
  worktree_path: string;
  feature_branch: string;
}

/**
 * Execute a git command in a directory
 */
async function gitExec(cwd: string, args: string): Promise<string> {
  const { stdout, stderr } = await execAsync(`git ${args}`, { cwd });
  if (stderr && !stderr.includes('Fetching') && !stderr.includes('From ')) {
    console.log(`[worktree-manager] git stderr: ${stderr}`);
  }
  return stdout.trim();
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
        console.log(`[worktree-manager] Could not detect default branch, falling back to 'main'`);
        return 'main';
      }
    }
  }
}

/**
 * Setup worktree for a repository in a task
 *
 * 1. Auto-detects the default branch (main, master, etc.)
 * 2. Fetches latest from origin
 * 3. Creates worktree at <reposPath>/<repoKey>
 * 4. Creates feature branch feature/task-{taskId} from origin/<defaultBranch>
 *
 * @param taskId - The task identifier
 * @param repoKey - Repository key (e.g., 'backend', 'mobile')
 * @param reposPath - Path to the repos directory (e.g., sessions/task-xxx/repos)
 * @param baseRepoPath - Path to the base repository
 * @returns Object with worktree_path and feature_branch
 */
export async function setupWorktree(
  taskId: string,
  repoKey: string,
  reposPath: string,
  baseRepoPath: string
): Promise<WorktreeResult> {
  console.log(`[worktree-manager] Setting up worktree for ${repoKey} in task ${taskId}`);

  // 1. Detect the default branch (main, master, etc.)
  const defaultBranch = await getDefaultBranch(baseRepoPath);
  console.log(`[worktree-manager] Detected default branch: ${defaultBranch}`);

  // 2. Fetch latest commits from origin
  console.log(`[worktree-manager] Fetching origin ${defaultBranch} in ${baseRepoPath}`);
  try {
    await gitExec(baseRepoPath, `fetch origin ${defaultBranch}`);
  } catch (error) {
    // If fetch fails (e.g., no network), log but continue
    // The worktree will be created from whatever origin/<branch> exists
    console.log(`[worktree-manager] Warning: fetch failed, using existing origin/${defaultBranch}: ${error}`);
  }

  // 3. Create branch name
  // taskId already includes "task-" prefix (e.g., "task-01012026-1823-abc123")
  const featureBranch = `feature/${taskId}`;

  // 4. Create worktree path
  // Worktrees go in reposPath/<repoKey> (e.g., sessions/task-xxx/repos/backend)
  await fs.mkdir(reposPath, { recursive: true });

  const worktreePath = path.join(reposPath, repoKey);

  // 5. Create worktree with new branch from origin/<defaultBranch>
  console.log(`[worktree-manager] Creating worktree at ${worktreePath} with branch ${featureBranch} from origin/${defaultBranch}`);

  try {
    await gitExec(baseRepoPath, `worktree add -b ${featureBranch} "${worktreePath}" origin/${defaultBranch}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // If branch already exists, try to use it
    if (errorMessage.includes('already exists')) {
      console.log(`[worktree-manager] Branch ${featureBranch} already exists, creating worktree with existing branch`);
      // First check if there's already a worktree for this branch
      const worktreeList = await gitExec(baseRepoPath, 'worktree list --porcelain');
      if (worktreeList.includes(featureBranch)) {
        // Worktree already exists for this branch - this shouldn't happen in normal flow
        // but handle it gracefully by finding and returning the existing path
        const lines = worktreeList.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('worktree ') && lines[i + 2]?.includes(featureBranch)) {
            const existingPath = lines[i].replace('worktree ', '');
            console.log(`[worktree-manager] Found existing worktree at ${existingPath}`);
            return {
              worktree_path: existingPath,
              feature_branch: featureBranch,
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

  console.log(`[worktree-manager] Worktree created successfully`);

  return {
    worktree_path: worktreePath,
    feature_branch: featureBranch,
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
