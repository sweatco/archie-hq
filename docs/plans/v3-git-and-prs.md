> **Status: Implemented** — Full GitHub App integration with PR creation, review handling, merge orchestration, webhook routing, and pattern-restricted Bash for local git operations.

# MVP 3: Git Commits & Pull Requests

**Status**: Planned
**Goal**: Enable agents to commit changes, create PRs, handle review feedback, and auto-merge when approved.

## Key Design Decisions

### Clear Separation of Responsibilities

**Repo Agent** - Code only, local git only

- Tools: Read, Write, Edit, Glob, Grep
- Bash: `git add`, `git commit`, `git status`, `git diff`, `git log`, `git merge`
- No knowledge of GitHub, PRs, or remote operations
- Communicates completion to PM via `send_message`

**PM Agent** - All external communication

- Slack messaging (existing)
- GitHub PR management (new)
- Coordinates multi-repo work
- Writes PR descriptions (has full task context)

**System** - Automatic operations

- Fetches repos on task resume (after triage, before PM)
- Merges PRs when all linked PRs approved and mergeable
- Notifies PM after merge for Slack communication

### No Remote Git in Bash

- `git push`, `git fetch` are NOT allowed as bash commands
- Remote operations happen via MCP tools (PM) or system-level (fetch on resume)
- Reasons:
  - No credentials exposed in console
  - No destructive remote commands in bash
  - PM controls when code goes remote

---

## Scope

**In Scope:**

- Bash access in edit mode for local git commands (pattern-restricted)
- PR management via GitHub API (`@octokit/app`) - owned by PM agent
- PR registration in task metadata
- GitHub App integration for webhooks and API
- GitHub webhooks routed through Triage → PM (same as Slack)
- Auto-merge when all linked PRs approved/mergeable (system-level)
- Cross-PR linking in descriptions
- Conflict resolution via `git merge origin/main`
- System-level fetch on task resume

**Out of Scope (future MVPs):**

- CI status check handling (MVP 5)
- Automated test running before commit (MVP 5)

---

## Architecture Changes

### 1. Repo Config Extension

**Type file**: [src/types/repo-agent.ts](../src/types/repo-agent.ts)
**Config file**: [src/agents/repo-configs.ts](../src/agents/repo-configs.ts)

Add GitHub repo identifier to config:

```typescript
// Add to RepoAgentConfig interface
githubRepo: string;  // e.g., "acme/backend"
```

Add lookup helper for webhook handling:
```typescript
export function getRepoConfigByGithubRepo(githubRepo: string): RepoAgentConfig | undefined
```

### 2. Task Metadata Extension

**File**: [src/types/task.ts](../src/types/task.ts)

Add PR number to `RepositoryInfo`:

```typescript
// Add to RepositoryInfo interface
pr_number?: number;  // PR number for this repo in this task
```

URL can be derived: `https://github.com/{githubRepo}/pull/{pr_number}`

### 3. Repo Agent Edit Mode - Local Git Only

**File**: [src/agents/repo-agent.ts](../src/agents/repo-agent.ts)

In edit mode, add Bash to `allowedTools` with pattern restrictions for **local git operations only**:

```typescript
// Add to allowedTools when editAllowed is true
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git status:*)",
"Bash(git diff:*)",
"Bash(git log:*)",
"Bash(git merge:*)",  // For conflict resolution
```

**Pattern syntax**: `Bash(command-prefix:*)` - the `*` wildcard matches any arguments after the prefix.

**Allowed**: `git add`, `git commit`, `git status`, `git diff`, `git log`, `git merge`

**Blocked**: `git push`, `git fetch` (PM/system handle these), `git reset`, `git rebase`, and any other bash commands

### 4. PM Agent GitHub Tools

**Tool definitions**: [src/mcp/tools.ts](../src/mcp/tools.ts)
**Callback wiring**: [src/system/task-runtime.ts](../src/system/task-runtime.ts)

PM agent gets MCP tools for all GitHub remote operations. Following existing pattern, tools are defined in `tools.ts` with callback injection.

