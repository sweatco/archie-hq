# Edit Mode

Archie operates in two modes: **readonly** (the default) and **edit** (after human approval). This two-mode system implements a human-in-the-loop safety gate that prevents agents from modifying code without explicit user consent.

## Two-Mode System

### Readonly Mode (Default)

When a task starts, all agents operate in readonly mode. Repo agents can read and search code using `Read`, `Glob`, and `Grep` tools, plus read-only git commands (`git log`, `git diff`, `git show`, `git blame`, `git branch`) and PR read tools (`list_prs`, `get_pr`, `get_pr_status`, `get_pr_reviews`). They cannot modify any files.

In readonly mode, the repo agent's `cwd` is a task-local worktree at `sessions/{taskId}/repos/{repoKey}` in detached HEAD mode at `origin/{baseBranch}`. Readonly worktrees are cleaned up when the task stops or completes.

### Edit Mode (After Approval)

Once edit mode is approved for a task, repo agents gain access to file modification tools, local git commands, and PR write tools (push, create PR, merge, etc.). The worktree switches to a feature branch, and additional tools become available. Edit mode is a one-way, permanent transition for the task -- once approved, it cannot be revoked.

## Human-in-the-Loop Approval Flow

The transition from readonly to edit mode follows this sequence:

### 1. PM Requests Edit Mode

The PM agent calls the `request_edit_mode` MCP tool (defined in `src/agents/tools.ts`) with a reason string explaining what changes are needed. Before calling this tool, the PM is expected to have already explained the situation to the user via `post_to_slack`.

### 2. Interactive Buttons Posted to Slack

The `onRequestEditMode` callback in `src/tasks/task.ts` posts a Block Kit message to all tracked Slack threads with two buttons:

```
*Edit mode request:* <reason>
[ Approve ]  [ Deny ]
```

The buttons use action IDs `approve_edit_mode` and `deny_edit_mode`, with the task ID as the button value.

### 3. Task Pauses

Immediately after posting the approval request, the system calls `task.stop()`. This stops all agent queues and deactivates all agents. The task is fully paused until the user responds.

### 4. User Clicks a Button

**Approve** (handled in `src/connectors/slack/events.ts: app.action("approve_edit_mode")`):
- The original message is updated to remove the buttons and show "Edit mode approved by \<user\>".
- `handleEditModeApproval()` in `src/tasks/task.ts` is called.
- Sets `metadata.edit_allowed = true` on the task.
- Logs "Edit mode approved by user" to the knowledge log.
- Reactivates the PM agent with "New input received. Check knowledge.log for the update."

**Deny** (handled in `src/connectors/slack/events.ts: app.action("deny_edit_mode")`):
- The original message is updated to remove the buttons and show "Edit mode denied by \<user\>".
- `handleEditModeDenial()` in `src/tasks/task.ts` is called.
- Logs "Edit mode denied by user" to the knowledge log.
- Reactivates the PM agent to handle the denial (e.g., provide readonly findings instead).

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

## Git Worktree Management

All repo agents operate in isolated git worktrees, regardless of mode. This is managed by `src/connectors/github/worktree.ts`.

### `setupWorktree()`

The `setupWorktree()` function creates a new worktree for a repository in a task. It accepts a `WorktreeCheckout` parameter that determines the checkout mode:

```typescript
type WorktreeCheckout =
  | { type: 'detached'; sha?: string }    // Detached HEAD at origin/{baseBranch} or specific SHA
  | { type: 'branch'; name: string }       // Checkout existing branch (normal)
  | { type: 'new_branch'; name: string };  // Create new branch from origin/{baseBranch}
```

Steps:
1. **Base branch detection**: Uses the provided `baseBranch` parameter, or auto-detects by checking `refs/remotes/origin/HEAD`, then falling back to `origin/main`, then `origin/master`.
2. **Fetch latest**: Calls `fetchOrigin(baseRepoPath, baseBranch)` to pull the latest commits for the base branch.
3. **Worktree creation**: Creates the worktree using the appropriate git command based on checkout type:
   - `detached`: `git worktree add --detach "{path}" origin/{baseBranch}` (or specific SHA)
   - `branch`: `git worktree add "{path}" {branchName}`
   - `new_branch`: `git worktree add -b {branchName} "{path}" origin/{baseBranch}`
