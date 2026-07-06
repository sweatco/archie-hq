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
2. **Task ID extraction** -- Matches the branch name against the pattern `archie/task-{taskId}` via `extractTaskIdFromBranch()`. The legacy `feature/task-{taskId}` prefix is also accepted so pull requests opened before the branch-naming migration keep attributing to their task.
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
- `from=ci, destination=branch:archie/task-abc123, message=workflow failure`
- `from=alice, destination=branch:archie/task-abc123, message=pushed`

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
| `list_code_scanning_alerts` | List code scanning security alerts (e.g. CodeQL) from the repo's Security tab. Filter by state (default open), git ref/branch, or severity. Requires the App's "Code scanning alerts" read permission. |
| `get_code_scanning_alert` | Full detail for one code scanning alert by number: rule description, severity, state, dismissal info, and the most recent instance (file, line range, ref, message). |

**Edit mode only:**

| Tool | Description |
|---|---|
| `push_branch` | Push commits from the local shared clone to origin via `git push -u origin HEAD:{branch}`. |
| `create_pull_request` | Create a PR on GitHub. Stores the PR number in the current branch's `BranchState`. |
| `create_branch` | Create a new branch (auto-named `archie/{taskId}` or `archie/{taskId}-N`) and switch to it. |
| `update_pr` | Update the title, description, and/or base branch of an existing PR (all fields optional). |
| `add_pr_comment` | Add a general comment to a PR (issue comment). |
| `add_review_comment` | Start a NEW review thread on a specific file and line. |
| `reply_to_review_comment` | Reply inside an existing review thread, given any `comment_id` from that thread. |
| `resolve_review_thread` | Mark a review thread as resolved via the `resolveReviewThread` GraphQL mutation. Requires the GraphQL `thread_id` (e.g. `PRRT_...`). |
| `request_re_review` | Request re-review from all previous reviewers. Fetches existing reviewers and sends review requests. |
| `merge_pull_request` | Merge a pull request, subject to the repo's merge policy: on an auto-merge repo it merges directly after the mergeability check; on any other repo it posts a merge-approval request to the user and pauses the task. Returns the current status if the PR is not ready. |
| `close_pull_request` | Close a pull request without merging. |

Each repo agent's tools are scoped to its own repository (the `githubRepo` from the agent's config). PR numbers are stored per-branch in `BranchState.pr_number`.

## Merge Orchestrator

The merge orchestrator (`src/connectors/github/merge.ts`) is a system-level component (not part of any agent) that handles policy-gated automatic PR merging.

### Trigger Points

The merge orchestrator is triggered by:

1. **Webhook events** -- Via `handleMergeCheckDirect()` on approving review, `pull_request opened/synchronize`, `push`, and successful `workflow_run`.
2. **Repo agent tool call** -- Repo agents can merge an individual PR via the `merge_pull_request` tool, which bypasses the cross-repo orchestrator (it operates on a single PR scoped to the agent's repo) but enforces the same merge policy: in an auto-merge repo it calls `GitHubClient.mergePullRequest()` directly after the mergeability check; in any other repo it posts a merge-approval request instead of merging (see [Merge Policy](#merge-policy-automerge)).

### Merge Policy (`autoMerge`)

Whether a repo may be merged automatically is a per-repo boolean, `autoMerge`, declared in repo-agent frontmatter on each repo entry (`metadata.archie.repos[].autoMerge`; the legacy singular `metadata.archie.repo.autoMerge` is picked up by the same auto-migration as the rest of the singular shape). The flag defaults to **off** and parses strictly: only the boolean literal `true` enables it — absent, `false`, or any non-boolean value (e.g. the string `"true"`) resolves to `false`. The value is threaded through both explicit copy points (`PluginRepoEntry` in `src/system/plugin-loader.ts`, `RepoEntry` in `src/agents/registry.ts`); dynamic (PM-spawned) agents always resolve to `false`.

Policy is resolved at merge time by `isAutoMergeRepo(github)` (`src/agents/registry.ts`) with **AND semantics across declaring agents**: a repo is auto-mergeable only when at least one registered agent declares it and every declaring agent's entries for it set `autoMerge: true`. A repo declared by no registered agent (e.g. attached only via a dynamic agent) never auto-merges. Mixed flags resolve to off and log a warning. The lookup consults the live registry, not task-time snapshots, so a frontmatter change takes effect on the next merge check after a registry rescan.

Both merge paths — the orchestrator and the tool — share one GitHub-mergeability predicate, `isMergeReadyPerGithub()` (`src/connectors/github/mergeability.ts`): `mergeableState === 'clean'`, or `mergeable === true` with `mergeableState === 'blocked'` (the GitHub Rulesets quirk, see below).

**Non-auto repos: hold, notify once, merge on request.** A ready PR (open, approved, mergeable per GitHub) in a non-auto repo is never merged by the orchestrator. It lands in the `ready` bucket of `MergeCheckResult` (logged as `READY (merge on request)`), and `checkAndMergeLinkedPRs()` prompts the PM — via a decision finding plus reactivation — to tell the thread once that the PR is ready and will be merged on request. Once-ness is enforced by a persisted `BranchState.merge_ready_notified` marker: set on every matching branch state when the notification fires, cleared whenever a merge check observes the PR no longer ready (not ready while open, or closed without merging). The semantics are one notification per *continuous ready period* — webhook bursts and restarts never re-notify, while a PR that becomes un-ready and later ready again notifies again. A ready PR whose merge approval is currently pending (`task.metadata.pending_merge_approval` matches its `github` + `pr_number`) is skipped — the user already holds an actionable prompt for it.

**Explicit-request path.** When the user asks to merge, the repo agent calls `merge_pull_request`. In a non-auto repo the tool does not merge: if the PR is open and mergeable per GitHub (no review-approval requirement — GitHub branch protection is the sole authority on this path), it posts an interactive approval prompt (approval type `merge`, action ids `approve_merge`/`deny_merge`), persists the request as `task.metadata.pending_merge_approval` (`github`, `pr_number`, requesting agent, timestamp), suspends the task status, and defers a task pause. A repeat call while any agent process in the task still holds the parked pause reports the request as already pending; a pending request left unresolved after the task quiesced and was reactivated is superseded by a later call (slot rewritten, fresh prompt). Resolution converges from every surface — Slack buttons and `POST /api/tasks/:id/approve` with `type: "merge"` (which requires `github` + `pr_number` in the body) — on `Task.handleMergeApproval()` / `Task.handleMergeDenial()`, which verify the resolved PR's identity against the pending request atomically with clearing it (a synchronous read-compare-clear), so a stale, repeated, or mismatched resolution is a no-op. On a matching approval the engine re-checks the PR with GitHub and merges it when open and mergeable, appending a completion finding on success or a decision finding with the exact reason on failure; on denial no GitHub call is made at all. Either way the PM is reactivated so the user learns the outcome. The debug MCP surfaces the gate (`wait_for_task` → `APPROVAL_TYPE=merge`) and resolves it via its `approve` tool with the pending PR's `github`/`pr_number`.

**Auto repos** (`autoMerge: true`) keep the pre-policy behavior byte-for-byte: the orchestrator squash-merges on approval + green, and `merge_pull_request` merges directly with no prompt.

### Debouncing

Webhook-triggered merge checks are debounced per task with a 5-second delay (`MERGE_CHECK_DEBOUNCE_MS = 5000` in `src/connectors/github/webhooks.ts`). This prevents redundant API calls when multiple webhooks arrive in bursts (e.g., push + CI start + CI complete in rapid succession). Each new trigger cancels the previous pending timer.

### Merge Logic

`triggerMergeCheck()` collects all PRs linked to a task (from `branch_states` across all attached repos) and categorizes them:

| Category | Criteria | Action |
|---|---|---|
| Already merged | `state === 'merged'` | Record in results |
| Mergeable (auto repo) | `state === 'open'` AND `approved` AND `isMergeReadyPerGithub()` AND `isAutoMergeRepo()` | Attempt merge (squash by default) |
| Ready (non-auto repo) | Same GitHub state, but the repo's policy is not auto-merge | Hold; notify the PM once per continuous ready period |
| Conflicted | `mergeableState === 'dirty'` | Record as conflict |
| Pending | Everything else that's open | Record as pending with reasons |

The `blocked` + `mergeable=true` case handles a known GitHub Rulesets issue where the API reports `blocked` even when the merge button is green in the UI. The merge API call itself will fail gracefully if the PR is actually blocked.

### Linked PR Checking

A single task can have PRs across multiple repositories and multiple branches. `task.metadata.repositories` maps each agent ID to its list of `AttachedRepo` records, and the orchestrator walks every attachment's `branch_states`, deduplicating by `(github, prNumber)` since two agents can attach the same repo:

```typescript
// From src/connectors/github/merge.ts
const linkedPRSet = new Set<string>();
const linkedPRs: Array<{ github: string; prNumber: number }> = [];
for (const attachments of Object.values(task.metadata.repositories)) {
  if (!Array.isArray(attachments)) continue;
  for (const attached of attachments) {
    if (!attached.branch_states) continue;
    for (const state of Object.values(attached.branch_states)) {
      if (!state.pr_number) continue;
      const key = `${attached.github}#${state.pr_number}`;
      if (linkedPRSet.has(key)) continue;
      linkedPRSet.add(key);
      linkedPRs.push({ github: attached.github, prNumber: state.pr_number });
    }
  }
}
```

PR numbers are stored when a repo agent calls `create_pull_request` and are referenced in log entries using the `org/repo#123` format.

