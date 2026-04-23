# Eliminate GitHub PR comment triage

## Context

The GitHub webhook → agent flow has two defects the user noticed: PR comments and merge status aren't reliably reaching the agent or `shared-knowledge.log`.

Root causes:

1. **PR merge/close events are dropped at the router.** [webhooks.ts:260](src/connectors/github/webhooks.ts#L260) returns `'noop'` for `pull_request` / `action === 'closed'`, so merged/closed PRs never reach the existing-task handler.
2. **PR comments are gated by an LLM classifier.** `issue_comment` events are routed to `processGitHubTriage` which calls `triageGitHubComment` (Haiku). Any comment the classifier deems "conversational" ("Thanks", "LGTM", etc.) is silently dropped — not logged, not sent to the agent.

Decision: remove GitHub triage entirely. Every relevant PR event for a known task routes directly to the existing-task handler, which appends to the knowledge log and pings the agent. Slack triage stays untouched. Preserve `last_processed_comment_id` bookkeeping (user wants it for future PR-tracking work) and make it actually load-bearing with a dedup guard.

## Critical files

- [src/connectors/github/webhooks.ts](src/connectors/github/webhooks.ts) — routing + context formatting
- [src/connectors/github/events.ts](src/connectors/github/events.ts) — webhook dispatch + handlers
- [src/system/triage.ts](src/system/triage.ts) — remove GitHub-specific triage code
- [src/agents/prompts.ts](src/agents/prompts.ts) — stale doc comment
- [prompts/triage-agent.md](prompts/triage-agent.md) — drop the "or GitHub PR comments" phrase

## Implementation

All code changes land in one commit (types change across files; intermediate states don't typecheck). Docs under `docs/architecture/` are a follow-up.

### 1. Route changes — [webhooks.ts](src/connectors/github/webhooks.ts)

In `determineRouteAction` ([L242-L277](src/connectors/github/webhooks.ts#L242-L277)):

- `issue_comment` + `action === 'created'` → `'existing_task'` (was `'triage_comment'`)
- `pull_request` + `action === 'closed'` → `'existing_task'` (was `'noop'`)
- Other arms unchanged

Type/union cleanup:

- Drop `'triage'` variant from `GitHubRouteResult` ([L229-L232](src/connectors/github/webhooks.ts#L229-L232)). Final shape: `{ action: 'discard'; reason } | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId }`. `discard` stays: the dispatcher at [events.ts:93-95](src/connectors/github/events.ts#L93-L95) logs `route.reason` (own-bot events, unknown branch pattern, missing task, noop action) — useful for webhook debugging.
- Drop `'triage_comment'` from `InternalRouteAction` ([L237](src/connectors/github/webhooks.ts#L237)).
- Remove the `case 'triage_comment'` arm from the switch at [L330-L346](src/connectors/github/webhooks.ts#L330-L346).
- Update the docstring at [L288-L294](src/connectors/github/webhooks.ts#L288-L294) to drop the "If event needs triage" bullet.

### 1a. Align GitHub event shape with Slack/CLI — [persistence.ts](src/tasks/persistence.ts) and [webhooks.ts](src/connectors/github/webhooks.ts)

Slack and CLI both use a structured event shape — author goes into `from`, channel/context into `destination`, `message` is the clean body:

- Slack: `{ from: "Egor", to: "pm-agent", destination: "#bot-test", message: "hello" }` ([persistence.ts:204](src/tasks/persistence.ts#L204))
- CLI: `{ from: "cli", to: "pm-agent", message: "hello" }` ([persistence.ts:297](src/tasks/persistence.ts#L297))

Which the CLI renders as `[Egor in #bot-test] @pm-agent hello` via `formatMessageParts` ([TaskDetail.tsx:18-22](src/cli/components/TaskDetail.tsx#L18-L22)).

GitHub events currently jam the author into the message body (`"PR #42: alice commented: fix bug"`) and set `from: "github:backend"` — the structured shape loses author information, and the CLI can't render `[alice in PR #42]` cleanly.

**Change:**

1. `GitHubEventContext` already has `user`, `prNumber`, `body` — use them directly.

2. Replace `formatGitHubEventMessage(context): string` with `formatGitHubEvent(context): { from: string; destination: string; message: string }` at [webhooks.ts:154](src/connectors/github/webhooks.ts#L154). Examples:
   - `pull_request_review` approved: `{ from: alice, destination: "PR #42", message: "approved" }`
   - `pull_request_review` changes_requested: `{ from: alice, destination: "PR #42", message: "requested changes: <body>" }`
   - `pull_request_review` commented: `{ from: alice, destination: "PR #42", message: "commented: <body>" }` (or just `<body>` — see note)
   - `pull_request_review_comment`: `{ from: alice, destination: "PR #42", message: "commented on code: <body>" }`
   - `pull_request` closed/merged: `{ from: alice, destination: "PR #42", message: "merged" }` or `"closed"`
   - `issue_comment`: `{ from: alice, destination: "PR #42", message: <body> }`
   - `push`: `{ from: alice, destination: "branch:<name>", message: "pushed" }`
   - `workflow_run`: `{ from: "ci", destination: "branch:<name>", message: "workflow <conclusion>" }`

   Author comes from `context.user`; destination prefers `PR #N` for PR-scoped events and `branch:<name>` for push/CI. Message body is the pure comment/action, no `"user X by"` prefix.

3. Update `appendGitHubEvent` at [persistence.ts:268-281](src/tasks/persistence.ts#L268-L281) to accept the structured payload and emit it with repo context in `destination`:

   ```ts
   export async function appendGitHubEvent(
     taskId: string,
     repoKey: string,
     event: { from: string; destination: string; message: string }
   ): Promise<void>
   ```

   Inside: the knowledge-log line becomes `source: github:${repoKey}/${event.destination}`, `message: ${event.from}: ${event.message}` (or similar — mirrors the Slack log-entry shape at [L199-L201](src/tasks/persistence.ts#L199-L201) which puts the author in `source`). Emitted SSE shape: `{ from: event.from, to: 'pm-agent', destination: ${repoKey}/${event.destination}, message: event.message }` — now consumable by `formatMessageParts` unchanged.

4. Only caller of `appendGitHubEvent` is [events.ts](src/connectors/github/events.ts) (plus the soon-deleted processGitHubTriage backfill loop). Update that call site in the new `handleExistingTaskDirect`.

**Result in CLI:** PR comments render as `[alice in backend/PR #42] @pm-agent fix the bug` instead of the current `[github:backend] @pm-agent PR #42: alice commented: fix the bug`. Matches Slack's `[Egor in #bot-test] @pm-agent hello`.

**Knowledge-log format change:** the on-disk format of GitHub entries changes (`source` goes from `github:backend` to `github:backend/PR #42` and the author is separated from the message body). Historical entries stay readable — the format is still `[timestamp] [source] message`. No parser elsewhere consumes the exact GitHub line format (grepped — only `appendGitHubEvent` writes it).

### 2. Handler consolidation — [events.ts](src/connectors/github/events.ts)

Imports:

- Drop `triageGitHubComment, type GitHubComment` ([L28](src/connectors/github/events.ts#L28)).
- Drop `createGitHubClient` ([L20](src/connectors/github/events.ts#L20)) — only `processGitHubTriage` used it.
- Keep `findBranchStateByPR` — it moves into `handleExistingTaskDirect`.

Dispatch switch ([L95-L108](src/connectors/github/events.ts#L95-L108)): remove the `else if (route.action === 'triage')` branch. Final shape: `discard` logged and dropped → `direct` routes to `handleMergeCheckDirect` or `handleExistingTaskDirect`.

Delete:

- `processGitHubTriage` ([L131-L210](src/connectors/github/events.ts#L131-L210))
- `handleGitHubCommentDirect` ([L215-L230](src/connectors/github/events.ts#L215-L230))

Expand `handleExistingTaskDirect` ([L115-L126](src/connectors/github/events.ts#L115-L126)) to one function with an `issue_comment` branch that also updates bookkeeping. Shape:

1. Resolve `repoKey` via `getAgentDefByGithubRepo(context.githubRepo)`; fallback `'unknown'`.
2. Load `task = await Task.get(taskId)`.
3. If `context.eventType === 'issue_comment'` and both `context.prNumber` and `context.commentId` are set:
   - `repoInfo = task.metadata.repositories[repoKey]`
   - `branchMatch = repoInfo ? findBranchStateByPR(repoInfo, context.prNumber) : undefined`
   - `lastProcessedId = branchMatch?.state.last_processed_comment_id ?? repoInfo?.last_processed_comment_id ?? 0`
   - **Dedup guard:** `if (context.commentId <= lastProcessedId) return;` — makes bookkeeping load-bearing against webhook retries.
   - Update both locations:
     - `if (branchMatch) branchMatch.state.last_processed_comment_id = context.commentId;`
     - `if (repoInfo) repoInfo.last_processed_comment_id = context.commentId;`
   - `task.debouncedSave();`
4. `await appendGitHubEvent(taskId, repoKey, formatGitHubEvent(context));` — passes the structured `{ from, destination, message }` payload.
5. `await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');`

Explicit choice: drop the old `getPRComments` backfill loop. It existed to replay comments triage had dropped; with triage gone there is nothing to replay. Removes network I/O per comment and lets `createGitHubClient` drop out of this file.

### 3. Strip GitHub code — [triage.ts](src/system/triage.ts)

Delete the GitHub block ([L164-L240](src/system/triage.ts#L164-L240)):

- `GitHubComment` interface
- `GitHubCommentTriageResult` interface
- `GitHubCommentTriageSchema`
- `triageGitHubComment` function
- The `// GitHub PR Comment Triage` header comment block

Keep everything above L164 (Slack schema, `runTriage`, `buildTriageInput`, `triageSlackMessage`). Do not inline `runTriage` into Slack — out of scope.

### 4. Stale doc comment — [prompts.ts](src/agents/prompts.ts)

At [L4-L7](src/agents/prompts.ts#L4-L7), remove the `processGitHubTriage` reference. Replace `"event-handler (handleSlackEvent/processGitHubTriage)"` with `"event-handler (handleSlackEvent, GitHub webhook dispatch)"`.

### 5. Triage prompt — [prompts/triage-agent.md](prompts/triage-agent.md)

At [L3](prompts/triage-agent.md#L3), drop the "or GitHub PR comments" phrase. Rest of the file is Slack-only rules; safe because after step 3 this prompt is only loaded for Slack triage.

## Non-goals

- Slack triage: untouched (though currently commented out at [src/connectors/slack/events.ts:299-330](src/connectors/slack/events.ts#L299-L330), it stays intact per user directive).
- Unknown `pull_request_review` states ([webhooks.ts:250](src/connectors/github/webhooks.ts#L250)) still drop to noop — separate fix.
- `docs/architecture/github-integration.md`, `orchestration.md`, `agents.md` — will update in a separate follow-up commit.
- Historical plans under `docs/plans/` — not back-patched by convention.

## Reuse / existing utilities

- `findBranchStateByPR` ([src/tasks/persistence.ts](src/tasks/persistence.ts)) — already used by the old bookkeeping path.
- `appendGitHubEvent` ([src/tasks/persistence.ts:268](src/tasks/persistence.ts#L268)) — signature changes to accept `{ from, destination, message }`.
- `formatGitHubEventMessage` ([webhooks.ts:154](src/connectors/github/webhooks.ts#L154)) — renamed/rewritten to `formatGitHubEvent(context): { from, destination, message }`. All existing arms rewritten to the structured shape, plus new `issue_comment` arm.
- `formatMessageParts` ([TaskDetail.tsx:18](src/cli/components/TaskDetail.tsx#L18)) — unchanged; now consumes GitHub events correctly without special-casing.
- `Task.get` / `task.sendMessage` / `task.debouncedSave` — existing task API, unchanged.
- `AGENT_PROMPTS.existingTask` ([src/agents/prompts.ts](src/agents/prompts.ts)) — existing message.

## Verification

1. **Typecheck:** `npm run typecheck` — must pass. The dropped `'triage'` variant on `GitHubRouteResult` provides the compiler safety net: any missed call site fails the build.
2. **Unit tests:** `npm test` — no test files reference the removed symbols (`triageGitHubComment`, `GitHubComment`, `GitHubRouteResult`, `processGitHubTriage`, `handleGitHubCommentDirect`). `findBranchStateByPR` coverage in [src/agents/__tests__/pr-tools.test.ts:362-389](src/agents/__tests__/pr-tools.test.ts#L362-L389) unaffected.
3. **Manual end-to-end** against a test task with an active PR, watching the CLI task detail view and `shared-knowledge.log`:
   - Post a PR comment ("Thanks!") → CLI renders `[alice in backend/PR #N] @pm-agent Thanks!`; log has matching entry; PM agent wakes.
   - Post a substantive PR comment → same shape.
   - Merge the PR → CLI renders `[alice in backend/PR #N] @pm-agent merged`; log entry present (previously dropped at routing).
   - Close without merging → `[alice in backend/PR #N] @pm-agent closed`.
   - Approve the PR → `[alice in backend/PR #N] @pm-agent approved`.
   - Redeliver the same `issue_comment` webhook → confirm the comment logs only once (dedup guard).
4. **Observability:** tail the app log — confirm no more `"Running triage-agent for github-pr-*"` lines after the change.