4. **Existing branch handling**: If a `new_branch` already exists (e.g., task recovery), it checks for an existing worktree first, then falls back to creating a worktree with the existing branch.

The worktree is placed at `sessions/{taskId}/repos/{repoKey}` (e.g., `sessions/task-abc123/repos/backend`).

### Worktree Creation at Spawn

Worktrees are created when a repo agent is spawned. This happens inside the repo track branch of `spawnAgent()` in `src/agents/spawn.ts`:

```
spawnAgent() called (repo track)
  -> Check if worktree already exists at task-local path
  -> If yes: reuse existing worktree, fetch origin for latest base
  -> If no:
    -> Determine checkout target from previous branch state + edit mode:
      - edit_allowed && no previous branch: new_branch (feature/{taskId})
      - had an owned branch: branch (restore it)
      - was on existing branch: detached at recorded SHA
      - default: detached HEAD at base branch
    -> Call setupWorktree() with the checkout target
    -> Update metadata with worktree info and branch state
    -> Start a fresh SDK session (cwd changed)
```

### Worktree Cleanup

When a readonly task stops or completes, the `removeWorktree()` function (`src/connectors/github/worktree.ts`) is called to clean up the worktree from the base repository. This uses `git worktree remove --force` and falls back to `git worktree prune` if the directory is already gone.

### Worktree Metadata

After worktree creation, the following fields are stored in `metadata.repositories[repoKey]` (`src/types/task.ts`):

```typescript
interface RepositoryInfo {
  path: string;                                    // Base repository path
  worktree_path?: string;                          // Path to active worktree
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
  owned: boolean;                      // true = agent created, false = existing branch
  head_sha: string;                    // HEAD position when agent last left this branch
  base_branch?: string;                // PR target branch (e.g. 'main')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // GitHub comment triage cursor
  stash_name?: string;                 // Set if dirty work was auto-stashed
}
```

Branch state helpers live in `src/connectors/github/branch-state.ts`:
- `hydrateBranchState()` -- initialize `branch_states` from a newly created branch
- `mirrorLegacyFields()` -- sync current branch state to legacy top-level fields
- `findBranchStateByPR()` -- look up a branch by its PR number (for webhook routing)

## Tool Restrictions

The allowed tools for a repo agent are determined at spawn time based on the `edit_allowed` flag. In `src/agents/spawn.ts`, the `allowedTools` array is constructed conditionally:

### Readonly Mode Tools
- `Read` -- Read file contents
- `Glob` -- Find files by pattern
- `Grep` -- Search file contents
- `mcp__repo-agent-tools__send_message_to_agent` -- Inter-agent communication
- `mcp__repo-agent-tools__log_finding` -- Write to shared knowledge log
- `mcp__research-tools__web_research` -- Web research
- `mcp__repo-tools__fetch` -- Fetch latest refs from origin
- `mcp__repo-tools__switch_branch` -- Switch branches with auto-stash
- `mcp__repo-tools__list_prs` -- List PRs with filters
- `mcp__repo-tools__get_pr` -- Get full PR details including diff
- `mcp__repo-tools__get_pr_status` -- Check PR mergeable state
- `mcp__repo-tools__get_pr_reviews` -- Fetch PR reviews and comments
- `Bash(git log*)` -- View commit history
- `Bash(git diff*)` -- View changes
- `Bash(git show *)` -- Inspect commits
- `Bash(git blame *)` -- Line-by-line attribution
- `Bash(git branch -r*)` -- List remote branches
- `Bash(git branch --show-current)` -- Show current branch name
- `Bash(git ls-files*)` -- List tracked files
- `Bash(git ls-tree *)` -- List tree contents