#### New PM GitHub Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `push_branch` | Push commits to origin | `repo_key` |
| `create_pull_request` | Create PR, registers in metadata | `repo_key`, `title`, `body` |
| `update_pr_description` | Edit PR body | `repo_key`, `pr_number`, `body` |
| `add_pr_comment` | General comment on PR | `repo_key`, `pr_number`, `comment` |
| `add_review_comment` | Comment on specific line | `repo_key`, `pr_number`, `path`, `line`, `comment` |
| `get_pr_reviews` | Fetch all reviews/comments | `repo_key`, `pr_number` |
| `resolve_review_thread` | Mark thread resolved | `repo_key`, `pr_number`, `thread_id` |
| `request_re_review` | Request re-review | `repo_key`, `pr_number` |
| `get_pr_status` | Check state/mergeable | `repo_key`, `pr_number` |

#### Separate Callback Interfaces

Split the existing `ToolCallbacks` into separate interfaces for cleaner separation:

**File**: [src/mcp/tools.ts](../src/mcp/tools.ts)

```typescript
// Base callbacks shared by all agents
export interface BaseToolCallbacks {
  onSendMessage: (target: AgentName, message: string) => Promise<string>;
  onLogFinding: (entry: string, type: FindingType) => Promise<void>;
}

// Repo agent callbacks (extends base)
export interface RepoAgentToolCallbacks extends BaseToolCallbacks {
  // Currently no additional callbacks, but ready for future extension
}

// PM agent callbacks (extends base, adds Slack + GitHub)
export interface PMToolCallbacks extends BaseToolCallbacks {
  // Existing Slack callbacks
  onPostToSlack: (message: string) => Promise<void>;
  onReportCompletion: () => Promise<void>;
  onAssignTaskOwner: (agent: AgentName) => Promise<void>;
  onRequestEditMode: (reason: string) => Promise<void>;

  // New GitHub callbacks
  onPushBranch: (repoKey: string) => Promise<{ success: boolean; message: string }>;
  onCreatePullRequest: (repoKey: string, title: string, body: string) => Promise<{ pr_number: number; pr_url: string }>;
  onGetPRStatus: (repoKey: string, prNumber: number) => Promise<PRStatus>;
  onGetPRReviews: (repoKey: string, prNumber: number) => Promise<PRReview[]>;
  onUpdatePRDescription: (repoKey: string, prNumber: number, body: string) => Promise<void>;
  onAddPRComment: (repoKey: string, prNumber: number, comment: string) => Promise<void>;
  onAddReviewComment: (repoKey: string, prNumber: number, path: string, line: number, comment: string) => Promise<void>;
  onResolveReviewThread: (repoKey: string, prNumber: number, threadId: string) => Promise<void>;
  onRequestReReview: (repoKey: string, prNumber: number) => Promise<void>;
}
```

**Implementation**: Follow existing tool pattern (see `request_edit_mode` in MVP-v2). Each tool calls its callback and returns formatted result.

### 5. System-Level Fetch on Repo Agent Spawn

**Files**:
- [src/system/worktree-manager.ts](../src/system/worktree-manager.ts)
- [src/agents/repo-agent.ts](../src/agents/repo-agent.ts)

**Current behavior:**
- `setupWorktree()` already fetches when **creating** a new worktree
- `spawnRepoAgent()` does NOT fetch when **reusing** an existing worktree

**Change needed:** Add `git fetch origin` when reusing existing worktree in `spawnRepoAgent()`.

**Flow:**
```
PM spawns repo agent
    → Edit mode? Check for existing worktree
    → New worktree: setupWorktree() (includes fetch)
    → Existing worktree: fetch origin, then reuse
    → Repo agent starts with up-to-date origin/*
```

This ensures `origin/main` is always fresh for `git merge origin/main` conflict resolution.

### 6. GitHub Webhook Handler & Event Flow

**New file**: `src/github/events.ts` (mirrors `src/slack/events.ts`)
**Modified file**: [src/system/server.ts](../src/system/server.ts)

GitHub webhooks follow the same pattern as Slack: events go through Triage agent for classification and task lookup, then route based on action.

**Why Triage?**
1. Task might not be active in memory (completed/stopped days ago). Triage can search historical tasks in `sessions/*/shared/metadata.json` using its tools (Glob, Grep, Read).
2. Single source of truth for event classification - Triage decides what action to take, not hardcoded logic.

