# GitHub Integration

Archie integrates with GitHub as a GitHub App using `@octokit/app` for API operations and HMAC-SHA256 signature verification for incoming webhooks. The integration covers PR lifecycle management, automated merging, review handling, and bidirectional event flow between GitHub and task sessions.

## GitHub App Authentication

The `GitHubClient` class in `src/connectors/github/client.ts` wraps `@octokit/app`. It authenticates using three environment variables:

- `GITHUB_APP_ID` -- The GitHub App's numeric ID
- `GITHUB_APP_PRIVATE_KEY_PATH` -- Path to the PEM private key file
- `GITHUB_INSTALLATION_ID` -- The installation ID for the target GitHub organization

The client lazily initializes an authenticated Octokit instance via `app.getInstallationOctokit(installationId)`. A factory function `createGitHubClient()` reads environment variables and returns `null` if not configured, allowing the system to run without GitHub integration.

For git operations (push, fetch), authentication is handled by the `GIT_ASKPASS` environment variable rather than the Octokit client.

### Bot Identity for Commits

The system configures git identity using the GitHub App's bot credentials:
- Name: `{appSlug}[bot]` (e.g., `archie-hq[bot]`)
- Email: `{appId}+{appSlug}[bot]@users.noreply.github.com`

This is set once per base repository at server startup via `configureGitIdentity()` in `src/connectors/github/client.ts`. Worktrees inherit this configuration from the base repo.

## Webhook Handling

GitHub webhooks arrive at `POST /webhooks/github`, registered in `src/index.ts` via `mountGitHubWebhook()` from `src/connectors/github/events.ts`. The handler:

1. Validates required headers (`x-hub-signature-256`, `x-github-event`).
2. Verifies the webhook signature using HMAC-SHA256 (`src/connectors/github/webhooks.ts: verifyWebhookSignature()`). Uses `crypto.timingSafeEqual` to prevent timing attacks.
3. Responds with `200 OK` immediately (acknowledging receipt).
4. Processes the event asynchronously (fire-and-forget).

The webhook secret is optional in `ServerConfig` -- if not provided, the GitHub webhook endpoint is not registered.

### Self-Event Filtering

Before routing, the system checks if the event was triggered by its own bot user. It constructs the expected bot username from `GITHUB_APP_SLUG` (e.g., `archie-hq[bot]`) and discards events where the sender matches. This prevents infinite loops when the system creates PRs, adds comments, or pushes branches.

## Webhook Router

The webhook router (`src/connectors/github/webhooks.ts`) uses a two-tier routing strategy: deterministic routing for structured events and triage-based routing for ambiguous ones.

### Task Identification

The router identifies which task an event belongs to by:

1. **Branch name extraction** -- For events with a `pull_request` object, extracts `head.ref`. For `push` events, extracts from `refs/heads/...`. For `workflow_run`, uses `head_branch`.
2. **Task ID extraction** -- Matches the branch name against the pattern `feature/task-{taskId}` via `extractTaskIdFromBranch()`.
3. **PR number fallback** -- For `issue_comment` events (which lack branch info), looks up the task by PR number using `findTaskByPRNumber()`.

If no task ID is found, the event is discarded as "Not our branch pattern."

### Deterministic Routing

Most GitHub events follow deterministic paths based on event type and action. The `determineRouteAction()` function maps events to one of four internal actions:

| Event Type | Action/State | Route |
|---|---|---|
| `pull_request_review` | `state=approved` | `merge_check` |
| `pull_request_review` | `state=changes_requested` | `existing_task` |
| `pull_request_review` | `state=commented` | `existing_task` |
| `pull_request_review_comment` | any | `existing_task` |
| `pull_request` | `opened` or `synchronize` | `merge_check` |
| `pull_request` | `closed` | discard (noop) |
| `push` | any | `merge_check` |
| `workflow_run` | `completed` + `failure` | `existing_task` |
| `workflow_run` | `completed` + success | `merge_check` |
| `issue_comment` | `created` | `triage_comment` |

Route actions map to handler types:

- **`merge_check`** -- Handled directly by the merge orchestrator (see below). Debounced.
- **`existing_task`** -- Formatted as a human-readable event message, appended to the task's knowledge log, and the PM agent is reactivated.
- **`triage_comment`** -- Goes through GitHub-specific triage.

### Triage-Based Routing (PR Comments)