### PM Notification

After a merge check, the orchestrator notifies the PM agent only for noteworthy outcomes:

- **Conflicts**: Logs a blocker finding and reactivates PM to inform the user and coordinate resolution.
- **Successful merges**: Logs a completion finding and reactivates PM to announce the merge.
- **Newly ready PRs (non-auto repos)**: Logs a decision finding instructing the PM to tell the thread the PR is ready and will be merged on request, then reactivates PM. Fires once per continuous ready period (deduped by the `merge_ready_notified` marker) and skips PRs with a pending merge approval.
- **Pending PRs**: No notification. The system waits silently for the next webhook trigger (approval, CI pass, etc.).

## PR Cards

A **PR card** is a compact, self-updating summary of a pull request (PR number + head branch, repo, state, and CI progress) rendered in the originating Slack thread and the CLI. It is driven by a channel-agnostic `pr_card` event on the event bus — one event, rendered by every surface (see [Slack Integration → PR Cards](slack-integration.md) for the Slack/CLI rendering).

- **Data**: `GitHubClient.getPRCardData(repo, prNumber)` does a lean PR fetch (head branch, state, head sha) plus a CI summary over `listPRChecks()` (`summarizeCi` in `src/system/pr-card-format.ts` → verdict + `passed`/`total` counts: any failure-class → `failed`; else any pending → `pending`; else `passed`). The snapshot shape is `PrCardData` (`src/types/task.ts`).
- **Posting**: nothing is posted while the PM works. `Task.resurfacePrCards()` posts/reposts a card for any PR whose `prCardFingerprint` changed since its last card, emitting a `pr_card` `post` event and (on Slack) deleting the old card and reposting at the bottom. It runs **eagerly from `report_completion`** (instant, under the final message) and again from `complete()`/`stop()` (idempotent). The card ref + fingerprint live in `BranchState.pr_card`.
- **In-place updates**: `events.ts: maybeRefreshPrCards()` runs on `check_run`/`check_suite`/`workflow_run` `completed` and `pull_request closed`, independent of the merge/checks routing (CI successes route to noop otherwise). It resolves the owning task by **head branch** — `archie/{taskId}` pattern → `findTaskByBranch` (a branch_states scan, so semantically-named branches and PR-number-less `workflow_run` events still resolve) → PR number — then calls `Task.refreshPrCardInPlace()` / `refreshAllPrCards()`, which emit a `pr_card` `update` event and edit the card in place (no resurface). CI refreshes are **debounced per repo+branch** (~2.5s) to coalesce the burst of per-job webhooks into one fetch; PR close is immediate. No-ops until a card has been posted; logs a one-line `no task resolved` when a CI/close event can't be matched. The fingerprint is built from state, head branch, head sha, and the CI verdict+counts — **not** PR title/description — so each completing check refreshes the card while title/description edits never move it.

  > For progressive `(1/2 → 2/2)` counts and the most reliable updates, the GitHub App should subscribe to **Check runs**, **Check suites**, and **Workflow runs**. Even without `check_run`, the final verdict updates when the suite/run completes.