**GitHub App Events to Subscribe:**

| Event | Trigger | Expected Triage Action |
|-------|---------|------------------------|
| `pull_request_review` | Approval | `merge_check` |
| `pull_request_review` | Changes requested | `existing_task` |
| `issue_comment` | Comment on PR | `existing_task` |
| `push` | Commits pushed | `merge_check` |
| `check_run` | CI completed successfully | `merge_check` |

**Endpoint**: `POST /github/webhooks`

**Flow (mirrors Slack):**

```
GitHub webhook
    → server.ts (verify signature via @octokit/webhooks)
    → github/events.ts:handleGitHubWebhook()
    → Build context from webhook payload
    → triageGitHubEvent() - classifies event, finds task, returns action
    → Route based on action:
        - existing_task → append to knowledge.log, notifyNewUserInput()
        - merge_check → mergeOrchestrator.checkAndMergeLinkedPRs()
        - noop → log and ignore (task not found or irrelevant event)
```

**Key components:**

- `handleGitHubWebhook()`: Main handler that builds context from webhook, calls triage, reactivates task if needed, and routes to appropriate handler
- `formatGitHubContext()`: Extracts relevant info from webhook payload (event type, action, repo, PR number, branch, user, body) for Triage to analyze

### 7. Triage Agent Extension for GitHub Events

**Files**:
- [src/types/task.ts](../src/types/task.ts) - Add `merge_check` to TriageResult action
- [src/agents/triage.ts](../src/agents/triage.ts) - Add `triageGitHubEvent()` function
- [prompts/triage-agent.md](../prompts/triage-agent.md) - Add GitHub event handling section

**Changes:**

1. Add `merge_check` to TriageResult action enum
2. Add `triageGitHubEvent(input)` function - similar to `triageMessage()` but for GitHub webhook context
3. Input includes raw webhook context: `eventType`, `action`, `githubRepo`, `prNumber`, `branch`, `user`, `body`

**Constrained output schema:**

GitHub triage uses a **restricted schema** that only allows valid GitHub actions:

```typescript
// GitHubTriageResult - subset of TriageResult
action: 'existing_task' | 'merge_check' | 'status_request' | 'noop'  // No new_task, cancel_task
```

This is enforced via a separate Zod schema in `triageGitHubEvent()` with `outputFormat` set to this restricted schema. Triage cannot create new tasks or cancel tasks from GitHub events.

**Triage behavior for GitHub events:**

Triage classifies the event and finds the task:

1. **Find task**: Search `sessions/*/shared/metadata.json` for matching `pr_number` in `githubRepo`, or extract task ID from branch format `feature/task-{taskId}`
2. **Classify action**:
   - PR approved, push, CI success → `merge_check` (system handles automatically)
   - Changes requested, PR comment → `existing_task` (PM needs to react)
   - Task not found or irrelevant event → `noop`
3. Return action + task_id

### 8. Task Manager Extensions

**File**: [src/system/task-manager.ts](../src/system/task-manager.ts)

Add `appendGitHubEvent(taskId, message)` helper function for appending GitHub events to knowledge.log with source `github`.

### 9. Automatic Merge Orchestration (System-Level)

**New file**: `src/github/merge-orchestrator.ts`

Merge is handled automatically by the system, not by PM agent.

**Key concept:** Use `mergeableState` to differentiate conflicts from CI/policy blocks:

| `mergeableState` | Meaning | Action |
|------------------|---------|--------|
| `dirty` | Merge conflicts | Notify PM to resolve |
| `blocked` / `unstable` | CI or policy | Wait silently (retry on next webhook) |
| `clean` | Ready to merge | Proceed with merge |

**Main function: `checkAndMergeLinkedPRs(task)`**

Called from webhook handlers on: approval, push, CI success.

**Logic:**
1. Get all linked PRs from task metadata (`repositories[*].pr_number`)
2. Fetch status of all PRs in parallel
3. If any have `mergeableState === 'dirty'` → collect all conflicted PRs, send **single** message to PM listing all
4. If all are approved + clean → merge all, then notify PM to tell user
5. Otherwise → wait silently (will retry on next webhook)

**Important:** Always batch notifications - never send multiple messages for the same check cycle.

