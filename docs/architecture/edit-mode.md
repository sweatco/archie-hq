# Edit Mode

Archie operates in two modes: **readonly** (the default) and **edit** (after human approval). This two-mode system implements a human-in-the-loop safety gate that prevents agents from modifying code without explicit user consent.

## Two-Mode System

### Readonly Mode (Default)

When a task starts, all agents operate in readonly mode. Repo agents can read and search code using `Read`, `Glob`, and `Grep` tools, but cannot modify any files or run arbitrary commands. This is the mode used for investigation, analysis, and answering questions about the codebase.

In readonly mode, the repo agent's `cwd` is set to the base repository path (the shared clone configured in repo agent configs).

### Edit Mode (After Approval)

Once edit mode is approved for a task, repo agents gain access to file modification and local git tools. The agent's `cwd` switches to an isolated worktree, and additional tools become available. Edit mode is a one-way, permanent transition for the task -- once approved, it cannot be revoked.

## Human-in-the-Loop Approval Flow

The transition from readonly to edit mode follows this sequence:

### 1. PM Requests Edit Mode

The PM agent calls the `request_edit_mode` MCP tool (defined in `src/mcp/tools.ts`) with a reason string explaining what changes are needed. Before calling this tool, the PM is expected to have already explained the situation to the user via `post_to_slack`.

### 2. Interactive Buttons Posted to Slack

The `onRequestEditMode` callback in `src/system/task-runtime.ts` posts a Block Kit message to all tracked Slack threads with two buttons:

```
*Edit mode request:* <reason>
[ Approve ]  [ Deny ]
```

The buttons use action IDs `approve_edit_mode` and `deny_edit_mode`, with the task ID as the button value.

### 3. Task Pauses

Immediately after posting the approval request, the system calls `stopTask()`. This stops all agent queues and deactivates all agents. The task is fully paused until the user responds.

### 4. User Clicks a Button

**Approve** (handled in `src/system/server.ts: app.action("approve_edit_mode")`):
- The original message is updated to remove the buttons and show "Edit mode approved by \<user\>".
- `handleEditModeApproval()` in `src/system/task-runtime.ts` is called.
- Sets `metadata.edit_allowed = true` on the task.
- Logs "Edit mode approved by user" to the knowledge log.
- Reactivates the PM agent with "New input received. Check knowledge.log for the update."

**Deny** (handled in `src/system/server.ts: app.action("deny_edit_mode")`):
- The original message is updated to remove the buttons and show "Edit mode denied by \<user\>".
- `handleEditModeDenial()` in `src/system/task-runtime.ts` is called.
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

When a repo agent spawns in edit mode, it operates in an isolated git worktree rather than the shared base repository. This is managed by `src/system/worktree-manager.ts`.

### `setupWorktree()`

The `setupWorktree()` function creates a new worktree for a repository in a task:

1. **Base branch detection**: Uses the provided `baseBranch` parameter, or auto-detects by checking `refs/remotes/origin/HEAD`, then falling back to `origin/main`, then `origin/master`.
2. **Fetch latest**: Calls `fetchOrigin()` to pull the latest commits for the base branch.
3. **Feature branch naming**: Creates a branch named `feature/{taskId}` (e.g., `feature/task-01012026-1823-abc123`). The task ID already includes the `task-` prefix.
4. **Worktree creation**: Runs `git worktree add -b {featureBranch} "{worktreePath}" origin/{baseBranch}` to create the worktree with a new branch based on the latest remote base.
5. **Existing branch handling**: If the feature branch already exists (e.g., task recovery), it checks for an existing worktree first, then falls back to creating a worktree with the existing branch.

The worktree is placed at `sessions/{taskId}/repos/{repoKey}` (e.g., `sessions/task-abc123/repos/backend`).

### Lazy Worktree Creation

Worktrees are **not** created when edit mode is approved. They are created lazily when a repo agent is actually spawned in edit mode. This happens inside `spawnRepoAgent()` in `src/agents/repo-agent.ts`:

```
spawnRepoAgent() called
  -> Check metadata.edit_allowed
  -> If true:
    -> Check if worktree already exists (repoInfo.worktree_path)
    -> If yes: reuse existing worktree, fetch origin for latest base
    -> If no:  call setupWorktree(), update metadata with worktree info
  -> If false:
    -> Use base repo path in readonly mode
```

This means the worktree is created on-demand the first time an agent needs it after approval, not at approval time. This is important because edit mode approval may happen while no agents are running.

### Worktree Metadata

After worktree creation, the following fields are stored in `metadata.repositories[repoKey]` (`src/types/task.ts: RepositoryInfo`):

```typescript
interface RepositoryInfo {
  path: string;               // Base repository path
  worktree_path?: string;     // Path to active worktree (edit mode)
  feature_branch?: string;    // Branch name in worktree (feature/task-{id})
  base_branch?: string;       // Base branch (main, master, etc.)
  pr_number?: number;         // PR number for this repo in this task
}
```

## Tool Restrictions

The allowed tools for a repo agent are determined at spawn time based on the `edit_allowed` flag. In `src/agents/repo-agent.ts`, the `allowedTools` array is constructed conditionally:

### Readonly Mode Tools
- `Read` -- Read file contents
- `Glob` -- Find files by pattern
- `Grep` -- Search file contents
- `mcp__repo-agent-tools__send_message_to_agent` -- Inter-agent communication
- `mcp__repo-agent-tools__log_finding` -- Write to shared knowledge log
- `mcp__research-tools__web_research` -- Web research

### Edit Mode Additional Tools
- `Write` -- Write entire file contents
- `Edit` -- Make targeted edits to files
- `Bash(git add:*)` -- Stage changes
- `Bash(git commit:*)` -- Create commits
- `Bash(git status:*)` -- Check working tree status
- `Bash(git diff:*)` -- View changes
- `Bash(git log:*)` -- View commit history
- `Bash(git merge:*)` -- Merge branches (for conflict resolution with origin/main)
- `Bash(git restore:*)` -- Unstage or discard changes

Note that `git push` and `git fetch` are not available to repo agents. Remote operations are handled exclusively by the PM agent via the `push_branch` MCP tool (see [GitHub Integration](./github-integration.md)).

## Branch Strategy

All feature branches follow the pattern `feature/task-{taskId}`, where `taskId` is the full task identifier (e.g., `task-01012026-1823-abc123`). This naming convention serves double duty:

1. **Isolation**: Each task gets its own branch, preventing cross-task interference.
2. **Webhook routing**: The webhook router uses `extractTaskIdFromBranch()` in `src/github/webhook-utils.ts` to match incoming GitHub events (pushes, CI results, reviews) back to the correct task. The regex pattern `^feature\/(task-[a-z0-9-]+)$` extracts the task ID from the branch name.

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

When a repo agent transitions from readonly to edit mode (worktree created for the first time), the agent's working directory changes from the base repo to the worktree. Since the `cwd` change is not a child path of the original, `spawnRepoAgent()` sets `startFreshSession = true`, which causes the agent to start a fresh Claude Agent SDK session instead of resuming the previous one. This ensures the agent's filesystem context is correct for the new working directory.

If the worktree already exists (e.g., task was stopped and reactivated), the existing session ID is reused and the agent fetches the latest origin to ensure `origin/main` is up-to-date for potential conflict resolution.

## Relevant Source Files

- `src/system/worktree-manager.ts` -- `setupWorktree()`, `worktreeExists()`, `getWorktreeBranch()`, base branch detection
- `src/agents/repo-agent.ts` -- `spawnRepoAgent()` with edit mode logic, tool restriction, worktree creation trigger
- `src/system/task-runtime.ts` -- `onRequestEditMode` callback, `handleEditModeApproval()`, `handleEditModeDenial()`
- `src/system/server.ts` -- `approve_edit_mode` and `deny_edit_mode` Bolt action handlers
- `src/mcp/tools.ts` -- `request_edit_mode` tool definition
- `src/types/task.ts` -- `TaskMetadata.edit_allowed`, `RepositoryInfo` with worktree fields
- `src/github/client.ts` -- `configureGitIdentity()`, `fetchOrigin()`
- `src/github/webhook-utils.ts` -- `extractTaskIdFromBranch()` for branch-to-task mapping
