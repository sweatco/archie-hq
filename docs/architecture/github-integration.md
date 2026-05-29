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

This is set once per base repository at server startup via `configureGitIdentity()` in `src/connectors/github/client.ts`. Shared clones inherit this configuration from the base repo.

## Webhook Handling

GitHub webhooks arrive at `POST /webhooks/github`, registered in `src/index.ts` via `mountGitHubWebhook()` from `src/connectors/github/events.ts`. The handler:

1. Validates required headers (`x-hub-signature-256`, `x-github-event`).
2. Verifies the webhook signature using HMAC-SHA256 (`src/connectors/github/webhooks.ts: verifyWebhookSignature()`). Uses `crypto.timingSafeEqual` to prevent timing attacks.
3. Responds with `200 OK` immediately (acknowledging receipt).
4. Processes the event asynchronously (fire-and-forget).

The webhook secret is read from `GITHUB_WEBHOOK_SECRET` (loaded into `AppConfig` in `src/index.ts`) -- if not provided, the GitHub webhook endpoint is not registered.

### Self-Event Filtering

Before routing, the system checks if the event was triggered by its own bot user. It constructs the expected bot username from `GITHUB_APP_SLUG` (e.g., `archie-hq[bot]`) and discards events where the sender matches. This prevents infinite loops when the system creates PRs, adds comments, or pushes branches.

## Webhook Router

The webhook router (`src/connectors/github/webhooks.ts`) uses purely deterministic routing -- every event type maps to one of: `merge_check`, `existing_task`, or `noop` (discard). There is no triage step.

### Task Identification

The router identifies which task an event belongs to by:

1. **Branch name extraction** -- For events with a `pull_request` object, extracts `head.ref`. For `push` events, extracts from `refs/heads/...`. For `workflow_run`, uses `head_branch`.
2. **Task ID extraction** -- Matches the branch name against the pattern `feature/task-{taskId}` via `extractTaskIdFromBranch()`.
3. **PR number fallback** -- For `issue_comment` events (which lack branch info), looks up the task by PR number using `findTaskByPRNumber()`.

If no task ID is found, the event is discarded as "Not our branch pattern."

### Deterministic Routing

All GitHub events follow deterministic paths based on event type and action. The `determineRouteAction()` function maps events to one of three internal actions (`merge_check`, `existing_task`, `noop`):

| Event Type | Action/State | Route |
|---|---|---|
| `pull_request_review` | `state=approved` | `merge_check` |
| `pull_request_review` | `state=changes_requested` | `existing_task` |
| `pull_request_review` | `state=commented` | `existing_task` |
| `pull_request_review_comment` | any | `existing_task` |
| `pull_request` | `opened` or `synchronize` | `merge_check` |
| `pull_request` | `closed` | `existing_task` |
| `push` | any | `merge_check` |
| `workflow_run` | `completed` + `failure` | `existing_task` |
| `workflow_run` | `completed` + success | `merge_check` |
| `issue_comment` | `created` | `existing_task` |

Route actions map to handler types:

- **`merge_check`** -- Handled directly by the merge orchestrator (see below). Debounced.
- **`existing_task`** -- Formatted as a structured event entry, appended to the task's knowledge log, and the PM agent is reactivated.

### `issue_comment` Handling

`issue_comment` events lack branch info, so the router resolves the task by PR number via `findTaskByPRNumber()`. Once routed as `existing_task`, `handleExistingTaskDirect()` deduplicates by `last_processed_comment_id` (tracked per-branch in `BranchState` with a legacy fallback on `RepositoryInfo`) before logging and waking the PM. There is no separate triage step -- every new comment reactivates the task.

### Event Message Formatting

`formatGitHubEvent()` in `src/connectors/github/webhooks.ts` converts an event context into a structured `{from, destination, message}` shape (matching Slack/CLI events) so the knowledge log renders uniformly. Examples:

- `from=alice, destination=PR #42, message=approved`
- `from=bob, destination=PR #42, message=requested changes: needs more tests`
- `from=ci, destination=branch:feature/task-abc123, message=workflow failure`
- `from=alice, destination=branch:feature/task-abc123, message=pushed`