### 10. Conflict Resolution Workflow

When a PR has conflicts with the base branch:

1. PM detects via `get_pr_status` (returns `mergeable: false`)
2. PM instructs repo agent: "There are merge conflicts. Please run `git merge origin/main` and resolve the conflicts."
3. System has already fetched `origin/main` (on task resume)
4. Repo agent runs `git merge origin/main`
5. Git adds conflict markers to files:
   ```
   <<<<<<< HEAD
   const timeout = 5000;
   =======
   const timeout = 10000;
   >>>>>>> origin/main
   ```
6. Repo agent reads conflicted files, resolves conflicts (edits to remove markers)
7. Repo agent runs `git add .` then `git commit`
8. Repo agent tells PM: "Conflicts resolved, ready to push"
9. PM runs `push_branch`

### 11. GitHub App Client

**New file**: `src/github/client.ts`

Wraps `@octokit/app` for GitHub API operations.

**Key types:**

```typescript
export type MergeableState = "clean" | "dirty" | "blocked" | "behind" | "unstable" | "unknown";

export interface PRStatus {
  state: "open" | "merged" | "closed";
  mergeable: boolean;
  mergeableState: MergeableState;  // Key field for conflict detection
  approved: boolean;
}

export interface PRReview {
  id: string;
  user: string;
  state: "approved" | "changes_requested" | "commented";
  body: string;
  comments: Array<{ path: string; line: number; body: string; threadId: string }>;
}
```

**Class: `GitHubClient`**

Constructor takes `appId`, `privateKey`, `installationId`. Uses `app.getInstallationOctokit()` for authenticated requests.

**Methods** (implement using Octokit REST/GraphQL APIs):
- `createPullRequest()`, `mergePullRequest()`, `getPRStatus()`, `getPRReviews()`
- `updatePRDescription()`, `addPRComment()`, `addReviewComment()`
- `resolveReviewThread()` (requires GraphQL), `requestReReview()`
- `pushBranch()`, `verifyWebhookSignature()`

---

## GitHub App Setup

### 1. Create GitHub App

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Fill in:

   - **Name**: `AI Engineer` (or your preferred name)
   - **Homepage URL**: Your server URL
   - **Webhook URL**: `https://your-server.com/github/webhooks`
   - **Webhook secret**: Generate a secure secret

3. **Permissions** (Repository):

   - `Contents`: Read and write (for pushing commits)
   - `Pull requests`: Read and write (for creating/managing PRs)
   - `Metadata`: Read-only (required)

4. **Subscribe to events**:

   - `Pull request review` (approval, changes requested)
   - `Issue comment` (general PR comments)
   - `Push` (for conflict resolution and commit pushes)
   - `Check run` (for CI completion)

5. Click "Create GitHub App"

### 2. Generate Private Key

1. In your GitHub App settings, scroll to "Private keys"
2. Click "Generate a private key"
3. Save the `.pem` file securely

### 3. Install App on Repositories

1. Go to your GitHub App → Install App
2. Select your organization/account
3. Choose "Only select repositories" → select backend and mobile repos
4. Install

### 4. Get Installation ID

After installation, the URL will be:
`https://github.com/settings/installations/INSTALLATION_ID`

Note the `INSTALLATION_ID` number.

### 5. Environment Variables

Add to `.env`:

```bash
# GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_INSTALLATION_ID=12345678
```

### 6. Local Development with ngrok

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Expose both Slack and GitHub webhooks
ngrok http 3000

