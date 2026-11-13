# Replace Git Worktrees with Shared Clones

> **Historical record — filing review 2026-11-11.** Current documentation: [Repository workspace](../architecture/edit-mode.md). Original design and verification claims below describe their recorded revision; they are not current implementation instructions.

## Context

Git worktrees share `.git/objects/`, `.git/refs/`, and `.git/worktrees/` with the base repo. This makes true filesystem isolation impossible — sandboxing an agent's worktree requires granting read (and write in RW mode) access to the entire base repo, allowing one agent to interfere with another's state. Additionally, worktrees can't check out the same branch concurrently, forcing a `detached HEAD` workaround for visiting existing branches.

`git clone --shared` creates fully independent repositories that borrow only the base repo's object store via an `alternates` file — read-only, immutable, content-addressed blobs. Each clone has its own `.git/` directory (HEAD, index, refs, config), so agents are truly isolated. Normal `git checkout` works for any branch — no detached HEAD needed.

## Files to Change

| File | Action |
|------|--------|
| `src/connectors/github/worktree.ts` | **Rewrite** → rename to `repo-clone.ts`. Replace `setupWorktree` with `setupSharedClone`, `removeWorktree` with `removeClone`, add `migrateWorktreeToClone`. |
| `src/agents/spawn.ts` | **Modify** — migration step before clone check, call `setupSharedClone`, narrow sandbox to `baseRepo/.git/objects` |
| `src/agents/tools.ts` | **Modify** — simplify `switch_branch` (drop detached HEAD), update path refs from `worktree_path` to `clone_path` |
| `src/tasks/task.ts` | **Modify** — simplify cleanup to `rm -rf`, rename to `cleanupClones` |
| `src/connectors/github/branch-state.ts` | **Modify** — remove `owned` flag references |
| `src/types/task.ts` | **Modify** — add `clone_path`, remove `worktree_path`, remove `owned` from `BranchState` |

---

## Step 1: Create `src/connectors/github/repo-clone.ts`

Rename `worktree.ts` → `repo-clone.ts`. Keep `gitExec`, `getDefaultBranch`. Re-export `fetchOrigin` from `client.ts`.

### New types

```typescript
export interface CloneResult {
  clone_path: string;
  branch: string;        // branch checked out (feature or base)
  base_branch: string;
}

export type CloneCheckout =
  | { type: 'new_branch'; name: string }   // RW fresh: clone base, create branch
  | { type: 'branch'; name: string }       // RW resume or visit: clone on existing branch
  | { type: 'base' };                      // RO default: clone on base branch
```

### `setupSharedClone(repoKey, reposPath, baseRepoPath, checkout, baseBranch, githubUrl)`

```
1. fetchOrigin(baseRepoPath)               // ensure base repo has all latest refs
2. mkdir -p reposPath
3. clonePath = join(reposPath, repoKey)

For checkout.type === 'new_branch':
   git clone --shared --branch <baseBranch> <baseRepoPath> <clonePath>
   git -C <clonePath> remote set-url origin <githubUrl>
   git -C <clonePath> checkout -b <checkout.name>
   return { clone_path, branch: checkout.name, base_branch: baseBranch }

For checkout.type === 'branch':
   git clone --shared --branch <checkout.name> <baseRepoPath> <clonePath>
   git -C <clonePath> remote set-url origin <githubUrl>
   return { clone_path, branch: checkout.name, base_branch: baseBranch }

For checkout.type === 'base':
   git clone --shared --branch <baseBranch> <baseRepoPath> <clonePath>
   git -C <clonePath> remote set-url origin <githubUrl>
   return { clone_path, branch: baseBranch, base_branch: baseBranch }
```

### `cloneExists(clonePath): boolean`

```
stat clonePath/.git → exists AND is a directory (shared clone has .git dir)
```

### `isWorktree(repoPath): boolean`

```
stat repoPath/.git → exists AND is a file (worktree has .git file with "gitdir: ...")
```

### `removeClone(clonePath): void`

```
rm -rf clonePath
```

### `migrateWorktreeToClone(repoKey, reposPath, baseRepoPath, baseBranch, githubUrl, repoInfo, editAllowed)`

Migration logic for resuming old worktree-based tasks. Runs in spawn code (not sandboxed, has GIT_ASKPASS auth).