PR comments (`issue_comment` events) are the only GitHub events that go through triage. This is because PR comment threads may contain conversational noise (e.g., "thanks!", "LGTM") that does not require agent action.

The GitHub triage flow (`src/connectors/github/events.ts: processGitHubTriage()`) fetches the full PR comment history via the GitHub API, then runs the triage agent to determine if the comment warrants reactivating the task. If classified as `existing_task`, new comments since the last processed ID are appended to the knowledge log and the PM is reactivated. Otherwise, the comment is silently ignored.

### Event Message Formatting

`formatGitHubEventMessage()` in `src/connectors/github/webhooks.ts` converts GitHub event context into human-readable log entries:

- `PR #42 approved by alice`
- `PR #42: bob requested changes: needs more tests`
- `CI workflow failure for feature/task-abc123`
- `Push to feature/task-abc123 by alice`

These messages are written to the task's knowledge log so the PM agent can understand what happened.

## GitHub MCP Tools

GitHub and git tools are exposed to **repo agents** via the `repo-tools` MCP server, defined in `src/agents/tools.ts` (`createRepoToolsMcpServer`). Access is controlled at spawn time by the `allowedTools` list: read tools are always available, write tools are gated on `edit_allowed`.

### Available Tools (via `repo-tools` MCP server)

**Always available (read-only and edit mode):**

| Tool | Description |
|---|---|
| `fetch` | Fetch latest refs from origin. |
| `switch_branch` | Switch to a different branch. Auto-stashes dirty work, auto-pops on return. |
| `list_prs` | List pull requests with optional filters (state, base, sort, limit). |
| `get_pr` | Get full PR details: title, description, diff, state, and branches. |
| `get_pr_status` | Get PR state, mergeable status, and approval status. Returns `state`, `mergeable`, `mergeableState`, `approved`. |
| `get_pr_reviews` | Fetch all reviews and inline comments on a PR. Groups comments by review and includes file paths and line numbers. |

**Edit mode only:**

| Tool | Description |
|---|---|
| `push_branch` | Push commits from the local worktree to origin. Uses `git push -u origin HEAD:{branch}` for owned branches. |
| `create_pull_request` | Create a PR on GitHub. Stores the PR number in the current branch's `BranchState`. |
| `update_pr` | Update the title and/or description of an existing PR (both fields optional). |
| `add_pr_comment` | Add a general comment to a PR (issue comment). |
| `add_review_comment` | Add a comment on a specific file and line in a PR diff. |
| `resolve_review_thread` | Mark a review comment thread as resolved (placeholder -- requires GraphQL in production). |
| `request_re_review` | Request re-review from all previous reviewers. Fetches existing reviewers and sends review requests. |
| `merge_pull_request` | Merge a pull request. Checks mergeability first and returns status if not ready. |
| `close_pull_request` | Close a pull request without merging. |
| `create_branch` | Create a new branch (auto-named from task ID) and switch to it. |
| `list_branches` | List branches created or visited by this agent in the current task. |

Each repo agent's tools are scoped to its own repository (the `githubRepo` from the agent's config). PR numbers are stored per-branch in `BranchState.pr_number`.

## Merge Orchestrator

The merge orchestrator (`src/connectors/github/merge.ts`) is a system-level component (not part of any agent) that handles automatic PR merging.

### Trigger Points

The merge orchestrator is triggered by:

1. **Webhook events** -- Via `handleMergeCheckDirect()` on PR approval, push, CI completion.
2. **Repo agent tool call** -- Repo agents can merge individual PRs via the `merge_pull_request` tool on the `repo-tools` MCP server. The merge orchestrator runs automatically for webhook-triggered checks.

### Debouncing

Webhook-triggered merge checks are debounced per task with a 5-second delay (`MERGE_CHECK_DEBOUNCE_MS = 5000` in `src/connectors/github/webhooks.ts`). This prevents redundant API calls when multiple webhooks arrive in bursts (e.g., push + CI start + CI complete in rapid succession). Each new trigger cancels the previous pending timer.

### Merge Logic

`triggerMergeCheck()` collects all PRs linked to a task (from `branch_states` across all repositories, with legacy fallback to `repoInfo.pr_number`) and categorizes them:

| Category | Criteria | Action |
|---|---|---|
| Already merged | `state === 'merged'` | Record in results |
| Mergeable | `state === 'open'` AND `approved` AND (`mergeableState === 'clean'` OR (`mergeable === true` AND `mergeableState === 'blocked'`)) | Attempt merge (squash by default) |
| Conflicted | `mergeableState === 'dirty'` | Record as conflict |
| Pending | Everything else that's open | Record as pending with reasons |

