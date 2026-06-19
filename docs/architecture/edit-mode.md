# Edit Mode

Archie operates in two modes: **readonly** (the default) and **edit** (after human approval). This two-mode system implements a human-in-the-loop safety gate that prevents agents from modifying code without explicit user consent.

## Two-Mode System

### Readonly Mode (Default)

When a task starts, all repo agents operate in readonly mode. Their `cwd` is an agent workspace under `sessions/{taskId}/agents/{agentKey}`, and the repository is mounted as an additional directory at `sessions/{taskId}/repos/{repoKey}`. The repo path is mounted read-only by the OS sandbox (and read-only via filesystem-guard PreToolUse hooks for in-process tools), so `Write`, `Edit`, and write-to-repo Bash commands fail even though the tools are nominally available. PR/branch write MCP tools (`push_branch`, `create_pull_request`, `merge_pull_request`, `create_branch`, etc.) are explicitly listed in `disallowedTools`. Read tools, git read commands via `Bash`, the `fetch` and `switch_branch` MCP tools, and PR read tools (`list_prs`, `get_pr`, `get_pr_status`, `get_pr_reviews`, `get_pr_comments`, `get_review_threads`) all work.

In readonly mode the clone is checked out on the base branch (`{ type: 'base' }`). When the task stops or completes, the clone is removed by `cleanupClones()` to free disk space.

### Edit Mode (After Approval)

Once edit mode is approved for a task, the repo path's sandbox flips from read-only to read-write (`Write`, `Edit`, and write-capable `Bash` commands are now allowed against the clone), and the previously-disallowed MCP tools become available: `push_branch`, `create_pull_request`, `update_pr`, `add_pr_comment`, `add_review_comment`, `reply_to_review_comment`, `resolve_review_thread`, `request_re_review`, `merge_pull_request`, `close_pull_request`, and `create_branch`. The next time a repo agent is spawned, the clone is set up on a fresh feature branch (`{ type: 'new_branch', name: 'archie/{taskId}' }`). Edit mode is a one-way, permanent transition for the task — once approved, it cannot be revoked. Clones for tasks with `edit_allowed === true` are NOT removed on stop/complete (they hold local commits, branches, and PR state).

## Human-in-the-Loop Approval Flow

The transition from readonly to edit mode follows this sequence:

### 1. PM Requests Edit Mode

The PM agent calls the `request_edit_mode` MCP tool (defined in `src/agents/tools.ts`) with a reason string explaining what changes are needed. Before calling this tool, the PM is expected to have already explained the situation to the user via `post_to_user`.

### 2. Interactive Buttons Posted

`request_edit_mode` logs a `decision` finding (`Edit mode requested: <reason>`) and calls `task.postInteractiveToUser(...)` with a Block Kit message containing two buttons:

```
*Edit mode request:* <reason>
[ Approve ]  [ Deny ]
```

The buttons use action IDs `approve_edit_mode` and `deny_edit_mode`, with the task ID as the button value. `postInteractiveToUser` posts to the channel passed via the tool's optional `channel` argument, falling back to the task's default channel when omitted (Slack today; other connectors may not surface the buttons). The explicit `channel` lets an agent target a linked thread even when the task has no default channel yet — e.g. a self-launched task that just opened a thread via `post_to_user`.

### 3. Task Pauses

Immediately after posting the approval request, `request_edit_mode` calls `task.stop()`. This stops all agent queues, marks the task `stopped`, and (because `edit_allowed` is not yet true) cleans up clones via `cleanupClones()`. The task is fully paused until the user responds.

### 4. User Clicks a Button

**Approve** (handled in `src/connectors/slack/events.ts: app.action("approve_edit_mode")`, with an equivalent path in `src/connectors/api/routes.ts` for the CLI/API):
- The original message is updated to replace the buttons with `Edit mode approved by <@user>`.
- `handleEditModeApproval()` in `src/tasks/task.ts` is called.
- Sets `metadata.edit_allowed = true` on the task and persists via `debouncedSave()`.
- Appends the system finding `Edit mode approved by user` (decision) to `knowledge.log`.
- Reactivates the PM agent by sending the `existingTask` agent prompt (which reactivates the task and re-spawns agents — repo agents now spawn into a fresh `archie/{taskId}` branch).