```
1. clonePath = join(reposPath, repoKey)
2. branch = repoInfo.current_branch || repoInfo.feature_branch || baseBranch
3. isRW = editAllowed && branch !== baseBranch

--- RO path (simple: no work to preserve) ---
If !isRW:
   git -C <baseRepoPath> worktree remove --force <clonePath>
   git -C <baseRepoPath> worktree prune
   setupSharedClone(... { type: 'base' } ...)
   Clean metadata: delete repoInfo.worktree_path
   Return CloneResult

--- RW path (preserve branch + uncommitted work) ---
4. Capture uncommitted work:
   patch = git -C <clonePath> diff HEAD

5. Ensure branch is on remote:
   result = git -C <clonePath> ls-remote --heads origin <branch>
   If empty:
     git -C <clonePath> push origin <branch>

6. Remove worktree properly:
   git -C <baseRepoPath> worktree remove --force <clonePath>
   git -C <baseRepoPath> worktree prune

7. Create shared clone:
   setupSharedClone(repoKey, reposPath, baseRepoPath,
     { type: 'branch', name: branch }, baseBranch, githubUrl)

8. Apply patch if non-empty:
   write patch to temp file
   git -C <clonePath> apply <patchFile>
   rm patchFile

9. Clean metadata: delete repoInfo.worktree_path

10. Return CloneResult
```

Fallback on any failure: log error, create fresh clone on base branch via `{ type: 'base' }`.

---

## Step 2: Update `src/agents/spawn.ts` (repo track)

### Migration runs first as independent step, then normal clone logic

```typescript
const taskRepoPath = join(getReposPath(taskId), def.repo!.repoKey);
const githubUrl = `https://github.com/${def.repo!.githubRepo}.git`;
const baseObjectsPath = join(baseRepoPath, '.git', 'objects');

// Step A: Migrate worktree → shared clone if needed (independent, runs first)
if (await isWorktree(taskRepoPath)) {
  logger.agent(def.id, `Migrating worktree to shared clone`);
  await migrateWorktreeToClone(
    def.repo!.repoKey, getReposPath(taskId), baseRepoPath,
    baseBranch, githubUrl, repoInfo, editAllowed,
  );
}

// Step B: Normal clone logic (clone exists or create new)
if (await cloneExists(taskRepoPath)) {
  // Shared clone already set up — reuse
  repoPath = taskRepoPath;

} else {
  // Fresh task — determine checkout target
  const previousBranch = repoInfo?.current_branch;
  const wasOnBaseBranch = !previousBranch || previousBranch === baseBranch;

  let checkout: CloneCheckout;
  if (editAllowed && wasOnBaseBranch) {
    checkout = { type: 'new_branch', name: `feature/${taskId}` };
  } else if (editAllowed && !wasOnBaseBranch) {
    // RW but was on a specific branch — restore it
    checkout = { type: 'branch', name: previousBranch! };
  } else {
    checkout = { type: 'base' };
  }

  const result = await setupSharedClone(
    def.repo!.repoKey, getReposPath(taskId), baseRepoPath,
    checkout, baseBranch, githubUrl,
  );
  repoPath = result.clone_path;

  if (result.branch !== result.base_branch) {
    hydrateBranchState(repoInfo, result.branch, result.base_branch);
  } else {
    repoInfo.current_branch = result.branch;
  }
}

// Update metadata
repoInfo.clone_path = repoPath;
delete repoInfo.worktree_path;  // clean break
metadata.repositories[def.repo!.repoKey] = { ...repoInfo, path: baseRepoPath };
```

### Update sandbox opts

```typescript
const denyWriteProtected = [
  join(repoPath, '.claude', 'settings.json'),
  join(repoPath, '.claude', 'skills'),
  join(repoPath, '.claude', 'hooks'),
  join(repoPath, 'CLAUDE.md'),
];

sandboxOpts = editAllowed
  ? {
      cwd: repoPath,
      allowReadPaths: [repoPath, sharedPath, baseObjectsPath],
      allowWritePaths: [repoPath],
      denyWritePaths: denyWriteProtected,
    }
  : {
      cwd: repoPath,
      allowReadPaths: [repoPath, sharedPath, baseObjectsPath],
      allowWritePaths: [],
    };
```

No write access to base repo ever. Only read-only access to `.git/objects/` (immutable blobs).

---

## Step 3: Simplify `src/agents/tools.ts`

### `switch_branch` — drop detached HEAD logic

```typescript
// Before: complex owned vs detached distinction
if (state?.owned) {
  git checkout <branch>
} else if (state) {
  git checkout --detach origin/<branch>  // or --detach <sha>
} else {
  git checkout --detach origin/<branch>
}