These entries are written to the task's knowledge log so the PM agent can understand what happened.

## GitHub MCP Tools

GitHub and git tools are exposed to **repo agents** via the `repo-tools` MCP server, defined in `src/agents/tools.ts` (`createRepoToolsMcpServer`). Access is controlled at spawn time by the `allowedTools` list: read tools are always available, write tools are gated on `edit_allowed`.

### Available Tools (via `repo-tools` MCP server)

All tools below are registered on the same `repo-tools` MCP server. Whether a tool is reachable from a given agent is gated by the `allowedTools` list passed at spawn time (see `src/agents/spawn.ts`), which expands write tools only when `edit_allowed` is set on the agent.

**Always available (read-only and edit mode):**

| Tool | Description |
|---|---|
| `fetch` | Fetch latest refs from origin. |
| `switch_branch` | Switch to a different branch. Auto-stashes dirty work, auto-pops on return. |
| `list_branches` | List branches created or visited by this agent in the current task. |
| `list_prs` | List pull requests with optional filters (state, base, sort, limit). |
| `get_pr` | Get full PR details: title, description, diff, state, and branches. |
| `get_pr_status` | Get PR state, mergeable status, and approval status. Returns `state`, `mergeable`, `mergeableState`, `approved`. |
| `get_pr_reviews` | Review-level summary for a PR (approvals, change requests, review bodies). |
| `get_pr_comments` | Top-level PR conversation comments (issue comments). |
| `get_review_threads` | Every review thread on a PR via GraphQL: `thread_id` (for `resolve_review_thread`) and per-comment `comment_id` (for `reply_to_review_comment`). |
| `get_assignable_users` | List users who can be requested as reviewers on the repo (login + display name) via the GraphQL `assignableUsers` connection. Optional `query` filters by login/name; omit for the full list. Used to resolve a reviewer named in Slack to a GitHub login. |

**Edit mode only:**

| Tool | Description |
|---|---|
| `push_branch` | Push commits from the local shared clone to origin via `git push -u origin HEAD:{branch}`. |
| `create_pull_request` | Create a PR on GitHub. Stores the PR number in the current branch's `BranchState`. Optional `reviewers` (GitHub logins) are requested as a follow-up call after the PR is created. |
| `create_branch` | Create a new branch (auto-named `feature/{taskId}` or `feature/{taskId}-N`) and switch to it. |
| `update_pr` | Update the title, description, and/or base branch of an existing PR (all fields optional). |
| `add_pr_comment` | Add a general comment to a PR (issue comment). |
| `add_review_comment` | Start a NEW review thread on a specific file and line. |
| `reply_to_review_comment` | Reply inside an existing review thread, given any `comment_id` from that thread. |
| `resolve_review_thread` | Mark a review thread as resolved via the `resolveReviewThread` GraphQL mutation. Requires the GraphQL `thread_id` (e.g. `PRRT_...`). |
| `request_re_review` | Request re-review from all previous reviewers. Fetches existing reviewers and sends review requests. |
| `request_reviewers` | Request review from specific GitHub logins on an existing PR. Logins GitHub rejects (e.g. not a collaborator) are reported back, not thrown. |
| `merge_pull_request` | Merge a pull request. Checks mergeability first and returns status if not ready. |
| `close_pull_request` | Close a pull request without merging. |

Each repo agent's tools are scoped to its own repository (the `githubRepo` from the agent's config). PR numbers are stored per-branch in `BranchState.pr_number`.

## Merge Orchestrator

The merge orchestrator (`src/connectors/github/merge.ts`) is a system-level component (not part of any agent) that handles automatic PR merging.

### Trigger Points

The merge orchestrator is triggered by:

1. **Webhook events** -- Via `handleMergeCheckDirect()` on approving review, `pull_request opened/synchronize`, `push`, and successful `workflow_run`.
2. **Repo agent tool call** -- Repo agents can merge an individual PR directly via the `merge_pull_request` tool. That tool calls `GitHubClient.mergePullRequest()` and bypasses the cross-repo orchestrator (it operates on a single PR scoped to the agent's repo).

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
  -> connectors/github/events.ts: mountGitHubWebhook() handler
     -> verifyWebhookSignature() (HMAC-SHA256)
     -> ack 200, dispatch to handleGitHubWebhook()
  -> connectors/github/webhooks.ts: routeGitHubEvent()
    -> Discard own-bot events (sender === `${GITHUB_APP_SLUG}[bot]`)
    -> Extract branch -> extract task ID (or look up by PR number for issue_comment)
    -> Verify task exists via loadMetadata()
    -> determineRouteAction() -> 'merge_check' | 'existing_task' | 'noop'

  merge_check:
    -> webhooks.ts: handleMergeCheckDirect() [5s debounce per task]
    -> merge.ts: checkAndMergeLinkedPRs() -> triggerMergeCheck()
    -> If conflicts/merges: appendAgentFinding() + task.sendMessage(pm-agent)

  existing_task:
    -> events.ts: handleExistingTaskDirect()
    -> For issue_comment: dedup via last_processed_comment_id
    -> appendGitHubEvent() -> structured entry in knowledge.log
    -> task.sendMessage(pm-agent, AGENT_PROMPTS.existingTask)
```

## Agent Involvement for Blockers

The system is designed so that the PM agent is only reactivated for GitHub events that require human or agent attention:

- **Merge conflicts** (`mergeableState === 'dirty'`): PM is notified with a blocker finding to coordinate conflict resolution with repo agents.
- **CI failures** (`workflow_run` with `conclusion === 'failure'`): Routed as `existing_task`, PM is reactivated to assess and delegate investigation.
- **Review feedback** (`changes_requested`, review comments, PR conversation comments): Routed as `existing_task`, PM reads the feedback and coordinates changes with repo agents.
- **PR closed/merged externally** (`pull_request closed`): Routed as `existing_task` so the PM is informed.
- **Approvals and CI passes**: Trigger a debounced merge check via the orchestrator. PM is only notified if a merge actually happens or a conflict is detected.

## Relevant Source Files

- `src/connectors/github/client.ts` -- `GitHubClient` class wrapping `@octokit/app`, `configureGitIdentity()`, `fetchOrigin()`, `getGitHubClient()` singleton; PR ops (`listPRs`, `getPRDetails`, `getPRStatus`, `getPRReviews`, `getReviewThreads`, `getPRComments`, `createPullRequest`, `updatePR`, `addPRComment`, `addReviewComment`, `replyToReviewComment`, `resolveReviewThread` (GraphQL), `requestReReview`, `mergePullRequest`, `closePullRequest`)
- `src/connectors/github/events.ts` -- `mountGitHubWebhook()` Express handler, `handleGitHubWebhook()`, `handleExistingTaskDirect()` (with comment dedup)
- `src/connectors/github/webhooks.ts` -- HMAC-SHA256 signature verification, context extraction, deterministic routing (`routeGitHubEvent`, `determineRouteAction`), structured event formatting (`formatGitHubEvent`), merge check debouncing (`handleMergeCheckDirect`)
- `src/connectors/github/merge.ts` -- Auto-merge logic (`checkAndMergeLinkedPRs`, `triggerMergeCheck`), linked PR collection from `branch_states`, PM notification on conflicts/merges
- `src/connectors/github/repo-clone.ts` -- Shared-clone lifecycle (`setupSharedClone`, `removeClone`, `CloneCheckout`); each agent gets its own `git clone --shared` from the base repo
- `src/connectors/github/branch-state.ts` -- Per-branch state helpers (`hydrateBranchState`, `mirrorLegacyFields`, `findBranchStateByPR`)
- `src/agents/tools.ts` -- `createRepoToolsMcpServer` (`repo-tools` MCP: git workflow + PR tools), `createPMAgentMcpServer` (`pm-agent-tools` MCP)
- `src/types/task.ts` -- `RepositoryInfo` with `branch_states`, `BranchState` type with per-branch PR tracking
