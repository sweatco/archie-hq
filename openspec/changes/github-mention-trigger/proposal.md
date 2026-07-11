## Why

The only entry point for new work is Slack: the GitHub webhook router is purely deterministic, attributing events to existing tasks via the `archie/task-{taskId}` branch pattern or a PR-number lookup and discarding everything else as "Not our branch pattern" (`webhooks.ts:470`). Mentioning the bot anywhere outside an Archie-managed PR does nothing (issue #200). Teams that live in GitHub issues cannot summon Archie where the context already is.

## What Changes

- **New webhook route action `new_task`**: when an `issue_comment.created` body (or a newly opened issue's body via the newly routed `issues.opened` event) mentions `@{GITHUB_APP_SLUG}` with word-boundary matching and no existing task resolves (branch pattern → PR lookup → issue→task mapping), the router emits a `new_task` action instead of discarding. Detection runs strictly after the existing self-event filter (loop safety) and is inert when `GITHUB_APP_SLUG` is unset.
- **Permission gate**: only authors whose repo permission resolves to `admin` or `write` (GitHub's legacy permission field, so maintain→write per the API contract) can summon Archie, checked via a new `getCollaboratorPermission` helper on the existing installation Octokit singleton. Unauthorized mentions are silently discarded (no probing surface).
- **Repo coverage gate**: authorized mentions in repos no plugin declares get a polite decline comment and no task, with a short in-memory per-thread window so repeated mentions can't spam declines.
- **Task creation with a GitHub conversation surface**: the mention handler creates a task, links a redefined `GitHubChannel` (issue-shaped; the current PR-shaped type is never constructed anywhere) as the default channel — the channel entry is the task's GitHub-origin record, persisted synchronously so the readonly marker can't be lost to a crash — seeds `knowledge.log` with issue title/body, the mentioning comment, author, and a link back, then hands the PM the standard new-task prompt.
- **In-thread acknowledgment**: 👀 reaction on the triggering comment (or the issue for `issues.opened`) plus a short comment naming the task — via two new `GitHubClient` reaction helpers; comment posting reuses `addPRComment` (already the issues endpoint).
- **PM replies land on the thread**: `postToUser` gains a `github` branch posting comments to the originating issue/PR (failures warn and continue) — closing today's "no default channel — message dropped" path for GitHub-born tasks.
- **Follow-up comments route to the task, permission-gated**: a new `findTaskByIssueChannel` mapping (same metadata-scan pattern as `findTaskByPRNumber`, wired for `issue_comment` and `issues` events, slug-gated like detection) routes follow-ups to the task; follow-up authors are re-checked against the same `admin|write` permission gate — `read`/`none` authors are silently ignored so untrusted text on public threads never reaches the PM — with comment-id dedup stored on the GitHub channel entry (plain-issue threads have no branch state to dedup against today).
- **Readonly v1 enforced by construction**: `request_edit_mode` and `request_max_mode` fail fast with an explanation on GitHub-born tasks (no silent pause), and `handleEditModeApproval` refuses to flip `edit_allowed` for them — closing the unauthenticated `POST /tasks/:id/approve` hole.
- **Not changed**: `merge_check` / `checks_ready` / existing `existing_task` routing for Archie-managed PRs stays byte-for-byte as today; no Slack presence for GitHub-born tasks; no `pull_request_review_comment` handling; no short alias.

## Capabilities

### New Capabilities
- `github-mention`: mention-triggered task creation from GitHub issue/PR threads — detection, authorization (creation and follow-ups), coverage decline, context seeding, in-thread acknowledgment and PM delivery, follow-up routing with dedup, loop safety, and readonly-v1 enforcement.

### Modified Capabilities
- None. `pr-merge-policy`, `debug-mcp-task-waiting`, `archie-e2e-harness`, and `memory-layer` requirements are untouched (the new e2e recipe is an additive SKILL.md entry that changes no harness requirement).

## Impact

- **Code (archie-hq only)**: `src/connectors/github/webhooks.ts` (context extraction for `issues` + issue numbers, mention detection, `new_task` route variant, slug-gated issue-mapping consult), `src/connectors/github/events.ts` (dispatch case + mention handler + follow-up author gate), `src/connectors/github/client.ts` (permission + reaction helpers), `src/tasks/persistence.ts` (`findTaskByIssueChannel`), `src/tasks/task.ts` (`linkGitHubChannel`, `isGitHubBorn`, `postToUser` github branch, edit-approval origin guard), `src/types/task.ts` (`GitHubChannel` reshape), `src/agents/tools.ts` (readonly guards), `src/agents/spawn.ts` + `src/memory/lifecycle.ts` (GitHub-channel rendering; the `pr_number` cast at `lifecycle.ts:378-379` is removed), `src/connectors/api/routes.ts` (edit-approval rejection response), `src/index.ts` (boot warning when the slug is unset).
- **Docs & prompts**: `docs/architecture/github-integration.md` (mention trigger section; also refreshes the stale router table that predates `checks_ready`/`status`), `prompts/pm-agent.md` (GitHub-born task guidance), `.env.example` (`GITHUB_APP_SLUG` is now load-bearing), `docs/proposals/github-mention-workflow.md` marked superseded, `.claude/skills/archie-e2e/SKILL.md` (new `github-mention` recipe).
- **External (AC13, post-merge)**: the production GitHub App must subscribe to the `issues` webhook event (keeping `issue_comment`) and hold Issues: read & write permission (reactions and plain-issue comments require Issues: write) — a GitHub App settings console change outside the codebase.
- **Behavior**: net-additive. Events that today discard as "Not our branch pattern" can now create tasks when they carry an authorized mention; every existing routing decision is preserved. No data migration (the reshaped `GitHubChannel` has zero on-disk instances since it was never constructed).
- **Dependencies**: none new. Uses the existing installation Octokit; no new auth infrastructure.
