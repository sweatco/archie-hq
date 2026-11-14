# Plan: Git Workflow — Stable CWD, Branch Switching, Detached HEAD

> **Historical record — filing review 2026-11-11.** Current documentation: [GitHub](../architecture/github-integration.md). Original design and verification claims below describe their recorded revision; they are not current implementation instructions.

## Context

Three problems with the current repo agent git workflow:

1. **Session recovery breaks on RO→RW transition.** When edit mode is approved, a worktree is created at a different path than the base repo. The SDK can't resume the session because the CWD changed. Currently we force a fresh session (`startFreshSession = true`), losing all agent context.

2. **Single branch per task.** The agent can only work on its auto-created `feature/{taskId}` branch. It can't investigate or fix an existing branch (e.g. address review feedback on someone else's PR). Two tasks also can't touch the same branch — git prevents two worktrees from checking out the same branch name.

3. **No git introspection in RO mode.** Agents can't run `git log`, `git blame`, `git show` without edit mode, and can't read PR details without PR tools.

## Design

### Stable CWD via symlink (problem 1)

The agent's CWD is always `sessions/task-xxx/repos/{repoKey}` — a stable path that never changes.

- **RO start**: Create symlink `sessions/task-xxx/repos/{repoKey}` → `workdir/repos/{repoKey}` (base repo).
- **First branch access** (edit mode approval, `switch_branch`, or any operation needing a worktree): Remove symlink, create worktree at the same path.
- **Subsequent spawns**: Worktree already exists at stable path.

The session ID stays valid across the RO→RW transition because the CWD path never changes. `startFreshSession` flag is no longer needed.

### Detached HEAD for existing branches (problem 2)

Git prevents two worktrees from checking out the same branch. Detached HEAD bypasses this: the worktree points to a commit SHA, not a branch ref, so multiple worktrees (from different tasks) can work on the same branch simultaneously.

**Owned branches** (`owned: true`): Agent created these. Normal checkout, normal push.

**Existing branches** (`owned: false`): Detached HEAD at `origin/{branch}` tip. Push uses explicit refspec (since detached HEAD has no tracking info).

### Metadata extension

All per-branch state (PR number, comment tracking, base branch) lives in `BranchState`. Each branch the agent touches gets its own entry with its own PR lifecycle. Top-level fields (`feature_branch`, `pr_number`, `base_branch`, `last_processed_comment_id`) become legacy — hydrated into `branch_states` on first access, mirrored on save for rollback safety, but **never read** by new code.

New optional fields on `RepositoryInfo`. Old tasks load fine (fields are `undefined`).

```typescript
interface BranchState {
  owned: boolean;                      // true = agent created, false = existing branch
  head_sha: string;                    // HEAD position when agent last left this branch
  base_branch?: string;                // PR target branch (e.g. 'main', 'master')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // triage tracking for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
}

interface RepositoryInfo {
  // --- legacy (kept for backward compat / rollback, never read by new code) ---
  path: string;                        // base repo path (still used — not legacy)
  branch?: string;                     // unused
  base_branch?: string;                // legacy — now per-branch in BranchState
  base_sha?: string;                   // unused
  worktree_path?: string;              // still written for tools that need the path
  feature_branch?: string;             // legacy — now current_branch
  pr_number?: number;                  // legacy — now per-branch in BranchState
  last_processed_comment_id?: number;  // legacy — now per-branch in BranchState

  // --- new ---
  current_branch?: string;                          // branch agent is on right now (map key into branch_states)
  branch_states?: Record<string, BranchState>;      // keyed by branch name
}
```

**Legacy hydration** (in spawn.ts, repo track, before any branch logic):

```typescript
if (repoInfo && repoInfo.feature_branch && !repoInfo.branch_states) {
  repoInfo.branch_states = {
    [repoInfo.feature_branch]: {
      owned: true,
      head_sha: '',
      base_branch: repoInfo.base_branch,
      pr_number: repoInfo.pr_number,
      last_processed_comment_id: repoInfo.last_processed_comment_id,
    }
  };
  repoInfo.current_branch = repoInfo.feature_branch;
}
```

**Legacy mirroring on save** — after any branch state change, mirror the current branch's values to top-level fields:

