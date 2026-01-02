# MVP Implementation Plans

Incremental development plan for the AI Engineer system. Each MVP adds a focused set of features.

---

## MVP 2: Edit Mode for Repo Agents

**Status**: Planned
**Goal**: Enable repo agents to transition from readonly mode to edit mode with human approval, set up git worktrees for isolated work, and create feature branches.

### Scope

**In Scope:**
- Two-mode system: readonly (default) and edit modes
- Non-blocking human approval via Slack (task-level, all repos)
- Git worktree creation with latest main (`git fetch origin main`)
- Feature branch creation from `origin/main` (local only, no commits yet)
- Mode persistence in task metadata
- Fetch latest main only when creating new worktree (not on reuse)
- Worktrees persist across agent runs (resumable work)

**Out of Scope (future MVPs):**
- Git commits
- Pull request creation
- Remote push operations
- Worktree cleanup (manual or future automation)
- Individual repo-level approvals (task-level only for MVP)

---

### Architecture Changes

#### 1. Task Metadata Extensions

**File**: [src/types/task.ts](../src/types/task.ts)

Add to `RepositoryInfo`:
```typescript
worktree_path?: string;                // Path to active worktree
feature_branch?: string;               // Branch name (feature/task-{id})
```

Add to `TaskMetadata`:
```typescript
edit_allowed?: boolean;                // Has user approved edit mode for this task?
```

**That's it!** All approval flow state lives in `shared-knowledge.log`, not in metadata.

#### 2. New MCP Tool: `request_edit_mode`

**File**: [src/mcp/tools.ts](../src/mcp/tools.ts)

Agent-callable tool that PM can use to request task-level edit mode approval.

**Behavior**:
- Logs to `shared-knowledge.log`: `[system] [edit_request] Edit mode requested: {reason}`
- Posts Slack message: "Edit mode request: {reason}" with interactive buttons
- **Stops the task runtime** (similar to `report_completion`)
- Task goes into paused state waiting for user decision
- Returns success message

**This is a completion-like action**: PM should explain findings to user via Slack BEFORE calling this tool, then call it to pause and wait for approval.

**Callback signature**:
```typescript
onRequestEditMode: (reason: string) => Promise<void>
```

**Slack message format**:
```javascript
{
  text: `Edit mode request: ${reason}`,
  blocks: [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Edit mode request: ${reason}` }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: "approve_edit_mode",
          value: taskId,
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: "deny_edit_mode",
          value: taskId,
          style: "danger"
        }
      ]
    }
  ]
}
```

**Note**: `task_id` is encoded in button `value` so handlers know which task to update.

**Tool access**: PM agent only (not repo agents)

**Agent intelligence**: PM reads `shared-knowledge.log` to check:
- If edit mode already requested → don't request again
- If edit mode approved → proceed with coordination
- If edit mode denied → adapt approach

#### 3. Worktree Management Module

**New file**: `src/system/worktree-manager.ts`

**Functions**:

```typescript
/**
 * Setup worktree for a repository in a task
 * 1. Fetches latest main from origin
 * 2. Creates worktree at <taskPath>/repos/<repoKey>
 * 3. Creates feature branch feature/task-{taskId} from origin/main
 * @returns Object with worktree_path and feature_branch
 */
export async function setupWorktree(
  taskId: string,
  repoKey: string,
  taskPath: string,
  baseRepoPath: string
): Promise<{
  worktree_path: string;
  feature_branch: string;
}>
```

**Note**: No cleanup functions in this MVP. Worktrees persist for manual cleanup or future automation.

**Implementation of `setupWorktree`**:
1. **Fetch latest commits**: `git fetch origin main` in base repo
   - This updates the `origin/main` ref to point to latest remote commits
   - Does NOT update local `main` branch or working directory
   - Only updates remote tracking refs
2. **Create branch name**: `feature/task-{taskId}`
3. **Create worktree**: `git worktree add -b {branchName} <worktreePath> origin/main`
   - Creates new worktree branching from the freshly-fetched `origin/main`
   - Worktree contains the latest code from remote
4. **Return both worktree path and branch name** - avoids duplicating branch name logic
- **NO cleanup in this MVP**: Worktrees persist indefinitely (manual cleanup or future automation)

#### 4. Repo Agent Spawn Logic Updates

**File**: [src/agents/repo-agent.ts](../src/agents/repo-agent.ts)

Modify `spawnRepoAgent()`:

**When spawning, check edit mode and setup worktree if needed**:
```typescript
const repoInfo = metadata.repositories[config.repoKey];
const editAllowed = metadata.edit_allowed === true;
const baseRepoPath = repoInfo?.path || config.defaultRepoPath;

