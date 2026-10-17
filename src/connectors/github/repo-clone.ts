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
 * Both paths finish the clone the same way: git identity, and the managed
 * `.git/info/exclude` block that keeps the sandbox's placeholder files out of
 * `git add -A` (see {@link excludeSandboxArtifacts}).
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
  /**
   * The task's repos directory (`getReposPath`). Every clone of this task lives
   * beneath it, and {@link excludeSandboxArtifacts} refuses to write anywhere
   * else — passed in because importing it would cycle through `system/workdir.js`.
   */
  reposRoot: string;
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
    // Reused clones too: they may predate this, and the sandbox leaves its
    // placeholders while agents work, not at creation.
    await excludeSandboxArtifacts(existing, opts.reposRoot);
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
  await excludeSandboxArtifacts(result.clone_path, opts.reposRoot);
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

// ---- Sandbox artifact exclusion ----

/**
 * Paths Claude Code's sandbox masks inside a task clone, written as `.git/info/exclude` patterns.
 *
 * Every Bash command an agent runs is wrapped in bubblewrap, and the CLI protects the harness paths
 * it expects to own in each writable directory: one that exists is bound read-only, and one that
 * does NOT exist gets `/dev/null` mounted over it so it cannot be created. Mounting over a missing
 * path means first creating a placeholder file there as the mount point — on the real disk, in the
 * customer's working tree — and that placeholder outlives the command. Inside the sandbox it reads
 * as a character device (1,3) and `git add -A` dies on it ("can only add regular files…"); outside
 * the sandbox it is an ordinary regular file that `git add -A` stages and commits.
 *
 * The list is what has been OBSERVED in task clones, not the CLI's full masked set, which changes
 * between CLI versions and is wider in the session's own cwd:
 *   - `.mcp.json` — a placeholder seen 2026-10-16 in a sweatcoin-infrastructure clone, which does
 *     not track one (repos that do track it get a read-only bind instead, and nothing is left).
 *   - the `.claude/*` entries — seen as character devices in an archie-hq clone in August 2026.
 *
 * The root-level paths the CLI masks in the cwd (`.bashrc`, `.gitconfig`, `.gitmodules`,
 * `CLAUDE.md`, `.vscode`, …) are deliberately absent: the cwd is the agent workspace, never a
 * clone, and several of them are ordinary repository content an agent may be asked to add.
 *
 * Two properties make this safe:
 *   - Exclusion does NOT affect TRACKED files. A repo that already commits `.mcp.json` or
 *     `.claude/settings.json` keeps diffing it normally; only untracked entries are hidden.
 *   - `.git/info/exclude` is local to the clone and never committed, so nothing reaches the repo.
 *
 * The residual risk is narrow and called out in the written header: an agent asked to CREATE one of
 * these exact paths in a repo that does not already track it would find it ignored. For a path the
 * sandbox masks it could not have written it anyway; for the rest, the comment says how to undo it.
 */