**Deny** (handled in `src/connectors/slack/events.ts: app.action("deny_edit_mode")`, with the same API equivalent):
- The original message is updated to replace the buttons with `Edit mode denied by <@user>`.
- `handleEditModeDenial()` in `src/tasks/task.ts` is called.
- Appends the system finding `Edit mode denied by user` (decision) to `knowledge.log`.
- Reactivates the PM agent with the `existingTask` prompt to handle the denial (e.g., provide readonly findings instead).

## Task-Level Mode Transition

Edit mode is tracked as a boolean flag `edit_allowed` on `TaskMetadata` (`src/types/task.ts`):

```typescript
interface TaskMetadata {
  edit_allowed?: boolean;  // Has user approved edit mode for this task?
  // ...
}
```

Key properties of this transition:

- **Task-level**: The flag applies to the entire task, not individual agents. All repo agents in the task gain edit capabilities once approved.
- **One-way**: Once `edit_allowed` is set to `true`, it is never set back to `false`. There is no mechanism to revoke edit mode for an active task.
- **Persistent**: The flag is stored in `metadata.json` on disk and survives task stop/reactivation cycles.

## Shared Clone Management

Each repo agent gets its own task-local **shared clone** (created with `git clone --shared`), regardless of mode. This is managed by `src/connectors/github/repo-clone.ts`. A shared clone is an independent repository that borrows objects from the base repo via an `objects/info/alternates` file but has its own `.git/` directory, refs, index, and `origin` remote pointing at GitHub. (An older worktree-based design has been replaced; `migrateWorktreeToClone` exists only to upgrade legacy task state on first reuse.)

### `setupSharedClone()`

The `setupSharedClone()` function creates a new clone for a repository in a task. It accepts a `CloneCheckout` parameter that determines the checkout mode:

```typescript
type CloneCheckout =
  | { type: 'new_branch'; name: string }   // RW fresh: clone base, create branch
  | { type: 'branch'; name: string }       // RW resume / branch visit
  | { type: 'base' };                      // RO default: clone on base branch
```

Steps:
1. **Base branch detection**: Uses the provided `baseBranch` parameter, or auto-detects via `getDefaultBranch()` by reading `symbolic-ref refs/remotes/origin/HEAD`, then falling back to `origin/main`, then `origin/master`.
2. **Fetch latest**: Calls `fetchOrigin(baseRepoPath)` (and additionally `fetchOrigin(baseRepoPath, name)` for `branch` checkouts) to pull the latest commits.
3. **Base repo sync**: Resets the local branch in the base repo to `origin/{cloneBranch}` so `git clone --shared` sees up-to-date refs.
4. **Clone**: `git clone --shared --branch {cloneBranch} "{baseRepoPath}" "{clonePath}"`, then `submodule update --init --recursive` (best-effort), then `remote set-url origin <github-url>` so pushes go to GitHub rather than the base repo.
5. **Feature branch creation**: For `new_branch`, runs `checkout -b {name}` after cloning.

The clone is placed at `sessions/{taskId}/repos/{repoKey}` (e.g., `sessions/task-abc123/repos/backend`).

### Clone Creation at Spawn

Clones are created when a repo agent is spawned. This happens inside the repo track branch of `spawnAgent()` in `src/agents/spawn.ts`:

```
spawnAgent() called (repo track)
  -> If task-local path is a legacy worktree → migrateWorktreeToClone()
  -> If a shared clone already exists at the path → reuse it
  -> Otherwise pick a CloneCheckout from previous branch state + edit mode:
       editAllowed && (no previous branch || previous == base) → new_branch (archie/{taskId})
       editAllowed && previous != base                          → branch (restore previous_branch)
       readonly                                                 → base
     Then call setupSharedClone(...) with that checkout.
  -> configureGitIdentity(clonePath)
  -> Update metadata.repositories[repoKey] with clone_path / current_branch /
     branch_states (hydrated for any non-base feature branch)
  -> Spawn the SDK session with cwd = agent workspace and the clone path
     listed under additionalDirectories
```

### Clone Cleanup

When a task stops or completes AND `metadata.edit_allowed !== true`, `cleanupClones()` (`src/tasks/task.ts`) iterates `metadata.repositories` and calls `removeClone(clone_path)` (`src/connectors/github/repo-clone.ts`), which is a simple `rm -rf`, then clears `clone_path` so the next spawn re-creates a fresh clone. Clones for edit-mode tasks are kept on disk because they hold un-pushed commits, branches, and PR bookkeeping.

### Repository Metadata