let repoPath: string;

if (editAllowed) {
  // Edit mode - use worktree
  if (repoInfo?.worktree_path) {
    // Worktree already exists - reuse it
    repoPath = repoInfo.worktree_path;
  } else {
    // Create new worktree
    const taskPath = getTaskPath(metadata.task_id);

    // setupWorktree handles fetch + create worktree + branch name
    const { worktree_path, feature_branch } = await setupWorktree(
      metadata.task_id,
      config.repoKey,
      taskPath,
      baseRepoPath
    );

    // Update metadata with worktree info
    metadata.repositories[config.repoKey] = {
      ...repoInfo,
      worktree_path,
      feature_branch
    };
    await saveMetadata(metadata);

    repoPath = worktree_path;
  }
} else {
  // Readonly mode - use base repo
  repoPath = baseRepoPath;
}
```

**No worktree cleanup on agent stop**:

In this MVP, worktrees are NOT cleaned up when agents stop. This preserves uncommitted changes between agent runs. Cleanup will be added in future MVP when commit/push is implemented.

```typescript
// In the agent cleanup logic (handle.running finally block)
// NO worktree cleanup - preserve changes for now
```

**Tool access based on mode**:
- **Readonly mode** (`edit_allowed` is false/undefined):
  - `cwd`: base repo path
  - `allowedTools`: Read, Glob, Grep, MCP tools (current behavior)
  - No Write, Edit, or Bash access

- **Edit mode** (`edit_allowed` is true):
  - `cwd`: worktree path
  - `allowedTools`: Add Write, Edit to readonly tools
  - File write access in isolated worktree
  - **No Bash access** - not needed for MVP 2 (git operations out of scope)

#### 5. Task Runtime Edit Mode Flow

**File**: [src/system/task-runtime.ts](../src/system/task-runtime.ts)

##### When PM calls `request_edit_mode`:

Implement `onRequestEditMode` callback:

1. Log to `shared-knowledge.log`: `[system] [edit_request] Edit mode requested: {reason}`
2. Post to Slack: **"Edit mode request: {reason}"** with Approve/Deny buttons
   - Message comes from Archie bot (natural conversation)
   - User sees it as part of the task thread
3. **Stop all agents** (similar to `report_completion`)
   - Stop PM agent queue
   - Stop all repo agent queues
   - Set task as inactive (waiting for approval)
4. Task runtime remains in memory, ready to resume on approval/denial

**This behaves like task completion**: Task pauses, all agents stop, system waits for user decision.

##### When user clicks Approve button in Slack:

Handler flow:

1. Read task metadata
2. Update metadata: `metadata.edit_allowed = true`
3. Save metadata
4. **Log to `shared-knowledge.log`**: `[system] [edit_approved] Edit mode approved by user`
5. **Reactivate task and spawn PM agent**:
   - Set task as active
   - Spawn PM agent with new message: "Edit mode has been approved."
   - PM reads log, sees approval, coordinates next steps with repo agents
   - PM will acknowledge to user if appropriate

**Note**: Worktrees are NOT created here! They're created lazily when repo agents spawn (see section 4).

##### When user clicks Deny button in Slack:

Handler flow:

1. **Log to `shared-knowledge.log`**: `[system] [edit_denied] Edit mode denied by user`
2. **Reactivate task and spawn PM agent**:
   - Set task as active
   - Spawn PM agent with new message: "Edit mode was denied."
   - PM reads log, sees denial, adapts approach and communicates with user

#### 6. Slack Integration Updates

**File**: Slack handler file (location TBD based on current setup)

**Add button interaction handler** (separate from message events):

Slack sends button clicks as `interactive` events, not `message` events. Handle these separately:

```typescript
// Interactive handler - bypasses triage entirely
app.action('approve_edit_mode', async ({ action, ack, body }) => {
  await ack();
  const taskId = action.value; // task_id encoded in button value
  await handleEditModeApproval(taskId);
  // Update original message to show approval
});