const SANDBOX_ARTIFACT_PATTERNS = [
  '/.mcp.json',
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
 * True when `child` is `parent` itself or sits beneath it. Both sides must already be canonical
 * (`fs.realpath`), because a plain string prefix test is defeated by a `..` segment or a symlink.
 */
function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Ensure a clone's `.git/info/exclude` hides the sandbox artifacts described above.
 *
 * Called by {@link ensureTaskClone} for every clone it hands back — freshly created or reused — so
 * a clone that predates this change picks the block up the next time it is mounted. Idempotent:
 * the managed block is delimited and rewritten in place, so repeat calls neither duplicate it nor
 * disturb anything else in the file.
 *
 * `clonePath` is TREATED AS UNTRUSTED, and `allowedRoot` is the anchor that makes that safe. It is
 * either a `clone_path` read back from task metadata or `getTaskClonePath(taskId, github)`, where
 * `github` is the argument a model passed to `mount_repo`. That tool normalises the identifier with
 * `normalizeGithubRef` and refuses a repo the GitHub App cannot reach, but the normaliser's
 * character class admits `.`, so a `..` segment passes its shape check — and unchecked, this
 * function is an arbitrary-file-overwrite primitive: every `..` moves the destination of the
 * `writeFile` up a directory. Four things have to hold before anything is written, each
 * canonicalised so neither `..` nor a symlink can slip past a string comparison:
 *
 *   1. the clone resolves to a real existing path inside `allowedRoot`;
 *   2. its `.git` is a real directory that lives inside the clone (not a file, not a link out);
 *   3. `.git/info` likewise resolves inside `.git`, re-checked after creation;
 *   4. `.git/info/exclude` is not itself a symlink — `writeFile` would follow it and write through.
 *
 * Failing any of them logs and returns rather than writing. `allowedRoot` is passed in rather than
 * imported from `system/workdir.js` because that module imports this one, and the import would
 * cycle; it also lets the tests anchor to a temp dir.
 *
 * A TOCTOU window remains between the checks and the write — inherent without `openat2`, and
 * acceptable here: everything inside `allowedRoot` is already Archie-managed, and the alternative
 * primitive it would yield is one this same process could obtain directly.
 *
 * Best-effort throughout. A clone we cannot write this into is not a reason to fail a mount — the
 * work still proceeds, it just keeps the untracked noise — so failures are logged and swallowed.
 */
export async function excludeSandboxArtifacts(clonePath: string, allowedRoot: string): Promise<void> {
  const refuse = (reason: string) =>
    logger.warn('repo-clone', `Refusing to write sandbox-artifact excludes for ${clonePath}: ${reason}`);

  const block = [
    EXCLUDE_HEADER,
    '# Claude Code\'s sandbox mounts /dev/null over these paths while an agent works here, leaving',
    '# placeholder files behind as untracked entries. Without this block `git add -A` commits them.',
    '# Local to this clone; never committed. Tracked files are unaffected — exclusion only hides',
    '# untracked entries. If an agent genuinely needs to ADD one of these paths, delete its line.',
    ...SANDBOX_ARTIFACT_PATTERNS,
    EXCLUDE_FOOTER,
  ].join('\n');

  try {
    // (1) LEXICAL containment first, before the untrusted string touches the filesystem at all.
    //     `path.resolve` collapses `..` and makes the value absolute; the prefix test then rejects
    //     anything not strictly below the managed root (a clone is never the root itself). Every fs
    //     call below uses `cloneLexical` or a value derived from it — the raw argument is never
    //     passed to the filesystem, so a syntactically escaping path is refused without even a stat.
    //
    //     Written INLINE, as a single negated `startsWith` on the resolved value, deliberately.
    //     That is the shape CodeQL's js/path-injection recognises as a sanitiser. It does not follow
    //     the same test through a boolean-returning helper (alerts 136-137 on the first version of
    //     this), nor through a compound `x === root || x.startsWith(…)` condition, which left alert
    //     137 open on the `realpath` below. Keep it this shape when editing.
    const rootLexical = path.resolve(allowedRoot);
    const cloneLexical = path.resolve(clonePath);
    if (!cloneLexical.startsWith(rootLexical + path.sep)) {
      return refuse(`resolves to ${cloneLexical}, outside ${rootLexical}`);
    }

    // (2) CANONICAL containment second. Lexical resolution cannot see symlinks, so a link inside
    //     the root pointing out would pass step 1 — realpath is what catches it. Both are needed:
    //     step 1 for what the analyser can follow, step 2 for what the filesystem actually does.
    const rootReal = await fs.realpath(rootLexical);
    let cloneReal: string;
    try {
      cloneReal = await fs.realpath(cloneLexical);
    } catch {
      return refuse('path does not exist');
    }
    if (!isInside(rootReal, cloneReal) || cloneReal === rootReal) {
      return refuse(`resolves through a symlink to ${cloneReal}, outside ${rootReal}`);
    }

    // (3) It must actually be a git clone, with `.git` a real directory inside it.
    let gitReal: string;
    try {
      gitReal = await fs.realpath(path.join(cloneReal, '.git'));
    } catch {
      return refuse('no .git directory');
    }
    if (!isInside(cloneReal, gitReal) || !(await fs.lstat(gitReal)).isDirectory()) {
      return refuse('.git is not a directory inside the clone');
    }

    // (4) `.git/info` must resolve inside `.git` — checked after creation, so a pre-existing
    //     symlink pointing elsewhere is caught rather than followed.
    const infoDir = path.join(gitReal, 'info');
    await fs.mkdir(infoDir, { recursive: true });
    const infoReal = await fs.realpath(infoDir);
    if (!isInside(gitReal, infoReal)) {
      return refuse(`.git/info resolves to ${infoReal}, outside ${gitReal}`);
    }

    const excludePath = path.join(infoReal, 'exclude');

    // (5) Never write through a symlink.
    try {
      if ((await fs.lstat(excludePath)).isSymbolicLink()) {
        return refuse('.git/info/exclude is a symlink');
      }
    } catch {
      // Absent — it gets created below.
    }

    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // No exclude file yet — created below.
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
      if (existing.slice(start, end) === block) return; // already correct — no write, no log
      next = existing.slice(0, start) + block + existing.slice(end);
    }

    await fs.writeFile(excludePath, next);
    logger.system(`Excluded Claude Code sandbox artifacts in ${cloneReal}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('repo-clone', `Could not write sandbox-artifact excludes for ${clonePath}: ${message}`);
  }
}