After clone creation, the following fields are stored in `metadata.repositories[repoKey]` (`src/types/task.ts`):

```typescript
interface RepositoryInfo {
  path: string;                                    // Base repository path
  clone_path?: string;                             // Path to active task-local shared clone
  current_branch?: string;                         // Branch agent is on (key into branch_states)
  branch_states?: Record<string, BranchState>;     // Per-branch tracking
  // Legacy fields (mirrored from current branch state for rollback safety):
  feature_branch?: string;
  base_branch?: string;
  pr_number?: number;
  last_processed_comment_id?: number;
}
```

### Per-Branch State (`BranchState`)

Each branch the agent creates or visits is tracked independently:

```typescript
interface BranchState {
  base_branch?: string;                // PR target branch (e.g. 'main', 'master')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // triage tracking for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
}
```

Branch state helpers live in `src/connectors/github/branch-state.ts`:
- `hydrateBranchState()` -- initialize `branch_states` from a newly created branch
- `mirrorLegacyFields()` -- sync current branch state to legacy top-level fields
- `findBranchStateByPR()` -- look up a branch by its PR number (for webhook routing)

## Tool Restrictions

Repo-agent tool gating is implemented through two mechanisms in `src/agents/spawn.ts` (repo track):

1. **`disallowedTools`** — RO mode appends a fixed list of write-side MCP tools to `disallowedTools`. RW mode appends nothing extra. Both modes always also disallow `WebSearch` and `WebFetch`.
2. **Sandbox** — In RO mode the clone path appears only in `allowReadPaths` and `denyWritePaths`, so `Write`, `Edit`, and any write-touching `Bash` invocation against the clone are blocked by both the OS sandbox and the `createFilesystemGuardHooks()` PreToolUse hooks. In RW mode the clone path is added to `allowWritePaths`, and write tools succeed. The `.git/HEAD` file is also kept in `denyWritePaths` to prevent the agent from doing raw `git checkout`/`switch` (branch movement must go through `switch_branch`/`create_branch`).

The full single allowed-tool list (set as `def.tools` on the repo agent definition) is the same in RO and RW; what changes is which entries actually function.

### Always available (RO and RW)
- `Read`, `Glob`, `Grep` — file inspection (sandbox-bounded reads)
- `Bash` — read-side git commands work; write-side commands are blocked by the sandbox in RO mode
- `mcp__repo-agent-tools__send_message_to_agent`, `mcp__repo-agent-tools__log_finding`, `mcp__repo-agent-tools__share_artifact`
- `mcp__research-tools__web_research`
- `mcp__repo-tools__fetch` — fetch latest refs from origin
- `mcp__repo-tools__switch_branch` — switch branches with auto-stash
- `mcp__repo-tools__list_branches` — list branches the agent has touched in this task
- `mcp__repo-tools__list_prs`, `mcp__repo-tools__get_pr`, `mcp__repo-tools__get_pr_status`, `mcp__repo-tools__get_pr_reviews`, `mcp__repo-tools__get_pr_comments`, `mcp__repo-tools__get_review_threads`

### Disallowed in RO, allowed in RW
- `mcp__repo-tools__push_branch`
- `mcp__repo-tools__create_pull_request`
- `mcp__repo-tools__update_pr`
- `mcp__repo-tools__add_pr_comment`
- `mcp__repo-tools__add_review_comment`
- `mcp__repo-tools__reply_to_review_comment`
- `mcp__repo-tools__resolve_review_thread`
- `mcp__repo-tools__request_re_review`
- `mcp__repo-tools__merge_pull_request`
- `mcp__repo-tools__close_pull_request`
- `mcp__repo-tools__create_branch`

### Effectively gated by the sandbox (registered everywhere, but only succeed in RW)
- `Write`, `Edit` — blocked by `createFilesystemGuardHooks()` in RO; allowed in RW
- `Bash` write-side commands against the clone (`git add`, `git commit`, `git rm`, `git restore`, `git merge`, `rm`, etc.) — blocked by the OS sandbox `denyWrite` on the clone path in RO; allowed in RW

## Branch Strategy

The first feature branch follows the pattern `archie/{taskId}`, where `taskId` is the full task identifier (e.g., `task-20260101-1823-abc123`) and so already begins with `task-`. If the agent calls `create_branch` again on the same task, additional branches are auto-numbered as `archie/{taskId}-2`, `archie/{taskId}-3`, etc. Branch naming lives in `src/connectors/github/branch-naming.ts` (`taskBranchName()`). This naming serves double duty:

1. **Isolation**: Each task gets its own branch (or family of branches), preventing cross-task interference.
2. **Webhook routing**: The webhook router uses `extractTaskIdFromBranch()` (re-exported from `src/connectors/github/webhooks.ts`) to match incoming GitHub events (pushes, CI results, reviews) back to the correct task. The regex `^(?:archie|feature)\/(task-\d{8}-\d{4}-[a-z0-9]+)(?:-\d+)?$` extracts the task ID, allowing the optional `-N` suffix from multi-branch tasks. The legacy `feature/` prefix remains accepted so pull requests opened before the migration keep attributing to their task.

## Cross-Agent Isolation

Each repo agent in a task operates in its own shared clone within the task's session directory, plus a per-agent workspace under `agents/{agentKey}` that serves as the SDK `cwd`:

```
sessions/
  task-abc123/
    agents/
      backend/     <- workspace cwd for backend-agent (.claude/skills, hooks, etc.)
      mobile/      <- workspace cwd for mobile-agent
    repos/
      backend/     <- shared clone for backend-agent
      mobile/      <- shared clone for mobile-agent
    shared/
      knowledge.log
      metadata.json
```

Key isolation properties:

- **Separate clones**: Each repo agent gets its own task-local shared clone derived from a different base repository, so there is no cross-contamination between repositories.
- **Separate branches**: Each clone has its own `archie/{taskId}` branch (created in RW mode), branched from the respective repository's base branch.
- **Base repo isolation**: Clones are created with `git clone --shared` from the base repository. They borrow objects via `objects/info/alternates` but have independent refs/index, and `origin` is rewritten to GitHub so pushes never go back to the base repo. Multiple tasks can share the same base repo without conflict.
- **Git identity**: `configureGitIdentity(clonePath)` runs after clone creation so commits get the configured user name and email.

## Session Handling on Mode Transition

The PM agent's reactivation after approval/denial uses `task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')`, which routes through the standard task-reactivation path. When the PM later sends work to a repo agent, `ensureAgentSpawned()` calls `spawnAgent()` for that agent. Because the readonly clone was deleted on the earlier `task.stop()`, `cloneExists()` returns false and a brand-new clone is created — in RW mode that means `setupSharedClone({ type: 'new_branch', name: 'archie/{taskId}' })`. The SDK session for the repo agent is started without a prior `session_id`, so it starts fresh against the new clone path.

If a clone is reused across stop/reactivate cycles (e.g., RW reactivation where the clone was preserved), the existing SDK `session_id` (stored in `metadata.agent_sessions[agentId]`) is passed via `resume`, and the spawn flow runs `fetch origin` on the reused clone before continuing.

## Relevant Source Files

- `src/connectors/github/repo-clone.ts` — `setupSharedClone()`, `removeClone()`, `cloneExists()`, `isWorktree()`, `migrateWorktreeToClone()`, `CloneCheckout` type, `getDefaultBranch()`, `gitExec()`
- `src/connectors/github/branch-state.ts` — `hydrateBranchState()`, `mirrorLegacyFields()`, `findBranchStateByPR()` (per-branch state helpers)
- `src/agents/spawn.ts` — `spawnAgent()` with repo-track logic, tool gating, clone creation trigger, sandbox config
- `src/agents/sandbox.ts` — `buildSandboxConfig()`, `createFilesystemGuardHooks()` — the two layers that enforce the read-only clone in RO mode
- `src/agents/tools.ts` — `createPMAgentMcpServer` / `createRepoToolsMcpServer` / `createBaseAgentMcpServer`, `request_edit_mode` tool definition
- `src/tasks/task.ts` — `handleEditModeApproval()`, `handleEditModeDenial()`, `cleanupClones()`, `postInteractiveToUser()`
- `src/connectors/slack/events.ts` — `approve_edit_mode` and `deny_edit_mode` Bolt action handlers
- `src/connectors/api/routes.ts` — non-Slack approval/denial path (CLI/HTTP) that calls the same `handleEditMode*` methods
- `src/types/task.ts` — `TaskMetadata.edit_allowed`, `RepositoryInfo` with `clone_path` and `branch_states`, `BranchState` type
- `src/connectors/github/client.ts` — `configureGitIdentity()`, `fetchOrigin()`
- `src/connectors/github/webhooks.ts` — `extractTaskIdFromBranch()` for branch-to-task mapping