app.action('deny_edit_mode', async ({ action, ack, body }) => {
  await ack();
  const taskId = action.value; // task_id encoded in button value
  await handleEditModeDenial(taskId);
  // Update original message to show denial
});
```

**Key points**:
- ✅ **Bypasses triage** - button clicks don't go through message routing
- ✅ **Direct task lookup** - `task_id` encoded in button value
- ✅ **Fast response** - no LLM call needed for classification
- ✅ **Update original message** - edit the request message to show approved/denied state

---

### File Changes Summary

**New files**:
- `src/system/worktree-manager.ts` (~150 lines)

**Modified files**:
- [src/types/task.ts](../src/types/task.ts) - Add fields to `RepositoryInfo` and `TaskMetadata`
- [src/mcp/tools.ts](../src/mcp/tools.ts) - Add `request_edit_mode` tool for PM agent
- [src/agents/repo-agent.ts](../src/agents/repo-agent.ts) - Mode-aware spawning logic
- [src/agents/pm.ts](../src/agents/pm.ts) - Add `request_edit_mode` to PM's tool list
- [src/system/task-runtime.ts](../src/system/task-runtime.ts) - Implement approval flow and cleanup
- Slack handler file - Add button interaction for approve/deny

---

### Flow Example

**Scenario**: User asks to fix a login bug that spans backend and mobile

1. User posts in Slack: "Fix the login bug - users can't sign in on iOS"
2. PM agent spawns (readonly mode), assigns mobile-agent as owner
3. Mobile-agent investigates, finds issue in React Native code
4. Mobile-agent messages backend-agent: "Need to check API response format"
5. Backend-agent investigates, finds API returns wrong status code
6. Backend-agent reports to PM: "API returns 401 instead of 403 for expired tokens"
7. PM reads `shared-knowledge.log`, understands both repos need changes
8. **PM posts to Slack**: "I've identified the root causes. The iOS app has a 30s timeout but our backend API can take up to 45s during peak load. Android works because it has a 60s timeout. To fix this, I need to update both the backend API response time and the mobile timeout settings. Requesting permission to make these changes."
9. PM calls `request_edit_mode("Fix API response time in backend and adjust timeout settings in mobile app")`
10. Tool logs to `shared-knowledge.log`: `[system] [edit_request] Edit mode requested: Fix API response time...`
11. **System stops all agents** (task goes into paused/waiting state)
12. **Archie posts to Slack**: "Edit mode request: Fix API response time in backend and adjust timeout settings in mobile app" with [Approve] [Deny] buttons
13. User clicks "Approve" (could be minutes or hours later)
14. System:
    - Updates metadata: `edit_allowed: true`
    - **Logs to `shared-knowledge.log`**: `[system] [edit_approved] Edit mode approved by user`
    - **Reactivates task and spawns PM agent** with message: "Edit mode has been approved."
15. PM reads `shared-knowledge.log`, sees `[edit_approved]`, knows it can proceed
16. PM posts to Slack: "Great! I'll coordinate the fixes now." (natural acknowledgment)
17. PM messages backend-agent: "Please fix the API status code issue"
18. Backend-agent spawn begins (first time):
    - Checks `metadata.edit_allowed === true`
    - No worktree exists yet → calls `setupWorktree()`:
      - Fetches latest main: `git fetch origin main` in base repo
      - Creates worktree at `tasks/{taskId}/repos/backend`
      - Creates branch `feature/task-{taskId}` from `origin/main`
      - Returns `{ worktree_path, feature_branch }`
    - Saves both to metadata (single source of truth for branch name)
    - Spawns with Write/Edit tools, `cwd` = worktree path
19. Backend-agent makes changes to backend code
20. Backend-agent finishes turn and stops
    - **Worktree is NOT cleaned up** - changes preserved for next run
21. User asks for more changes, PM messages backend-agent again
22. Backend-agent spawn (second time):
    - Worktree exists → **No fetch needed**, just reuses existing worktree
    - Spawns with same worktree, continues from previous changes
23. PM messages mobile-agent similarly
24. Mobile-agent spawns (first time):
    - Calls `setupWorktree()` (fetch + create worktree)
    - Creates its own worktree at `tasks/{taskId}/repos/mobile`
25. Mobile-agent makes changes
26. Later, PM calls `report_completion` when ready to hand off to user
    - **Worktrees are NOT cleaned up** - task may continue after user review
27. User reviews changes, asks for modifications
28. Task reactivates, agents spawn and reuse existing worktrees with changes intact
29. Eventually user decides task is truly done
    - **Worktrees remain** - manual cleanup or future enhancement will handle this

**Key simplification**: All approval state flows through `shared-knowledge.log`. Agents read the log to understand:
- Has edit mode been requested? → Look for `[edit_request]`
- Was it approved or denied? → Look for `[edit_approved]` or `[edit_denied]`
- No complex metadata tracking needed!

---

### Benefits

✅ **No timeout issues** - user can approve hours/days later
✅ **Natural PM flow** - PM completes investigation before requesting permission
✅ **Task-level approval** - one approval for entire task (simpler UX)
✅ **Minimal state tracking** - only `edit_allowed` boolean in metadata
✅ **Agent intelligence** - agents read `shared-knowledge.log` to understand approval state
✅ **Clean resume** - existing session resume mechanism handles continuation
✅ **Change persistence** - worktrees preserved between agent runs
✅ **Lazy worktree creation** - only created when agent actually spawns in edit mode
✅ **Always up-to-date** - fetches latest main when creating worktree
✅ **Better UX** - PM explains what needs to be done and why before stopping
✅ **Simplicity** - no complex pending request state, just log entries
✅ **No shell access** - edit mode only adds Write/Edit, no Bash commands needed

---

### Design Decisions

#### Why task-level approval instead of per-repo?

**Reasoning**:
- Simpler UX - one approval for the whole task
- Matches mental model - "approve the work" not "approve each tool"
- Can always add per-repo approval later if needed
- PM has full context to explain why edit mode is needed

#### Why PM requests edit mode, not repo agents?

**Reasoning**:
- PM has full task context and can explain the need clearly
- Repo agents focus on technical work
- Single approval point is simpler
- Matches real-world workflow - PM asks for approval, engineers execute

#### Why create worktrees on agent spawn, not on approval?

**Reasoning**:
- **Lazy creation**: Only create worktree when agent actually needs it
- **Simpler approval flow**: Approval just sets `edit_allowed` flag, no heavy operations
- **No wasted resources**: If PM gets approval but never spawns repo agent, no worktree created
- **Clean separation**: Approval is policy decision, worktree is implementation detail

#### Why NOT cleanup worktrees on agent stop?

**Reasoning**:
- **Preserve uncommitted changes**: Agents may make changes across multiple runs
- **Resumable work**: Agent can stop/resume without losing progress
- **Simpler for MVP**: Don't need to worry about commit state yet
- **Cleanup on completion**: When PM reports task complete, all worktrees cleaned up
- **Future-proof**: When commits are added, cleanup will move to after push

#### Why fetch only when creating worktree, not on reuse?

**Reasoning**:
- **Fetch when needed**: Only fetch when creating new worktree to get latest code
- **Preserve existing work**: Don't fetch on reuse - agent continues from where it left off
- **Simpler for MVP**: No need to handle fetch conflicts or merge scenarios
- **Performance**: Skip unnecessary network calls on subsequent spawns
- **Future enhancement**: When we add commits/rebase, we can add fetching on reuse
- **Safe operation**: `git fetch` only updates remote refs, doesn't touch working directory

#### Why not include commits/PRs in this MVP?

**Reasoning**:
- Keeps MVP focused and testable
- Worktree + edit mode is the foundation
- Can validate the approval flow works before adding complexity
- Commits/PRs are separate concerns that can build on this

#### Why use `shared-knowledge.log` for approval state instead of metadata?

**Reasoning**:
- Agents already read the log for context
- Single source of truth for all task events
- No complex state machine to maintain
- Approval/denial are events, not persistent state
- Simpler implementation - just log entries
- Agents can naturally reason about "has edit been requested/approved/denied"

#### Why treat `request_edit_mode` like task completion?

**Reasoning**:
- **Natural workflow**: PM explains findings to user, then pauses for decision
- **Clean separation**: Investigation phase (readonly) → approval → implementation phase (edit)
- **User communication**: PM gives full explanation BEFORE requesting edit mode
- **Consistent pattern**: Similar to `report_completion` - PM communicates, then stops
- **Clear state**: Task is either actively investigating or waiting for approval
- **Resumable**: On approval/denial, task reactivates and continues from paused state

---

### Testing Checklist

- [ ] Readonly mode works as before (no regression)
- [ ] PM explains findings to user via Slack BEFORE calling request_edit_mode
- [ ] PM can request edit mode, logs to `shared-knowledge.log`
- [ ] request_edit_mode stops all agents (task goes into paused state)
- [ ] Slack approval buttons appear correctly with task_id in button value
- [ ] Button interactions bypass triage (handled as separate interactive events)
- [ ] Approve button: sets `edit_allowed`, logs, reactivates task, spawns PM
- [ ] Deny button: logs, reactivates task, spawns PM
- [ ] Button click updates original message to show approved/denied state
- [ ] PM can read log and detect if edit request already sent
- [ ] PM can read log and detect if edit was approved/denied
- [ ] Task remains in memory while paused (can resume quickly)
- [ ] Repo agent spawn creates worktree when `edit_allowed === true` (first time only)
- [ ] Fetch happens ONLY when creating worktree (not on reuse)
- [ ] Worktree created from `origin/main` (up-to-date code at creation time)
- [ ] Repo agent spawn reuses existing worktree on subsequent runs (no fetch)
- [ ] Subsequent spawns preserve uncommitted changes from previous runs
- [ ] Repo agents spawn with correct tools based on `edit_allowed` flag
- [ ] Repo agents have correct `cwd` based on `edit_allowed` flag
- [ ] Repo agent stop does NOT cleanup worktree (changes preserved)
- [ ] Multiple repos can be in edit mode simultaneously (each with own worktree)
- [ ] Task completion (PM report_completion) does NOT cleanup worktrees
- [ ] Worktrees persist across task lifecycle (resumable after completion)
- [ ] User can request more changes after report_completion, worktrees reused
- [ ] Metadata persists correctly across restarts (only `edit_allowed` + worktree paths)
- [ ] Session resume works after approval/denial
- [ ] Worktree not created if approval given but agent never spawns
- [ ] Changes persist between agent runs (can resume work)

---

## Future MVPs

### MVP 3: Git Commits and Pull Requests (Planned)

**Scope**:
- Repo agents can commit changes with descriptive messages
- PM can request PR creation after work is complete
- PRs link back to Slack thread
- PR updates notify Slack thread

### MVP 4: Multi-repository Coordination (Planned)

**Scope**:
- Synchronized commits across repositories
- Cross-repo testing before PR creation
- Dependency management between repos

### MVP 5: Continuous Integration (Planned)

**Scope**:
- Agents run tests before committing
- CI status updates in Slack
- Auto-fix common test failures