```typescript
function mirrorLegacyFields(repoInfo: RepositoryInfo) {
  const current = repoInfo.current_branch;
  const state = current ? repoInfo.branch_states?.[current] : undefined;
  if (state) {
    repoInfo.feature_branch = current;
    repoInfo.base_branch = state.base_branch;
    repoInfo.pr_number = state.pr_number;
    repoInfo.last_processed_comment_id = state.last_processed_comment_id;
  }
}
```

### Behavioral differences: owned vs existing branches

|                       | `owned: true`                            | `owned: false`                                    |
|-----------------------|------------------------------------------|---------------------------------------------------|
| Checkout              | `git checkout {branch}`                  | `git checkout --detach origin/{branch}`            |
| Push                  | `git push -u origin HEAD:{branch}`       | `git push origin HEAD:refs/heads/{branch}`         |
| Return to             | normal checkout (agent's HEAD)           | re-detach to recorded `head_sha`                   |
| Refresh (switch self) | no-op                                    | re-detach to latest `origin/{branch}`              |
| Created by            | `create_branch` tool or `setupWorktree`  | `switch_branch` to existing remote branch          |

## Changes

### 1. New type: `BranchState` in `src/types/task.ts`

Add `BranchState` interface and new optional fields to `RepositoryInfo` as shown above.

### 2. Stable CWD in `src/agents/spawn.ts` — repo track

Replace the current CWD logic:

**Before:**
```typescript
if (editAllowed) {
  if (repoInfo?.worktree_path && await worktreeExists(repoInfo.worktree_path)) {
    repoPath = repoInfo.worktree_path;
  } else {
    startFreshSession = true;
    const result = await setupWorktree(...);
    metadata.repositories[repoKey] = { ...repoInfo, worktree_path, feature_branch, base_branch };
    repoPath = worktree_path;
  }
} else {
  repoPath = baseRepoPath;
}
```

**After:**
```typescript
const baseBranch = repoInfo?.base_branch || def.repo!.baseBranch || 'main';
const taskRepoPath = join(getReposPath(taskId), def.repo!.repoKey);

if (await worktreeExists(taskRepoPath)) {
  // Worktree already set up (resumed task)
  repoPath = taskRepoPath;
  await fetchOrigin(baseRepoPath, baseBranch);
} else if (await isSymlink(taskRepoPath)) {
  if (editAllowed) {
    // Transition: remove symlink, create worktree at same path
    await fs.rm(taskRepoPath);
    const result = await setupWorktree(taskId, def.repo!.repoKey, getReposPath(taskId), baseRepoPath, baseBranch);
    repoInfo.worktree_path = taskRepoPath;
    hydrateBranchState(repoInfo, result.feature_branch, result.base_branch);
  }
  repoPath = taskRepoPath;
} else {
  // First spawn: create symlink to base repo
  await fs.mkdir(getReposPath(taskId), { recursive: true });
  await fs.symlink(baseRepoPath, taskRepoPath);
  repoPath = taskRepoPath;
}

// Legacy hydration for old tasks that already have a worktree but no branch_states
if (repoInfo.feature_branch && !repoInfo.branch_states) {
  hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
  // Carry over existing PR tracking
  const state = repoInfo.branch_states![repoInfo.feature_branch];
  state.pr_number = repoInfo.pr_number;
  state.last_processed_comment_id = repoInfo.last_processed_comment_id;
}
```

Remove `startFreshSession` flag — session ID stays valid since path doesn't change. The only exception is the symlink→worktree transition where the filesystem underneath changes; we may still need a fresh session here since the SDK might detect the change. Test this — if the SDK doesn't care (it just uses the path string), we can drop it entirely.

**`hydrateBranchState` helper:**
```typescript
function hydrateBranchState(repoInfo: RepositoryInfo, branch: string, baseBranch?: string) {
  repoInfo.branch_states ??= {};
  repoInfo.branch_states[branch] = {
    owned: true,
    head_sha: '',
    base_branch: baseBranch,
  };
  repoInfo.current_branch = branch;
  // Mirror to legacy fields
  repoInfo.feature_branch = branch;
  repoInfo.base_branch = baseBranch;
}
```

### 3. Helpers in `src/connectors/github/worktree.ts`

Export `gitExec` (currently private) so tools can use it:

```typescript
export async function gitExec(cwd: string, args: string): Promise<string> { ... }
```

Add symlink check:

```typescript
export async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
```

### 4. Make `fetchOrigin` branch-optional in `src/connectors/github/client.ts`

```typescript
export async function fetchOrigin(repoPath: string, branch?: string): Promise<void> {
  const target = branch ? `origin ${branch}` : 'origin';
  await execAsync(`git fetch ${target}`, { cwd: repoPath });
}
```

When no branch is specified, fetches all refs.

### 5. Tool return helpers in `src/agents/tools.ts`

Add at the top of the file to reduce boilerplate:

```typescript
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });
```

### 6. `switch_branch` tool in `src/agents/tools.ts`

Available in both RO and RW modes. If CWD is still a symlink (no worktree yet), converts it to a worktree first — this is how RO agents get branch access.

```typescript
function createSwitchBranchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'switch_branch',
    'Switch to a different branch. Fetches latest, auto-stashes dirty work, auto-pops on return.',
    {
      branch: z.string().describe('Branch name to switch to'),
    },
    async (args) => {
      const repoInfo = task.metadata.repositories[repoKey];
      const taskRepoPath = join(getReposPath(task.taskId), repoKey);

      // Ensure worktree exists — convert symlink if needed
      if (await isSymlink(taskRepoPath)) {
        const baseBranch = repoInfo?.base_branch || agent.def.repo!.baseBranch || 'main';
        await fs.rm(taskRepoPath);
        const result = await setupWorktree(
          task.taskId, repoKey, getReposPath(task.taskId), repoInfo.path, baseBranch
        );
        repoInfo.worktree_path = taskRepoPath;
        hydrateBranchState(repoInfo, result.feature_branch, result.base_branch);
      }

      const worktreePath = repoInfo.worktree_path;
      if (!worktreePath) return err('No worktree available');

      const branch = args.branch;
      const currentBranch = repoInfo.current_branch;
      const state = repoInfo.branch_states?.[branch];

      // 1. Fetch
      await fetchOrigin(repoInfo.path, branch);

      // 2. Auto-stash if dirty
      const status = await gitExec(worktreePath, 'status --porcelain');
      if (status.trim()) {
        const stashName = `archie:${task.taskId}:${currentBranch}`;
        await gitExec(worktreePath, `stash push -m "${stashName}"`);
        if (currentBranch && repoInfo.branch_states?.[currentBranch]) {
          repoInfo.branch_states[currentBranch].stash_name = stashName;
        }
      }

      // 3. Record HEAD sha before leaving
      if (currentBranch && repoInfo.branch_states?.[currentBranch]) {
        const headSha = await gitExec(worktreePath, 'rev-parse HEAD');
        repoInfo.branch_states[currentBranch].head_sha = headSha;
      }

      // 4. Checkout
      if (state?.owned) {
        // Agent-created branch: normal checkout
        await gitExec(worktreePath, `checkout ${branch}`);
      } else if (state) {
        // Previously visited existing branch
        if (branch === currentBranch) {
          // Refresh pattern: re-detach to latest remote
          await gitExec(worktreePath, `checkout --detach origin/${branch}`);
          state.head_sha = await gitExec(worktreePath, 'rev-parse HEAD');
        } else {
          // Return to recorded position (preserves unpushed commits)
          await gitExec(worktreePath, `checkout --detach ${state.head_sha}`);
        }
      } else {
        // First visit to existing branch — detached HEAD
        await gitExec(worktreePath, `checkout --detach origin/${branch}`);
        repoInfo.branch_states ??= {};
        repoInfo.branch_states[branch] = {
          owned: false,
          head_sha: await gitExec(worktreePath, 'rev-parse HEAD'),
        };
      }

      // 5. Update current_branch
      repoInfo.current_branch = branch;

      // 6. Auto-pop stash if exists for target branch
      const targetState = repoInfo.branch_states?.[branch];
      if (targetState?.stash_name) {
        const stashList = await gitExec(worktreePath, 'stash list');
        const stashIndex = findStashIndex(stashList, targetState.stash_name);
        if (stashIndex !== null) {
          await gitExec(worktreePath, `stash pop stash@{${stashIndex}}`);
        }
        targetState.stash_name = undefined;
      }

      mirrorLegacyFields(repoInfo);
      task.debouncedSave();
      return ok(`Switched to ${branch}`);
    },
  );
}

/**
 * Find stash index by message name in `git stash list` output.
 * Stashes are named `archie:{taskId}:{branch}` — unique per task+branch.
 */
function findStashIndex(stashList: string, stashName: string): number | null {
  const lines = stashList.split('\n');
  for (const line of lines) {
    if (line.includes(stashName)) {
      const match = line.match(/^stash@\{(\d+)\}/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}
```

### 7. `fetch` tool in `src/agents/tools.ts`

Available in both RO and RW modes.

```typescript
function createFetchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'fetch',
    'Fetch latest refs from origin.',
    {},
    async () => {
      const repoInfo = task.metadata.repositories[repoKey];
      const repoPath = repoInfo?.path;
      if (!repoPath) return err('No repo path');
      await fetchOrigin(repoPath);
      return ok('Fetched latest from origin');
    },
  );
}
```

### 8. `create_branch` tool in `src/agents/tools.ts`

RW mode only. Agent can create additional branches beyond the auto-created feature branch.

```typescript
function createCreateBranchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'create_branch',
    'Create a new branch from a base. Switches to it automatically.',
    {
      name: z.string().describe('Branch name'),
      base: z.string().optional().describe('Base branch (default: current branch)'),
    },
    async (args) => {
      const repoInfo = task.metadata.repositories[repoKey];
      if (!repoInfo?.worktree_path) return err('No worktree');

      const base = args.base || 'HEAD';
      await gitExec(repoInfo.worktree_path, `checkout -b ${args.name} ${base}`);

      repoInfo.branch_states ??= {};
      repoInfo.branch_states[args.name] = {
        owned: true,
        head_sha: await gitExec(repoInfo.worktree_path, 'rev-parse HEAD'),
      };
      repoInfo.current_branch = args.name;
      mirrorLegacyFields(repoInfo);
      task.debouncedSave();
      return ok(`Created and switched to ${args.name}`);
    },
  );
}
```

### 9. `list_branches` tool in `src/agents/tools.ts`

RW mode only.

```typescript
function createListBranchesTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'list_branches',
    'List branches created or visited by this agent in the current task.',
    {},
    async () => {
      const repoInfo = task.metadata.repositories[repoKey];
      const current = repoInfo?.current_branch || '(unknown)';
      const states = repoInfo?.branch_states || {};
      const owned = Object.entries(states)
        .filter(([, s]) => s.owned)
        .map(([name, s]) => `${name}${s.pr_number ? ` (PR #${s.pr_number})` : ''}`);
      const visited = Object.entries(states)
        .filter(([, s]) => !s.owned)
        .map(([name, s]) => `${name}${s.pr_number ? ` (PR #${s.pr_number})` : ''}`);
      const lines = [
        `Current: ${current}`,
        `Created: ${owned.join(', ') || '(none)'}`,
        `Visited: ${visited.join(', ') || '(none)'}`,
      ];
      return ok(lines.join('\n'));
    },
  );
}
```

### 10. RO PR tools — split read/write in `src/agents/tools.ts`

Move `get_pr_status`, `get_pr_reviews` and a new `get_pr` tool (returns diff + description) into a read-only PR server available without edit mode.

New server: `createRepoPRReadMcpServer(agent, task)` with:
- `get_pr_status`
- `get_pr_reviews`
- `get_pr(number)` — returns PR title, body, diff, status

Existing `createRepoPRMcpServer` keeps write tools: `push_branch`, `create_pull_request`, `update_pr`, `add_pr_comment`, `add_review_comment`, `resolve_review_thread`, `request_re_review`, `merge_pull_request`, `close_pull_request`.

### 11. RO git bash commands in `src/agents/spawn.ts`

Add to repo agent `allowedTools` unconditionally (not gated on `editAllowed`):

```typescript
'Bash(git log:*)',
'Bash(git diff:*)',
'Bash(git show:*)',
'Bash(git blame:*)',
'Bash(git ls-files:*)',
'Bash(git ls-tree:*)',
```

### 12. `push_branch` tool update in `src/agents/tools.ts`

Read from `branch_states`, legacy fallback only for old tasks mid-migration:

```typescript
const branch = repoInfo.current_branch;
const state = repoInfo.branch_states?.[branch!];

if (state?.owned) {
  await execAsync(`git push -u origin HEAD:${branch}`, { cwd });
} else if (state) {
  await execAsync(`git push origin HEAD:refs/heads/${branch}`, { cwd });
} else if (repoInfo.feature_branch) {
  // Legacy fallback — only during migration window
  await execAsync(`git push -u origin HEAD:${repoInfo.feature_branch}`, { cwd });
} else {
  return err('No branch to push');
}

// Update head_sha after push
if (state) {
  state.head_sha = await gitExec(cwd, 'rev-parse HEAD');
}
mirrorLegacyFields(repoInfo);
task.debouncedSave();
```

### 13. `create_pull_request` tool update in `src/agents/tools.ts`

Read from `branch_states`:

```typescript
const branch = repoInfo.current_branch;
const state = repoInfo.branch_states?.[branch!];
const head = branch || repoInfo.feature_branch || `feature/task-${task.taskId}`;
const base = state?.base_branch || repoInfo.base_branch || 'main';

const result = await client.createPullRequest(githubRepo, head, base, args.title, args.body);

// Store PR number in branch state
if (state) {
  state.pr_number = result.pr_number;
}
mirrorLegacyFields(repoInfo);
task.debouncedSave();
```

### 14. `findTaskByPRNumber` update in `src/tasks/persistence.ts`

Currently searches top-level `repoInfo.pr_number`. Update to search `branch_states`:

```typescript
// After loading metadata, check branch_states first, then legacy field
function repoHasPR(repoInfo: RepositoryInfo, prNumber: number): boolean {
  // New: search branch_states
  if (repoInfo.branch_states) {
    for (const state of Object.values(repoInfo.branch_states)) {
      if (state.pr_number === prNumber) return true;
    }
  }
  // Legacy fallback
  return repoInfo.pr_number === prNumber;
}
```

### 15. Merge orchestrator update in `src/connectors/github/merge.ts`

Currently collects PRs from top-level `repoInfo.pr_number`. Update to collect from `branch_states`:

```typescript
// Collect all linked PRs across all branches
for (const [repoKey, repoInfo] of Object.entries(task.metadata.repositories)) {
  if (repoInfo.branch_states) {
    for (const [branch, state] of Object.entries(repoInfo.branch_states)) {
      if (state.pr_number) {
        linkedPRs.push({ repoKey, branch, prNumber: state.pr_number });
      }
    }
  } else if (repoInfo.pr_number) {
    // Legacy fallback
    linkedPRs.push({ repoKey, branch: repoInfo.feature_branch, prNumber: repoInfo.pr_number });
  }
}
```

### 16. PR event processing — `last_processed_comment_id`

In `src/connectors/github/events.ts`, when processing PR comments, look up the branch state by PR number:

```typescript
function findBranchStateByPR(repoInfo: RepositoryInfo, prNumber: number): BranchState | undefined {
  if (!repoInfo.branch_states) return undefined;
  for (const state of Object.values(repoInfo.branch_states)) {
    if (state.pr_number === prNumber) return state;
  }
  return undefined;
}

// Usage: read/write last_processed_comment_id from the branch state
const branchState = findBranchStateByPR(repoInfo, prNumber);
const lastProcessed = branchState?.last_processed_comment_id || repoInfo.last_processed_comment_id || 0;
// ... after processing:
if (branchState) {
  branchState.last_processed_comment_id = commentId;
}
```

### 17. Prompt updates — `prompts/repo-agent.md`

Add documentation for new tools and RO git commands:
- Document `switch_branch`, `fetch`, `create_branch`, `list_branches`
- Add RO git commands: `git log`, `git diff`, `git show`, `git blame`, `git ls-files`, `git ls-tree`
- Update "What NOT to Do" — `git checkout/switch/branch` still disallowed (use tools), but explain `switch_branch` tool
- Document that `switch_branch` creates a worktree if one doesn't exist yet

### 18. Wire tools in MCP servers — `src/agents/tools.ts` and `src/agents/spawn.ts`

**New git tools server** `createRepoGitMcpServer(agent, task)`:
- `fetch` — RO + RW
- `switch_branch` — RO + RW (creates worktree on demand)
- `create_branch` — RW only
- `list_branches` — RW only

**RO PR tools**: new `createRepoPRReadMcpServer`, mounted unconditionally for repo agents.

**Allowed tools update** in spawn.ts:
```typescript
// Always (RO + RW)
'mcp__repo-git-tools__fetch',
'mcp__repo-git-tools__switch_branch',
'mcp__pr-read-tools__*',
'Bash(git log:*)',
'Bash(git diff:*)',
'Bash(git show:*)',
'Bash(git blame:*)',
'Bash(git ls-files:*)',
'Bash(git ls-tree:*)',

// RW only (existing + new)
'mcp__pr-tools__*',
'mcp__repo-git-tools__create_branch',
'mcp__repo-git-tools__list_branches',
```

### 19. Test updates

Update `src/agents/__tests__/tool-contract.test.ts` and `src/agents/__tests__/pr-tools.test.ts`:
- Mock `RepositoryInfo` with new fields (`branch_states`, `current_branch`)
- Add test cases for new MCP servers (`repo-git-tools`, `pr-read-tools`)
- Test legacy hydration path (old metadata without `branch_states`)

## Implementation Order

1. Types: `BranchState` + `RepositoryInfo` extension in `task.ts`
2. Helpers: export `gitExec`, add `isSymlink` in `worktree.ts`; make `fetchOrigin` branch-optional in `client.ts`; add `ok()`/`err()`/`mirrorLegacyFields`/`hydrateBranchState` in `tools.ts`
3. Stable CWD: spawn.ts repo track rewrite + legacy hydration
4. RO git bash: add to allowedTools unconditionally
5. RO PR tools: split read server, mount unconditionally
6. `fetch` tool
7. `switch_branch` tool (including symlink→worktree conversion)
8. `push_branch` + `create_pull_request` update for branch-aware operations
9. `findTaskByPRNumber` update in persistence.ts
10. Merge orchestrator update in merge.ts
11. PR event processing: `findBranchStateByPR` for `last_processed_comment_id` in events.ts
12. `create_branch` + `list_branches` tools
13. Prompt update: repo-agent.md
14. MCP server wiring in spawn.ts
15. Test updates

## Test Plan

### Unit tests (mock git, no real repos)

**Legacy hydration & migration**
- Old metadata with `feature_branch` but no `branch_states` → hydrates correctly with all fields (`pr_number`, `base_branch`, `last_processed_comment_id`)
- Old metadata with worktree already created → hydration carries over existing PR tracking
- New metadata (already has `branch_states`) → hydration is a no-op
- Empty metadata (no `feature_branch`, no `branch_states`) → nothing breaks

**`mirrorLegacyFields`**
- After state change, top-level `feature_branch`/`pr_number`/`base_branch`/`last_processed_comment_id` reflect current branch
- With multiple branches, only current branch's values are mirrored
- With no current branch or no branch states → no crash

**`push_branch` branch resolution**
- Owned branch → builds normal push command
- Visited branch → builds refspec push command
- No `branch_states` but has `feature_branch` → legacy fallback
- No branch info at all → returns error

**`create_pull_request` branch resolution**
- Reads `base_branch` from `branch_states[current_branch]`
- Falls back to top-level `base_branch`, then to `'main'`
- Stores `pr_number` into branch state after creation
- Mirrors to legacy fields after creation

**`repoHasPR` / `findTaskByPRNumber`**
- PR on current branch → found
- PR on non-current branch → found via `branch_states` scan
- Legacy metadata without `branch_states` → falls back to top-level `pr_number`
- No PR anywhere → not found

**Merge orchestrator PR collection**
- Single branch with PR → collected
- Multiple branches each with own PR → all collected
- Mix of branches with and without PRs → only PR branches collected
- Legacy metadata without `branch_states` → falls back to top-level `pr_number`

**`findBranchStateByPR`**
- Finds correct branch state by PR number
- Multiple branches, returns the one matching the PR
- No match → returns undefined
- No `branch_states` → returns undefined

**Tool contract tests** (extend existing)
- `repo-git-tools` server registers `fetch`, `switch_branch`, `create_branch`, `list_branches`
- `pr-read-tools` server registers `get_pr_status`, `get_pr_reviews`, `get_pr`
- `pr-tools` server no longer includes read tools (moved out)
- `allowedTools` in spawn.ts: RO mode includes git bash commands, `fetch`, `switch_branch`, PR read tools
- `allowedTools` in spawn.ts: RW mode additionally includes `create_branch`, `list_branches`, PR write tools

### Not covered by unit tests (requires real git or integration testing)

- `switch_branch` actual git checkout/stash/detach behavior
- Symlink → worktree transition in `spawn.ts`
- `isSymlink` / `worktreeExists` with real filesystem
- `setupWorktree` creating worktrees from symlink path
- `gitExec` command execution
- Stash push/pop with `findStashIndex`
- `fetchOrigin` with and without branch parameter
- SDK session recovery across symlink→worktree transition

These are best covered by manual testing or a future integration test suite with temp git repos.

## Not in scope

- Worktree/branch cleanup on task completion (follow-up work)
- Orphaned PR detection
- Branch naming enforcement (can add later)
- Webhook routing for non-owned branches (not needed — agent doesn't own those PRs)