# Update webhook URLs:
# - Slack: https://xxx.ngrok.io/slack/events
# - GitHub: https://xxx.ngrok.io/github/webhooks
```

---

## Flow Examples

### Example 1: Single-Repo PR

1. User: "Fix the login timeout bug"
2. PM assigns to backend agent
3. Backend agent investigates → Edit mode approved
4. Backend agent makes changes
5. Backend agent: `git add .` → `git commit -m "Fix login timeout"`
6. Backend agent tells PM: "Changes committed, ready for PR"
7. PM: `push_branch("backend")` → `create_pull_request("backend", "Fix login timeout", "...")`
8. PM posts to Slack: "I've created a PR with the fix: backend#123"
9. Reviewer approves
10. System auto-merges → notifies PM
11. PM posts to Slack: "The fix has been merged! backend#123"

### Example 2: Multi-Repo PR

1. User: "Fix iOS login timeout - needs backend and mobile changes"
2. PM coordinates both agents
3. Backend agent: makes changes → commits → tells PM "ready"
4. Mobile agent: makes changes → commits → tells PM "ready"
5. PM: pushes both, creates PRs for both repos
6. PM posts to Slack: "I've created PRs for both repos: backend#123, mobile#456"
7. System links PRs in descriptions
8. Reviewer approves backend#123 → System waits (mobile not ready)
9. Reviewer approves mobile#456 → System merges both
10. PM posts to Slack: "All changes have been merged!"

### Example 3: PR with Conflicts

1. PR created, but main branch has moved
2. PM checks `get_pr_status` → `mergeable: false`
3. PM tells repo agent: "PR has conflicts with main. Please merge origin/main and resolve."
4. System fetches origin (already done on task resume)
5. Repo agent: `git merge origin/main` → sees conflict markers
6. Repo agent resolves conflicts in files
7. Repo agent: `git add .` → `git commit -m "Resolve merge conflicts"`
8. Repo agent tells PM: "Conflicts resolved"
9. PM: `push_branch` → PR is now mergeable

### Example 4: Review Feedback

1. PR created, reviewer requests changes
2. GitHub webhook → Triage → PM
3. PM: `get_pr_reviews` to see feedback details
4. PM tells repo agent: "Reviewer asked to add error handling for null case in auth.ts:45"
5. Repo agent makes fix → `git add` → `git commit`
6. Repo agent tells PM: "Fixed, ready to push"
7. PM: `push_branch` → `resolve_review_thread` → `request_re_review`
8. PM posts to Slack: "I've addressed the review feedback"

---

## File Changes Summary

**New files:**

- `src/github/client.ts` - GitHub App client (~250 lines)
- `src/github/events.ts` - GitHub webhook event handler, mirrors `slack/events.ts` (~100 lines)
- `src/github/merge-orchestrator.ts` - Auto-merge logic with conflict detection (~100 lines)

**Modified files:**

- [src/types/task.ts](../src/types/task.ts) - Add `pr_number` to `RepositoryInfo`, add `merge_check` to TriageResult action
- [src/types/repo-agent.ts](../src/types/repo-agent.ts) - Add `githubRepo` to `RepoAgentConfig`
- [src/agents/repo-configs.ts](../src/agents/repo-configs.ts) - Add `githubRepo` values, add `getRepoConfigByGithubRepo()`
- [src/agents/repo-agent.ts](../src/agents/repo-agent.ts) - Add local git Bash patterns to edit mode, add fetch on worktree reuse
- [src/agents/triage.ts](../src/agents/triage.ts) - Add `triageGitHubEvent()` function for GitHub webhook handling
- [src/agents/pm.ts](../src/agents/pm.ts) - Add GitHub MCP tools
- [src/mcp/tools.ts](../src/mcp/tools.ts) - Split `ToolCallbacks` into `BaseToolCallbacks`, `RepoAgentToolCallbacks`, `PMToolCallbacks`; add PM GitHub tools
- [src/system/server.ts](../src/system/server.ts) - Add GitHub webhook endpoint
- [src/system/task-manager.ts](../src/system/task-manager.ts) - Add `appendGitHubEvent()` function
- [src/system/task-runtime.ts](../src/system/task-runtime.ts) - Add PM tool callbacks for GitHub operations
- [prompts/triage-agent.md](../prompts/triage-agent.md) - Add GitHub event handling section
- [prompts/pm-agent.md](../prompts/pm-agent.md) - Add GitHub workflow guidance
- [prompts/repo-agent.md](../prompts/repo-agent.md) - Add local git workflow section

---

## Testing Checklist

**Repo Agent (local git):**

- [ ] `git add`, `git commit`, `git status`, `git diff`, `git log` work in edit mode
- [ ] `git merge origin/main` works for conflict resolution
- [ ] `git push`, `git fetch` and other remote commands are blocked
- [ ] Non-git bash commands are blocked

**PM Agent (GitHub tools):**

- [ ] `push_branch` pushes to origin correctly
- [ ] `create_pull_request` creates PR via GitHub API
- [ ] `update_pr_description` updates PR body
- [ ] `add_pr_comment` adds comment to PR
- [ ] `add_review_comment` adds inline comment
- [ ] `get_pr_reviews` fetches review details
- [ ] `resolve_review_thread` marks thread resolved
- [ ] `request_re_review` requests new review
- [ ] `get_pr_status` returns correct state/mergeable/mergeableState

**Triage (GitHub events):**

- [ ] `triageGitHubEvent()` finds active task by PR number
- [ ] `triageGitHubEvent()` finds historical (inactive) task by searching metadata files
- [ ] `triageGitHubEvent()` extracts task ID from branch name format
- [ ] `triageGitHubEvent()` classifies PR approval as `merge_check`
- [ ] `triageGitHubEvent()` classifies push event as `merge_check`
- [ ] `triageGitHubEvent()` classifies CI success as `merge_check`
- [ ] `triageGitHubEvent()` classifies changes_requested as `existing_task`
- [ ] `triageGitHubEvent()` classifies PR comment as `existing_task`
- [ ] `triageGitHubEvent()` returns `noop` when task not found

**System-level (webhooks & merge):**

- [ ] Fetch happens when reusing existing worktree
- [ ] GitHub webhook signature verification works
- [ ] `pull_request_review` webhook routes through triage → merge check on approval
- [ ] `pull_request_review` webhook routes through triage → PM on changes_requested
- [ ] `issue_comment` webhook routes through triage → PM on PR comments
- [ ] `push` webhook routes through triage → merge check
- [ ] `check_run` webhook routes through triage → merge check on CI success
- [ ] GitHub events appended to knowledge.log with `[GitHub]` prefix
- [ ] Inactive tasks reactivated when GitHub event arrives
- [ ] Merge orchestrator detects conflicts (`mergeableState: 'dirty'`)
- [ ] Merge orchestrator notifies PM about conflicts
- [ ] Merge orchestrator waits for CI (`mergeableState: 'blocked'/'unstable'`)
- [ ] Auto-merge triggers when all PRs approved + clean
- [ ] Multi-repo PRs wait for all approvals
- [ ] PM notified after merge for Slack communication

**Integration:**

- [ ] Full flow: commit → push → PR → approval → CI → merge
- [ ] Conflict resolution flow: PR conflicts → PM notified → repo agent resolves → push → merge
- [ ] Review feedback flow: changes_requested → PM notified → repo agent fixes → push → re-review
- [ ] Cross-PR linking in descriptions

---

## Dependencies

**New npm packages:**

- `@octokit/app` - GitHub App authentication
- `@octokit/webhooks` - Webhook signature verification

```bash
npm install @octokit/app @octokit/webhooks
```

---

## Prompt Updates

### PM Agent Prompt Addition

Add to [prompts/pm-agent.md](../prompts/pm-agent.md):

**Section: GitHub Workflow**
- Creating PRs: After repo agent commits → `push_branch` → `create_pull_request` → notify user in Slack
- Managing reviews: `get_pr_reviews` → instruct repo agent → `push_branch` → `resolve_review_thread` → `request_re_review`
- Handling conflicts: If `mergeable: false` → tell repo agent to run `git merge origin/main`
- Merging: Do NOT merge PRs yourself - system handles auto-merge when all approved

### Repo Agent Prompt Addition

Add to [prompts/repo-agent.md](../prompts/repo-agent.md):

**Section: Git Workflow (Edit Mode Only)**
- Making changes: Atomic commits, `git add` specific files, clear commit messages, tell PM "ready for PR"
- Resolving conflicts: `git merge origin/main` → find conflict markers → resolve → `git add` → `git commit` → tell PM "ready to push"
- Remote name: The remote is always named `origin` - use this when referencing remote branches (e.g., `origin/main`)
- What NOT to do: No `git push`/`git fetch` (PM handles), no force push/rebase, no unrelated changes, no secrets

---

## Future Enhancements (Post-MVP 3)

- **MVP 4**: Cross-repo testing before merge
- **MVP 5**: CI status check integration, auto-fix test failures
- Draft PR support
- PR template support
- Commit message conventions enforcement
