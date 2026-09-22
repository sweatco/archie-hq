# Edit Mode

A task is **read-only** until a human approves **edit mode**. The flag is per task, one-way, and persisted — a human-in-the-loop gate that stops Archie changing code without explicit consent.

> A sibling gate, [max mode](max-mode.md), reuses the same request → approve → resume shape to upgrade the PM's model and effort. Another, [tool approvals](tool-approvals.md), gates individual MCP tool calls per call rather than for the task's lifetime. All three are independent.

## Repositories are mounted, not declared

Nothing is cloned when a task starts. Plugins declare no repositories; the GitHub App installation is the allowlist. The PM discovers what it can reach with `list_available_repos` and brings a repository into the task with:

```
mount_repo("owner/repo")
  → path, branch, default branch, and whether it is read-only or writable
```

`mount_repo` (`src/agents/tools.ts`) is the **only** way a clone comes into existence. It resolves the base branch — from the task's own record if it has mounted this repo before, otherwise from the GitHub API, which doubles as the reachability check — ensures a base clone exists in `$ARCHIE_WORKDIR/repos/<owner>/<repo>` (cloning on demand if it was not warmed at startup), then calls `ensureTaskClone` to create the task clone at `sessions/{taskId}/repos/{owner}/{repo}`. The repo is recorded in `metadata.repositories` only once the clone is on disk, and the write is flushed rather than debounced, so a crash cannot leave a clone nothing points at. Mounting an already-mounted repo is idempotent: it returns the same path after making sure the checkout matches the current edit mode.

One clone per repo per task — the task, not an agent, is the isolation boundary. The PM passes the returned path into a worker's brief, and its prompt forbids pointing two workers at the same clone at once, since they share one working tree.

A repo mounted mid-session is immediately reachable because the sandbox grants the task's **repos directory**, not the clones that happened to exist at spawn (`buildRepoGrants` in `src/agents/sandbox.ts`).

## The two modes

### Read-only (default)

The clone sits on the repository's base branch. `sessions/{taskId}/repos/` is in `allowReadPaths` and `denyWritePaths`, so `Write`, `Edit` and any write-touching `Bash` command against a clone is refused by both the OS sandbox and the `createFilesystemGuardHooks` PreToolUse hooks. The write side of `repo-tools` is in `disallowedTools`, so the model never sees it.

Working: `Read`, read-only git via `Bash`, `fetch`, `switch_branch`, `list_branches`, and every PR/check/code-scanning read tool.

When the task stops or completes, `cleanupClones()` removes the clones and clears `clone_path`, so the next mount creates a fresh one.

### Edit mode (after approval)

`sessions/{taskId}/repos/` moves into `allowWritePaths`, and the withheld `repo-tools` entries become available: `push_branch`, `create_pull_request`, `update_pr`, `add_pr_comment`, `add_review_comment`, `reply_to_review_comment`, `resolve_review_thread`, `request_re_review`, `merge_pull_request`, `close_pull_request`, `create_branch`. Clones for a task with `edit_allowed === true` are **not** removed on stop/complete — they hold local commits, branches and PR bookkeeping.