### Edit Mode Additional Tools
- `Write` -- Write entire file contents
- `Edit` -- Make targeted edits to files
- `Bash(rm *)` -- Delete files
- `Bash(git add *)` -- Stage changes
- `Bash(git rm *)` -- Remove tracked files
- `Bash(git commit *)` -- Create commits
- `Bash(git status*)` -- Check working tree status
- `Bash(git merge *)` -- Merge branches (for conflict resolution with origin/main)
- `Bash(git restore *)` -- Unstage or discard changes
- `mcp__repo-tools__push_branch` -- Push commits to origin
- `mcp__repo-tools__create_pull_request` -- Create a PR on GitHub
- `mcp__repo-tools__update_pr` -- Update PR title/description
- `mcp__repo-tools__add_pr_comment` -- Add a general PR comment
- `mcp__repo-tools__add_review_comment` -- Comment on a specific line
- `mcp__repo-tools__resolve_review_thread` -- Mark a review thread as resolved
- `mcp__repo-tools__request_re_review` -- Request reviewers to re-review
- `mcp__repo-tools__merge_pull_request` -- Merge a PR
- `mcp__repo-tools__close_pull_request` -- Close a PR without merging
- `mcp__repo-tools__create_branch` -- Create and switch to a new branch
- `mcp__repo-tools__list_branches` -- List branches in the current task

Note: Bash permission patterns use space syntax (e.g., `Bash(git add *)`) not colon syntax.

## Branch Strategy

All feature branches follow the pattern `feature/task-{taskId}`, where `taskId` is the full task identifier (e.g., `task-01012026-1823-abc123`). This naming convention serves double duty:

1. **Isolation**: Each task gets its own branch, preventing cross-task interference.
2. **Webhook routing**: The webhook router uses `extractTaskIdFromBranch()` in `src/connectors/github/webhooks.ts` to match incoming GitHub events (pushes, CI results, reviews) back to the correct task. The regex pattern `^feature\/(task-[a-z0-9-]+)$` extracts the task ID from the branch name.

## Cross-Agent Isolation

Each repo agent in a task operates in its own worktree within the task's session directory:

```
sessions/
  task-abc123/
    repos/
      backend/     <- worktree for backend-agent
      mobile/      <- worktree for mobile-agent
    shared/
      knowledge.log
      metadata.json
```

Key isolation properties:

- **Separate worktrees**: Each repo agent gets its own worktree cloned from a different base repository. There is no cross-contamination between repositories.
- **Separate branches**: Each worktree has its own `feature/task-{id}` branch, branched from the respective repository's base branch.
- **Base repo isolation**: Worktrees are created from the base repository using `git worktree add`, which means the base repository remains untouched. Multiple tasks can share the same base repo without conflict.
- **Git identity inheritance**: Worktrees inherit the git user name and email from the base repository, which is configured once at server startup.

## Session Handling on Mode Transition

When a new worktree is created (either for a fresh readonly task or after edit mode approval), `spawnAgent()` sets `startFreshSession = true`, which causes the agent to start a fresh Claude Agent SDK session. This ensures the agent's filesystem context is correct for the new working directory.

If the worktree already exists (e.g., task was stopped and reactivated), the existing session ID is reused and the agent fetches the latest origin to ensure remote refs are up-to-date.

## Relevant Source Files

- `src/connectors/github/worktree.ts` -- `setupWorktree()`, `removeWorktree()`, `worktreeExists()`, `getWorktreeBranch()`, `WorktreeCheckout` type, base branch detection
- `src/connectors/github/branch-state.ts` -- `hydrateBranchState()`, `mirrorLegacyFields()`, `findBranchStateByPR()` (per-branch state helpers)
- `src/agents/spawn.ts` -- `spawnAgent()` with repo track logic, tool restriction, worktree creation trigger
- `src/agents/tools.ts` -- `repo-tools` MCP server (git workflow + PR tools), `request_edit_mode` tool definition
- `src/tasks/task.ts` -- `handleEditModeApproval()`, `handleEditModeDenial()`
- `src/connectors/slack/events.ts` -- `approve_edit_mode` and `deny_edit_mode` Bolt action handlers
- `src/types/task.ts` -- `TaskMetadata.edit_allowed`, `RepositoryInfo` with `branch_states`, `BranchState` type
- `src/connectors/github/client.ts` -- `configureGitIdentity()`, `fetchOrigin()` (with optional branch parameter)
- `src/connectors/github/webhooks.ts` -- `extractTaskIdFromBranch()` for branch-to-task mapping
