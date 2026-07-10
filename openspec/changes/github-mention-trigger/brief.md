# Forge brief — `github-mention-trigger`

**Source**: issue [#200](https://github.com/sweatco/archie-hq/issues/200) · **Repo**: sweatco/archie-hq · **Risk class**: engine · **Signed off**: 2026-07-11 by Igor

## Problem

The only entry point for new work is Slack. The GitHub webhook router is purely deterministic: it attributes events to existing tasks via the `archie/task-{taskId}` branch pattern or a PR-number lookup, and discards everything else ("Not our branch pattern", `webhooks.ts:469`). Mentioning the bot anywhere outside an Archie-managed PR does nothing.

## Goals

1. A mention of `@{GITHUB_APP_SLUG}` in an issue/PR comment, or in a newly opened issue's body, creates a new task and hands it to the PM agent, seeded with full context.
2. The GitHub thread is that task's conversation surface: Archie acknowledges in-place and the PM's user-facing messages land as comments there.
3. Only users with repo write/maintain/admin permission can summon Archie (checked via the installation Octokit).
4. Subsequent comments on the same issue/PR route to the existing task (issue→task mapping, deduplicated).
5. Mentions in repos not covered by any plugin get a polite decline comment.

## Non-goals (v1)

- **No edit mode for GitHub-born tasks** — readonly always; approval flow (GitHub or Slack) deferred entirely.
- **No Slack presence** — no cross-post, no Slack thread for GitHub-born tasks.
- No `pull_request_review_comment` (inline diff comment) mention handling.
- No short alias (`@archie`), no dedicated machine user — app slug only.
- No behavior change for mentions that resolve to existing tasks — current `existing_task` routing stays as-is (the "stronger signal" idea from the issue is out).

## Constraints

- Mention detection runs **after** the self-event filter (`{slug}[bot]` discard, `webhooks.ts:449`) — loop safety.
- Existing `merge_check` / `existing_task` / `checks_ready` routing must be untouched.
- Permission checks use the existing installation Octokit singleton; no new auth infrastructure.
- PM messages on a GitHub-born task must not be silently dropped (today `default_channel: null` → "message dropped", `task.ts:489-491`); the CLI-channel precedent (`task.ts:496`) shows the intended channel-type extension point.
- `request_edit_mode` on a GitHub-born task must fail fast with an explanation (today it would silently no-op via the null Slack channel and hang the flow).
- Repo conventions: unified logger, vitest, no hard-wrapped prose in docs.

## Affected area / blast radius

`archie-hq` only: `src/connectors/github/` (webhook router, event dispatch, client helpers — reaction helper and issue-comment support are new), task creation path (`Task.create` + metadata for GitHub origin), `postToUser` channel surface (`task.ts`). GitHub App webhook subscription gains the `issues` event (App settings — outside the codebase).

## Acceptance criteria

- **AC1** (`unit`) — WHEN an `issue_comment.created` webhook arrives whose body mentions `@{GITHUB_APP_SLUG}` and no existing task resolves (branch pattern, PR lookup, issue mapping) THEN the router returns a new `new_task` action carrying repo, issue/PR number, comment id, and author. WHEN the body contains no mention THEN the event is discarded exactly as today.
- **AC2** (`integration`) — WHEN a `new_task` event's author has write/maintain/admin on the repo THEN a task is created; `knowledge.log` is seeded with repo, issue/PR number, title, body, the mentioning comment text, author, and a link back; the PM receives the new-task prompt; task metadata records the GitHub origin (repo + issue number → taskId).
- **AC3** (`unit`) — WHEN the author's permission is read/none THEN no task is created, the event is discarded with a logged reason, and no reply is posted.
- **AC4** (`integration`) — WHEN an `issues.opened` webhook arrives with the mention in the issue body THEN behavior matches AC2 (the `issues` event is newly routed; today it falls to noop).
- **AC5** (`integration`) — WHEN a task is created from a mention THEN Archie acknowledges in-thread: 👀 reaction on the triggering comment (or the issue for `issues.opened`) plus a short comment naming the task.
- **AC6** (`integration`) — WHEN the PM posts to the user on a GitHub-born task THEN the message lands as a comment on the originating issue/PR thread — never the "no default channel — message dropped" path.
- **AC7** (`integration`) — WHEN a subsequent non-bot comment lands on the same issue/PR THEN it routes to the existing task via the issue→task mapping, deduplicated by comment id, and the PM is pinged with the existing-task prompt.
- **AC8** (`unit`) — WHEN the comment author is `{GITHUB_APP_SLUG}[bot]` — including Archie's own acknowledgments — THEN nothing is routed and no task is created (loop safety).
- **AC9** (`unit`) — WHEN an authorized mention arrives in a repo no plugin declares THEN a polite decline comment is posted and no task is created.
- **AC10** (`unit`) — WHEN an agent calls `request_edit_mode` on a GitHub-born task THEN the request is declined immediately with a message stating GitHub-born tasks are readonly in v1; `edit_allowed` is never set; no silent hang.
- **AC11** (`unit`) — Regression: comments on Archie-managed PR branches still route `existing_task` exactly as today; `merge_check` / `checks_ready` paths byte-for-byte unaffected.
- **AC12** (`live-e2e`) — Against a running dockerized instance: POST a correctly signed `issue_comment` webhook mentioning the slug for a plugin-covered test repo THEN a task appears via the archie-debug MCP with the seeded knowledge log, and the acknowledgment is visible on the real GitHub issue.
- **AC13** (`deploy-only`) — The production GitHub App subscribes to `issues` (and keeps `issue_comment`). Post-merge step: update webhook subscriptions in the GitHub App settings, then verify one real mention creates a task.

## QA limitations (accepted at sign-off)

- **AC12** needs dev GitHub App credentials and a reachable test repo inside the E2E harness. If absent, it degrades to `manual` (locally booted instance, real comment posted by hand) or an explicit waiver with AC13's post-merge verification named as the fallback.
- **AC13** is `deploy-only` by nature: a GitHub App settings console change, verifiable only after merge/deploy.
- AC5/AC6 integration tests mock the GitHub API; real-thread behavior is only proven by AC12/AC13.

## Design decisions locked at inception

- **Handle**: app slug `@{GITHUB_APP_SLUG}` only — instance-specific, dev and prod apps on the same repo don't both fire.
- **Authorization**: repo write/maintain/admin via installation Octokit. Unauthorized mentions are silently discarded (no probing surface); polite decline comments are reserved for authorized users in uncovered repos.
- **Approval**: GitHub-born tasks are readonly always in v1.
- **Reporting**: GitHub thread only — no Slack cross-post.