// After: always normal checkout
const clonePath = repoInfo.clone_path;
await gitExec(clonePath, `fetch origin ${branch}`);
try {
  await gitExec(clonePath, `checkout ${branch}`);
} catch {
  // Branch doesn't exist locally yet — track remote
  await gitExec(clonePath, `checkout -b ${branch} origin/${branch}`);
}
```

Stash logic stays unchanged (auto-stash on leave, auto-pop on return). Remove all `checkout --detach` code paths. Remove `owned` checks.

### `create_branch` — update path reference

Replace `repoInfo.worktree_path` → `repoInfo.clone_path` throughout.

### `fetch` — fetch directly into clone

```typescript
// Before: fetch into base repo
await fetchOrigin(repoInfo.path);

// After: fetch into clone (clone has its own remote pointing to GitHub)
const clonePath = repoInfo.clone_path;
await gitExec(clonePath, 'fetch origin');
```

No need to fetch base repo separately — clone fetches directly from GitHub via its own origin remote.

### All other tools referencing `worktree_path`

Search and replace `repoInfo.worktree_path` → `repoInfo.clone_path` in:
- `createPushBranchTool`
- `createPullRequestTool`
- `createMergePRTool`
- `createListBranchesTool`
- All other git MCP tools

---

## Step 4: Simplify `src/tasks/task.ts`

### Rename `cleanupWorktrees` → `cleanupClones`

```typescript
private async cleanupClones(): Promise<void> {
  for (const [repoKey, repoInfo] of Object.entries(this.metadata.repositories)) {
    const clonePath = repoInfo.clone_path;
    if (clonePath) {
      try {
        await rm(clonePath, { recursive: true, force: true });
        repoInfo.clone_path = undefined;
        logger.system(`Task ${this.taskId}: cleaned up clone for ${repoKey}`);
      } catch (error) {
        logger.warn('task', `Failed to cleanup clone for ${repoKey}: ${error}`);
      }
    }
  }
}
```

No `git worktree remove`, no `git worktree prune`. Just `rm -rf`.

Update callers in `stop()` and `complete()` methods.

---

## Step 5: Update `src/types/task.ts`

### `RepositoryInfo` — replace `worktree_path` with `clone_path`

```typescript
export interface RepositoryInfo {
  path: string;
  clone_path?: string;           // Path to shared clone (replaces worktree_path)
  // worktree_path removed — migration handles cleanup
  // ... rest unchanged
}
```

### `BranchState` — remove `owned` flag

```typescript
export interface BranchState {
  head_sha: string;
  base_branch?: string;
  pr_number?: number;
  last_processed_comment_id?: number;
  stash_name?: string;
  // owned: removed — no longer needed, all branches are normal checkouts
}
```

---

## Step 6: Update `src/connectors/github/branch-state.ts`

Remove `owned` references:
- `hydrateBranchState`: remove `owned: true` from created state
- Any other code checking `state.owned`

---

## Step 7: Update imports across codebase

All imports of `worktree.ts` change to `repo-clone.ts`:

- `src/agents/spawn.ts` — `setupWorktree` → `setupSharedClone`, `worktreeExists` → `cloneExists`/`isWorktree`
- `src/tasks/task.ts` — `removeWorktree` → `removeClone`
- Any other files importing from `worktree.ts`

---

## Verification

1. **Typecheck**: `npm run typecheck`
2. **Build**: `npm run build`
3. **Manual test — fresh RO task**: New task creates shared clone on base branch. Agent can read files, run `git log`, `git diff`, switch branches. No write access from sandbox.
4. **Manual test — fresh RW task**: New task creates shared clone with feature branch. Agent can write, `git add`, `git commit`, push via MCP. `git status` works. Base repo is untouched.
5. **Manual test — resume old worktree task**: Existing worktree is detected, migrated to shared clone. Branch and uncommitted work preserved. `worktree_path` removed from metadata.
6. **Manual test — sandbox isolation**: Agent cannot read `/workdir/repos/<other-repo>` or write to base repo. Only `baseRepo/.git/objects` is readable.
7. **Manual test — concurrent branches**: Two agents on different tasks can check out the same branch simultaneously (impossible with worktrees).
