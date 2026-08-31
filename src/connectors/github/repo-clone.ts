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

// ---- Sandbox artifact exclusion ----

/**
 * Harness-owned paths that Claude Code materialises inside whatever directory it works in.
 *
 * When a repo agent works in its clone, the CLI hardens that directory: it read-only-binds some
 * paths and mounts `/dev/null` over others it expects to own. Those `/dev/null` mounts leave
 * CHARACTER DEVICES behind as untracked entries in the working tree of a customer's repository —
 * where a routine `git add -A` will happily commit them.
 *
 * Only `.claude/*` entries are listed. The root-level artifacts (`.bashrc`, `.gitconfig`,
 * `.mcp.json`, `CLAUDE.md`, …) appear in an agent's *workspace* but were not observed leaking into
 * a clone, and several of them are legitimate repository content, so excluding them would risk
 * hiding a file an agent was legitimately asked to add.
 *
 * Two properties make this safe:
 *   - Exclusion does NOT affect TRACKED files. A repo that already commits `.claude/settings.json`
 *     (sweatcoin-mobile does) keeps diffing it normally; only untracked entries are hidden.
 *   - `.git/info/exclude` is local to the clone and never committed, so nothing reaches the repo.
 *
 * The residual risk is narrow and called out in the written header: an agent asked to CREATE one of
 * these exact paths in a repo that does not already track it would find it ignored. The comment
 * written into the file says how to undo that.
 */
const SANDBOX_ARTIFACT_PATTERNS = [
  '/.claude/settings.json',
  '/.claude/settings.local.json',
  '/.claude/launch.json',
  '/.claude/loop.md',
  '/.claude/scheduled_tasks.json',
  '/.claude/hooks',
  '/.claude/workflows',
  '/.claude/routines',
  '/.claude/output-styles',
  '/.claude/.cc-writes',
];

const EXCLUDE_HEADER = '# --- Archie: Claude Code sandbox artifacts (managed) ---';
const EXCLUDE_FOOTER = '# --- end Archie ---';

/**
 * Ensure a clone's `.git/info/exclude` hides the sandbox artifacts described above.
 *
 * Idempotent, and safe to call on every spawn: the managed block is delimited and rewritten in
 * place, so repeat calls neither duplicate it nor disturb anything else in the file. Called for
 * existing clones as well as fresh ones, because clones outlive the change that introduced this.
 *
 * Best-effort. A clone we cannot write this into is not a reason to fail a spawn — the agent still
 * works, it just keeps the untracked noise — so failures are logged and swallowed.
 */
export async function excludeSandboxArtifacts(clonePath: string): Promise<void> {
  const excludePath = path.join(clonePath, '.git', 'info', 'exclude');

  const block = [
    EXCLUDE_HEADER,
    '# Claude Code mounts /dev/null over these paths while an agent works here, leaving character',
    '# devices behind as untracked files. Without this block `git add -A` commits them into the repo.',
    '# Local to this clone; never committed. Tracked files are unaffected — exclusion only hides',
    '# untracked entries. If an agent genuinely needs to ADD one of these paths, delete its line.',
    ...SANDBOX_ARTIFACT_PATTERNS,
    EXCLUDE_FOOTER,
  ].join('\n');

  try {
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // No exclude file yet (or no .git/info) — created below.
    }

    const start = existing.indexOf(EXCLUDE_HEADER);
    let next: string;
    if (start === -1) {
      next = existing.length > 0 && !existing.endsWith('\n')
        ? `${existing}\n${block}\n`
        : `${existing}${block}\n`;
    } else {
      const endMarker = existing.indexOf(EXCLUDE_FOOTER, start);
      const end = endMarker === -1 ? existing.length : endMarker + EXCLUDE_FOOTER.length;
      const current = existing.slice(start, end);
      if (current === block) return; // already correct — no write, no log
      next = existing.slice(0, start) + block + existing.slice(end);
    }

    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, next);
    logger.system(`Excluded Claude Code sandbox artifacts in ${clonePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('task', `Could not write sandbox-artifact excludes for ${clonePath}: ${message}`);
  }
}