## GitHub Event Flow Into Task Sessions

When a GitHub event arrives for an existing task:

```
GitHub webhook
  -> connectors/github/events.ts: mountGitHubWebhook() handler
     -> verifyWebhookSignature() (HMAC-SHA256)
     -> ack 200, dispatch to handleGitHubWebhook()
     -> maybeRefreshPrCards(): on CI-completed / PR-closed, update PR cards in place
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
- **Approvals and CI passes**: Trigger a debounced merge check via the orchestrator. PM is only notified if a merge actually happens, a conflict is detected, or a held PR in a non-auto repo just became ready.

## Relevant Source Files

- `src/connectors/github/client.ts` -- `GitHubClient` class wrapping `@octokit/app`, `configureGitIdentity()`, `fetchOrigin()`, `getGitHubClient()` singleton; PR ops (`listPRs`, `getPRDetails`, `getPRStatus`, `getPRCardData`, `getPRReviews`, `getReviewThreads`, `getPRComments`, `createPullRequest`, `updatePR`, `addPRComment`, `addReviewComment`, `replyToReviewComment`, `resolveReviewThread` (GraphQL), `requestReReview`, `mergePullRequest`, `closePullRequest`)
- `src/connectors/github/events.ts` -- `mountGitHubWebhook()` Express handler, `handleGitHubWebhook()`, `maybeRefreshPrCards()` (in-place PR-card updates), `handleExistingTaskDirect()` (with comment dedup)
- `src/system/pr-card-format.ts` -- pure PR-card formatting shared by Slack + CLI: `summarizeCi`, `prCardFingerprint`, `prCardSubtitle`, `prCardTitlePlain`, `SLACK_PR_CARD_EMOJI`/`CLI_PR_CARD_EMOJI`
- `src/connectors/github/webhooks.ts` -- HMAC-SHA256 signature verification, context extraction, deterministic routing (`routeGitHubEvent`, `determineRouteAction`), structured event formatting (`formatGitHubEvent`), merge check debouncing (`handleMergeCheckDirect`)
- `src/connectors/github/merge.ts` -- Policy-gated auto-merge logic (`checkAndMergeLinkedPRs`, `triggerMergeCheck`), linked PR collection from `branch_states`, PM notification on conflicts/merges/ready PRs, `merge_ready_notified` bookkeeping
- `src/connectors/github/mergeability.ts` -- `isMergeReadyPerGithub()`, the GitHub-mergeability predicate shared by the orchestrator and `merge_pull_request`
- `src/agents/registry.ts` -- `isAutoMergeRepo()` policy lookup (AND semantics across declaring agents)
- `src/tasks/task.ts` -- `handleMergeApproval()` / `handleMergeDenial()` merge-approval resolution, `pending_merge_approval` slot
- `src/connectors/slack/events.ts` -- `approve_merge` / `deny_merge` Bolt action handlers; `src/connectors/api/routes.ts` -- the equivalent `type: "merge"` approval route
- `src/connectors/github/repo-clone.ts` -- Shared-clone lifecycle (`setupSharedClone`, `removeClone`, `CloneCheckout`); each agent gets its own `git clone --shared` from the base repo
- `src/connectors/github/branch-state.ts` -- Per-branch state helpers (`hydrateBranchState`, `mirrorLegacyFields`, `findBranchStateByPR`)
- `src/agents/tools.ts` -- `createRepoToolsMcpServer` (`repo-tools` MCP: git workflow + PR tools), `createPMAgentMcpServer` (`pm-agent-tools` MCP)
- `src/types/task.ts` -- `RepositoryInfo` with `branch_states`, `BranchState` type with per-branch PR tracking