The `blocked` + `mergeable=true` case handles a known GitHub Rulesets issue where the API reports `blocked` even when the merge button is green in the UI. The merge API call itself will fail gracefully if the PR is actually blocked.

### Linked PR Checking

A single task can have PRs across multiple repositories and multiple branches. The orchestrator collects all PRs from `branch_states` across all repositories:

```typescript
// From src/connectors/github/merge.ts
for (const [repoKey, repoInfo] of Object.entries(task.metadata.repositories)) {
  if (repoInfo.branch_states) {
    for (const state of Object.values(repoInfo.branch_states)) {
      if (state.pr_number) {
        linkedPRs.push({ repoKey, prNumber: state.pr_number });
      }
    }
  } else if (repoInfo.pr_number) {
    // Legacy fallback for tasks created before branch_states
    linkedPRs.push({ repoKey, prNumber: repoInfo.pr_number });
  }
}
```

PR numbers are stored when a repo agent calls `create_pull_request` and are referenced in log entries using the `repo#123` format (e.g., `backend#42`).

### PM Notification

After a merge check, the orchestrator notifies the PM agent only for noteworthy outcomes:

- **Conflicts**: Logs a blocker finding and reactivates PM to inform the user and coordinate resolution.
- **Successful merges**: Logs a completion finding and reactivates PM to announce the merge.
- **Pending PRs**: No notification. The system waits silently for the next webhook trigger (approval, CI pass, etc.).

## GitHub Event Flow Into Task Sessions

When a GitHub event arrives for an existing task:

```
GitHub webhook
  -> connectors/github/events.ts: verifyWebhookSignature()
  -> connectors/github/webhooks.ts: routeGitHubEvent()
    -> Extract branch -> extract task ID -> verify task exists
    -> Determine route action (merge_check / existing_task / triage_comment)

  merge_check:
    -> webhooks.ts: handleMergeCheckDirect() [debounced]
    -> merge.ts: checkAndMergeLinkedPRs()
    -> If conflicts/merges: appendAgentFinding() + task.sendMessage(PM)

  existing_task:
    -> events.ts: handleExistingTaskDirect()
    -> Format event message, append to knowledge.log
    -> task.sendMessage(PM, "New input received...")

  triage_comment:
    -> events.ts: processGitHubTriage()
    -> Fetch PR comment history
    -> Run triage agent
    -> If actionable: append new comments, task.sendMessage(PM)
```

## Agent Involvement for Blockers

The system is designed so that the PM agent is only reactivated for GitHub events that require human or agent attention:

- **Merge conflicts** (`mergeableState === 'dirty'`): PM is notified with a blocker finding to coordinate conflict resolution with repo agents.
- **CI failures** (`workflow_run` with `conclusion === 'failure'`): Routed as `existing_task`, PM is reactivated to assess and delegate investigation.
- **Review feedback** (`changes_requested`, review comments): Routed as `existing_task`, PM reads the feedback and coordinates changes with repo agents.
- **Approvals and CI passes**: Handled silently by the merge orchestrator. PM is only notified if a merge actually happens.

## Relevant Source Files

- `src/connectors/github/client.ts` -- GitHubClient class, Octokit wrapper, git identity configuration, GIT_ASKPASS, `listPRs`, `getPRDetails`, `mergePullRequest`, `closePullRequest`
- `src/connectors/github/events.ts` -- GitHub webhook dispatch, triage processing (`processGitHubTriage`)
- `src/connectors/github/webhooks.ts` -- Signature verification, deterministic routing, context extraction, event formatting, merge check debouncing
- `src/connectors/github/merge.ts` -- Auto-merge logic, linked PR checking (reads from `branch_states`), PM notification
- `src/connectors/github/worktree.ts` -- Git worktree lifecycle (`setupWorktree`, `removeWorktree`, `WorktreeCheckout`)
- `src/connectors/github/branch-state.ts` -- Per-branch state helpers (`hydrateBranchState`, `mirrorLegacyFields`, `findBranchStateByPR`)
- `src/agents/tools.ts` -- `repo-tools` MCP server (git workflow + PR tools for repo agents), `pm-agent-tools` MCP server
- `src/types/task.ts` -- `RepositoryInfo` with `branch_states`, `BranchState` type with per-branch PR tracking