`merge_pull_request` carries a second gate on top of edit mode: in a repo without `autoMerge: true` in `archie.json` it does not merge, it posts a `merge` approval request, and approving *arms* auto-merge rather than merging on the spot ([github-integration.md](github-integration.md#merge-policy-automerge)).

Each clone's `.git/HEAD` stays in `denyWritePaths` even in edit mode, so branch movement must go through `switch_branch` / `create_branch` rather than a raw `git checkout`. **Known limitation:** that deny is enumerated per clone at spawn, so a repo mounted mid-session in edit mode has a writable `.git/HEAD` until the next respawn — the deny lists are prefix-matched and no directory expresses "`.git/HEAD` under any clone".

## The approval flow

### 1. The PM requests it

`request_edit_mode(reason, channel?)` — called after explaining the intended change to the user with `post_to_user`. It is idempotent: if `edit_allowed` is already true it returns a no-op message telling the PM to proceed, and if a teardown is already armed this turn it says the request is already out. An explicit `channel` is validated before posting, so a bad key surfaces as actionable feedback rather than a silently dropped prompt.

### 2. Buttons posted, task parks

The tool writes a `decision` finding (`Edit mode requested: <reason>`), posts a Block Kit message with `approve_edit_mode` / `deny_edit_mode` buttons carrying the task id, suspends the live status indicator, and **defers** `task.stop()` to the end of the turn — stopping the queue inside the tool call would close the input stream under an in-flight hook.

### 3. The user clicks

**Approve** (`src/connectors/slack/events.ts`, with an equivalent path in `src/connectors/api/routes.ts`) resolves the clicking user and calls `handleEditModeApproval({ id, name, email })`, which:

1. Clears the pending teardown — approval means "continue", so the armed park must not fire and tear down the task that was just approved.
2. Sets `metadata.edit_allowed = true` and, if this is the first resolved approver, `metadata.edit_approved_by`.
3. Flushes metadata synchronously — the spawn reads `edit_allowed` at spawn time, so the flag must be on disk before any respawn.
4. Runs `recheckoutClonesForEditMode()`: one `ensureTaskClone(..., editAllowed: true)` per mounted repo, so the writable mount the PM comes back to is already checked out where its commits belong. This is the same helper `mount_repo` uses, deliberately — an earlier restatement of the logic skipped any clone still on disk, so a repo mounted while read-only stayed parked on base and the PM committed onto it.
5. Restarts the PM: sync its session into metadata, abort the handle, stop the queue, drop the agent. The next `sendMessage` respawns it **resuming the same SDK session**, so context is kept and only the mount changes.
6. Notifies the PM inline with `Edit mode approved by <name>` (also written to `knowledge.log` for the offline record).

**Deny** calls `handleEditModeDenial()`, which notifies the PM that edit mode was denied — nothing else changes.

### Why the restart

Edit mode only flips the sandbox at spawn time: `editAllowed` is read once and the mount, the `disallowedTools` list and the repo grants are frozen from it. A process that is already running keeps its read-only mount and never re-reads the flag, so writes keep hitting a read-only filesystem after approval (observed live: EROFS persisted for ~20 minutes post-approval).

There is a second window the restart cannot catch: an agent still **mid-boot** when approval lands has no live handle to abort, so it finishes booting read-only. `Agent.editModeAtSpawn` records the flag the current process booted under, and `Task.ensurePm()` compares it against the live flag the moment work is next delivered — tearing the agent down and respawning it writable.

## Clone mechanics

`ensureTaskClone` (`src/connectors/github/repo-clone.ts`) is the single entry point, shared by `mount_repo` and the approval path.

**Reuse.** If a clone already exists — at the recorded `clone_path` (a migrated task may hold one elsewhere) or at the canonical path — it is reused, and `configureGitIdentity` is re-run on it unconditionally, so a clone left behind by an interrupted mount (or one whose config predates the current attribution identity) cannot commit as whoever git falls back to. If edit mode is on and the clone is sitting on a branch with no `branch_states` entry (i.e. the base branch), it is moved onto `archie/{taskId}` there and then, joining the branch if it already exists locally rather than resetting it.

**Creation.** Otherwise `decideCloneCheckout` picks the checkout — a pure function, so the mount tool and the approval path cannot drift:

```typescript
type CloneCheckout =
  | { type: 'base' }                       // read-only
  | { type: 'branch'; name: string }       // edit mode, restoring a branch the task was on
  | { type: 'new_branch'; name: string };  // edit mode, first mount → archie/{taskId}
```

A clone parked on the base branch records that branch in `current_branch` with **no** `branch_states` entry, so the entry's absence is what distinguishes "this is the base branch" from "a feature branch whose base we forgot".

`setupSharedClone` then fetches origin, syncs the base clone's ref, runs `git clone --shared --branch <branch>` from the base cache, initialises submodules best-effort, rewrites `origin` to the GitHub URL so pushes never go back to the base cache, and creates the feature branch for `new_branch`. `configureGitIdentity` runs afterwards on this path too.

### Per-repo record

```typescript
interface AttachedRepo {
  github: string;                                // 'acme/backend' — also the key
  clone_path?: string;                           // sessions/<id>/repos/acme/backend
  base_path?: string;                            // base cache this clone borrows objects from
  current_branch?: string;                       // key into branch_states
  branch_states?: Record<string, BranchState>;
}
```

`BranchState` tracks `base_branch`, `pr_number`, `last_processed_comment_id`, `stash_name`, `pr_card`, and the two per-PR merge markers `merge_armed` / `merge_ready_notified`. Those two are reset by `assignPrNumber()` whenever a branch's `pr_number` changes, so a new PR on a reused branch never inherits a prior PR's arm state. Helpers live in `src/connectors/github/branch-state.ts`.

## Branch strategy

The first feature branch is `archie/{taskId}` (the task id already begins with `task-`). Further `create_branch` calls in the same task auto-number as `archie/{taskId}-2`, `-3`, … (`taskBranchName()` in `src/connectors/github/branch-naming.ts`). The naming serves double duty:

1. **Isolation** — each task gets its own branch family.
2. **Webhook routing** — `extractTaskIdFromBranch()` matches incoming GitHub events back to the task with `^(?:archie|feature)\/(task-\d{8}-\d{4}-[a-z0-9]+)(?:-\d+)?$`. The legacy `feature/` prefix stays accepted so pre-migration PRs keep attributing to their task.

Tasks can also be resolved by branch name or PR number over `metadata.repositories` (`findTaskByBranch`, `findTaskByPRNumber`), which is what handles a branch that does not follow the pattern.

## Commit authorship

By default a commit is both authored and committed by the GitHub App bot, because `configureGitIdentity()` writes that identity into the clone's `user.name`/`user.email`. To make `git blame` point at the person who asked for the work, the **author** is set to the edit-mode approver while the **committer** stays the bot:

- On approval, `metadata.edit_approved_by = { id, name, email }` is recorded — first resolved approver wins, so a repeat approval cannot reassign authorship mid-task.
- At spawn, `buildCommitAuthorEnv` injects `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` from that field (trimmed; a blank name is dropped so authoring falls back to the bot rather than failing `git commit`). Git applies these to the author only. No agent cooperation is needed, and commits replayed by `cherry-pick`/`rebase` keep their original author, which is correct.
- The author **email** lets GitHub link the commit to a profile when it matches a verified address. Without the `users:read.email` Slack scope a `${slackUserId}@users.noreply.archie.invalid` fallback is used — the name still shows in `git blame`, it just doesn't link.
- With no resolved approver (CLI/API approvals without one), authoring falls back to the bot.

Because `edit_allowed` is one-way, there is a single author per task.

## Relevant source files

- `src/agents/tools.ts` — `mount_repo`, `list_available_repos`, `request_edit_mode`, `createRepoToolsMcpServer`
- `src/connectors/github/repo-clone.ts` — `ensureTaskClone()`, `decideCloneCheckout()`, `setupSharedClone()`, `removeClone()`, `recordedBaseBranch()`
- `src/connectors/github/branch-state.ts` — `assignPrNumber()`, `hydrateBranchState()`, `findBranchStateByPR()`
- `src/agents/spawn.ts` — `REPO_WRITE_TOOLS` gating, sandbox config, `editModeAtSpawn`, `GIT_AUTHOR_*` injection
- `src/agents/sandbox.ts` — `buildRepoGrants()`, `buildSandboxConfig()`, `createFilesystemGuardHooks()`
- `src/tasks/task.ts` — `handleEditModeApproval()`, `handleEditModeDenial()`, `recheckoutClonesForEditMode()`, `restartAgent()`, `ensurePm()`, `cleanupClones()`
- `src/tasks/persistence.ts` — `getTaskClonePath()`, `getReposPath()`
- `src/connectors/slack/events.ts` / `src/connectors/api/routes.ts` — the two approval surfaces
- `src/types/task.ts` — `edit_allowed`, `edit_approved_by`, `AttachedRepo`, `BranchState`
