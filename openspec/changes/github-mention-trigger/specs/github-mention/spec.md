## ADDED Requirements

### Requirement: Mentions in GitHub threads route to a new-task action

The webhook router SHALL detect a mention of `@{GITHUB_APP_SLUG}` — matched case-insensitively with word boundaries (leading start-or-whitespace, trailing whitespace/punctuation/end) — in the body of an `issue_comment.created` event or a newly opened issue's body (`issues.opened`), and SHALL return a `new_task` route action carrying the repo, issue/PR number, comment id (when comment-born), and author. Detection SHALL read bodies only (a mention appearing only in an issue title does not trigger) and SHALL apply only to `created`/`opened` actions — mentions edited into existing comments or issue bodies (`issue_comment.edited`, `issues.edited`) never trigger. Detection SHALL run only after the self-event filter and only when no existing task resolves via branch pattern, PR-number lookup, or the issue→task mapping. Events without a mention SHALL be discarded exactly as today. Mentions that resolve to an existing task SHALL keep today's `existing_task` routing unchanged.

#### Scenario: Comment mention with no resolving task creates a new-task route (AC1)
- **GIVEN** no task resolves for the thread via branch pattern, PR lookup, or issue mapping
- **WHEN** an `issue_comment.created` webhook arrives whose body mentions `@{GITHUB_APP_SLUG}`
- **THEN** the router returns a `new_task` action carrying repo, issue/PR number, comment id, and author

#### Scenario: Comment without a mention is discarded as today (AC1)
- **WHEN** an `issue_comment.created` webhook arrives with no mention and no resolving task
- **THEN** the event is discarded with the same reason as before this change

#### Scenario: Word-boundary matching rejects prefix collisions
- **WHEN** a comment body contains `@{GITHUB_APP_SLUG}-other` or the slug embedded inside a word
- **THEN** no mention is detected; `@{GITHUB_APP_SLUG}` followed by punctuation or end-of-line is detected, case-insensitively — including inside a fenced code block (the matcher is markdown-unaware, accepted claude-code-action parity)

#### Scenario: Title-only mention does not trigger
- **WHEN** an `issues.opened` event carries the mention only in the issue title, not the body
- **THEN** no mention is detected and the event is discarded

#### Scenario: Edited-in mention does not trigger
- **WHEN** an `issue_comment.edited` (or `issues.edited`) event arrives whose body now contains the mention
- **THEN** the event is not routed to `new_task` (edited actions are never mention-eligible)

#### Scenario: Newly opened issue with a mention routes to new_task (AC4)
- **WHEN** an `issues.opened` webhook arrives with the mention in the issue body
- **THEN** the router returns a `new_task` action for that issue (the `issues` event is newly routed; it previously fell through to discard)

#### Scenario: Mention on an Archie-managed PR keeps existing routing
- **WHEN** a mentioning comment arrives on a PR whose branch matches the `archie/task-{taskId}` pattern
- **THEN** the event routes `existing_task` to that task exactly as today, with no new-task creation

### Requirement: Loop safety — own-bot and bot-authored events never create tasks

Events authored by `{GITHUB_APP_SLUG}[bot]` — including Archie's own acknowledgment and PM comments — SHALL be discarded by the self-event filter before mention detection runs. Mention detection SHALL additionally skip authors whose login ends in `[bot]`. Archie-authored acknowledgment, decline, and PM comment text SHALL never contain the mention string. When `GITHUB_APP_SLUG` is unset, the entire GitHub-born surface SHALL be inert together: mention detection never matches AND the issue→task mapping is never consulted, so GitHub-born tasks stop routing follow-ups — preventing the unbounded self-wake loop that would otherwise exist with the self-event filter disabled. A boot warning SHALL state that the self-event filter, mention trigger, and GitHub-born task routing are disabled.

#### Scenario: Own bot comment is discarded (AC8)
- **WHEN** an `issue_comment.created` arrives authored by `{GITHUB_APP_SLUG}[bot]`, including one whose body contains the mention string
- **THEN** nothing is routed and no task is created

#### Scenario: Other bots cannot summon Archie
- **WHEN** a mentioning comment arrives from an author whose login ends in `[bot]` that is not our bot
- **THEN** no new-task route is produced

#### Scenario: Unset slug disables the whole GitHub-born surface
- **GIVEN** `GITHUB_APP_SLUG` is not configured
- **WHEN** a mentioning comment arrives, or a follow-up comment lands on a thread previously mapped to a GitHub-born task
- **THEN** no mention is detected, the issue→task mapping is not consulted, nothing routes to the GitHub-born task, and a warning was logged at boot

### Requirement: Only repo writers can summon Archie

A `new_task` mention SHALL create a task only when the author's repository permission — resolved via the installation Octokit's collaborator-permission endpoint, whose legacy `permission` field maps maintain→write and triage→read — is `admin` or `write`. Authors resolving to `read` or `none` SHALL be discarded with a logged reason, creating no task and posting no reply. A permission-lookup failure or an unconfigured GitHub client SHALL be treated as unauthorized (fail closed).

#### Scenario: Unauthorized mention is silently discarded (AC3)
- **WHEN** a mention's author has `read` or `none` permission on the repo
- **THEN** no task is created, the event is discarded with a logged reason, and no reply or reaction is posted

#### Scenario: Permission lookup failure fails closed
- **WHEN** the collaborator-permission call throws or the GitHub client is not configured
- **THEN** the mention is discarded with a logged reason and nothing is posted

### Requirement: Mentions in uncovered repos get a polite decline

When an authorized mention arrives in a repo that no registered plugin agent declares, the system SHALL post a polite decline comment on the thread and create no task. The decline SHALL be posted only for authorized authors (the permission gate runs first) and SHALL NOT contain the mention string. Repeated authorized mentions on the same thread within a short window SHALL NOT re-post the decline (in-memory per-thread dedup), so an uncovered-repo thread cannot be spammed with decline comments.

#### Scenario: Authorized mention in an undeclared repo declines (AC9)
- **GIVEN** an author with `write` permission on a repo no plugin declares
- **WHEN** their mention arrives
- **THEN** a polite decline comment is posted on the thread and no task is created

#### Scenario: Repeated mentions do not spam declines
- **WHEN** a second authorized mention arrives on the same uncovered-repo thread within the dedup window
- **THEN** no additional decline comment is posted

#### Scenario: Unauthorized mention in an undeclared repo stays silent
- **WHEN** a mention from a `read`/`none` author arrives in an undeclared repo
- **THEN** nothing is posted (authorization is checked before coverage)

### Requirement: A task is created from the mention, seeded with full context

For an authorized mention in a covered repo, the system SHALL create a task and link a GitHub channel (repo + issue number + PR flag) promoted to the task's default channel — the channel entry is the task's GitHub-origin record, making the issue resolvable to the task and marking the task GitHub-born, and it SHALL be persisted to disk synchronously at creation (not on a debounced save) so a crash cannot produce a GitHub-born task the read-only guards do not recognize. The system SHALL seed `knowledge.log` with the repo, issue/PR number, issue title and body, the mentioning comment text (comment-born, tagged with its comment id), the author, and a link back to the thread; adopt the issue title as the task title when none exists; and hand the PM the standard new-task prompt. A failure after the permission gate (task creation, linking, or seeding throws) SHALL be logged and produce no acknowledgment — the webhook is fire-and-forget and re-mentioning is the remedy.

#### Scenario: Authorized comment mention creates a seeded task (AC2)
- **GIVEN** an author with `write` or `admin` permission on a plugin-covered repo
- **WHEN** their mentioning comment arrives and no task resolves
- **THEN** a task is created, `knowledge.log` carries repo, issue/PR number, title, body, the mentioning comment text, author, and a link back, the linked GitHub channel entry records the origin (present in the on-disk metadata immediately), and the PM receives the new-task prompt

#### Scenario: Issue-body mention behaves the same (AC4)
- **WHEN** an `issues.opened` event with the mention in the body passes the gates
- **THEN** the task is created and seeded as above, with the issue body as the mentioning text

#### Scenario: Redelivered triggering comment does not double-seed
- **WHEN** the webhook for the triggering comment is redelivered after the task exists
- **THEN** it routes to the existing task and is deduplicated by its comment id (the seed set the watermark)

#### Scenario: Redelivered issues.opened does not duplicate the task
- **WHEN** the `issues.opened` webhook that created a task is redelivered
- **THEN** the issue resolves to the existing task via the mapping and the event is discarded — no second task, no second acknowledgment

#### Scenario: Creation failure after authorization is logged, not acked
- **WHEN** task creation or seeding throws after the permission gate passed
- **THEN** the error is logged and no acknowledgment is posted on the thread

### Requirement: Archie acknowledges the mention in-thread

On task creation from a mention, the system SHALL add an 👀 (`eyes`) reaction to the triggering comment — or to the issue itself for `issues.opened` — and post a short comment naming the created task. Acknowledgment failures SHALL be logged and SHALL NOT abort task creation.

#### Scenario: Comment-born acknowledgment (AC5)
- **WHEN** a task is created from a comment mention
- **THEN** an `eyes` reaction is added to the triggering comment and a short comment naming the task id is posted on the thread

#### Scenario: Issue-born acknowledgment (AC5)
- **WHEN** a task is created from an `issues.opened` mention
- **THEN** the `eyes` reaction lands on the issue and the naming comment is posted

### Requirement: The GitHub thread is the task's conversation surface

`postToUser` SHALL deliver messages for a task whose default channel is a GitHub channel as comments on the originating issue/PR thread, with the standard task footer, logging the outgoing message with a `github:{repo}#{number}` destination. The GitHub delivery path SHALL never fall through to the "no default channel — message dropped" warning nor silently return. A failed comment post (locked/closed/transferred issue, rate limit) SHALL log a warning and continue — it SHALL NOT propagate an exception into the calling agent's tool call. An unconfigured GitHub client SHALL produce a logged warning, not a silent drop. File uploads to GitHub channels SHALL warn that files are dropped rather than failing silently.

#### Scenario: PM reply lands on the thread (AC6)
- **WHEN** the PM posts to the user on a GitHub-born task
- **THEN** the message is posted as a comment on the originating issue/PR and the "message dropped" path is never taken

#### Scenario: Explicitly targeted GitHub channel also delivers
- **WHEN** `postToUser` is called with a `target.channel` naming a linked GitHub channel
- **THEN** the message posts to that thread instead of silently returning

#### Scenario: Failed comment post does not crash the caller
- **WHEN** the GitHub comment API rejects the post (e.g. locked issue, rate limit)
- **THEN** a warning is logged and no exception escapes `postToUser`

### Requirement: Follow-up comments route to the existing task — authorized authors only, deduplicated

Subsequent non-bot comments on a mapped issue/PR SHALL resolve to the existing task via the issue→task mapping (in-memory active tasks first, then a metadata scan verified structurally against the GitHub channel entry). Before any delivery, the comment author SHALL be re-checked against the same repository-permission gate as the summoning mention: authors resolving to `read` or `none` — or whose lookup fails (fail closed) — SHALL be silently ignored with a logged reason: no knowledge-log append, no PM wake, no reply, and no watermark advance, so untrusted text on public threads never reaches the PM. Authors whose login ends in `[bot]` SHALL be dropped before any permission lookup (no API call). Permission results SHALL be cached in memory per repo and author for a short TTL — including `read`/`none` results — so repeated comments cannot burn the shared installation API budget; lookup failures are not cached. Authorized comments SHALL be deduplicated by comment id against the GitHub channel's watermark (alongside any branch-state watermarks) and SHALL append the comment to `knowledge.log` and ping the PM with the existing-task prompt. Follow-ups need no mention. The permission re-check SHALL apply whenever the resolved task has a GitHub channel matching the thread — comments on Archie-managed PR branches (whose tasks have no matching GitHub channel) keep today's ungated path unchanged.

#### Scenario: Authorized follow-up comment reaches the task (AC7)
- **WHEN** a comment by an author with `write`/`admin` permission lands on an issue mapped to a task
- **THEN** it routes to that task via the issue→task mapping, the comment body is appended to `knowledge.log`, and the PM is pinged with the existing-task prompt

#### Scenario: Unauthorized follow-up is silently ignored (AC7)
- **WHEN** a comment by a `read`/`none` author lands on a mapped issue
- **THEN** nothing is appended, the PM is not woken, no reply is posted, the watermark does not advance, and the drop is logged

#### Scenario: Follow-up permission lookup failure fails closed
- **WHEN** the permission lookup for a follow-up author throws
- **THEN** the comment is ignored exactly as an unauthorized one

#### Scenario: Bot follow-up authors cost no API call
- **WHEN** a follow-up comment arrives from an author whose login ends in `[bot]` (not our bot — that is discarded upstream)
- **THEN** it is dropped without any permission lookup being performed

#### Scenario: Repeated follow-ups reuse the cached permission
- **WHEN** the same author posts multiple follow-up comments on a mapped thread within the cache TTL
- **THEN** at most one permission lookup is performed for that author and the cached result gates the rest

#### Scenario: Redelivered comment id is skipped (AC7)
- **WHEN** the same authorized comment id is delivered twice
- **THEN** the second delivery is skipped by the channel watermark

### Requirement: GitHub-born tasks are read-only for their lifetime (v1)

The system SHALL enforce read-only mode for GitHub-born tasks — tasks whose channels include a GitHub channel — by construction. `request_edit_mode` SHALL be declined immediately with a message stating GitHub-born tasks are read-only in v1 — no approval prompt, no task pause, and `edit_allowed` never set. `request_max_mode` SHALL likewise fail fast with an explanation instead of pausing on an undeliverable prompt. Edit-mode approval resolution SHALL refuse to set `edit_allowed` on a GitHub-born task from every surface (Slack action, API route, debug MCP), returning a rejection the API maps to an error response — so the unauthenticated approve API cannot flip a GitHub-born task writable. The GitHub-born marker (the channel entry) SHALL be durable from the moment of creation (synchronous persist), so no crash window exists in which the task is on disk without the marker the guards read.

#### Scenario: request_edit_mode declines fast (AC10)
- **WHEN** an agent calls `request_edit_mode` on a GitHub-born task
- **THEN** the request is declined immediately with the read-only explanation, no approval prompt is posted, the task does not pause, and `edit_allowed` is never set

#### Scenario: request_max_mode declines fast (AC10)
- **WHEN** an agent calls `request_max_mode` on a GitHub-born task
- **THEN** the request is declined immediately with an explanation and the task does not pause

#### Scenario: Approve API cannot flip a GitHub-born task writable
- **WHEN** `POST /tasks/:id/approve` with `{type: "edit_mode", approve: true}` targets a GitHub-born task
- **THEN** the approval is rejected with an error response, `edit_allowed` remains unset, and no repo agent is restarted for a writable mount

#### Scenario: Slack-born tasks are unaffected
- **WHEN** the same tools and approval run on a task without a GitHub channel
- **THEN** behavior is exactly as before this change

### Requirement: Existing webhook routing is unchanged

The `merge_check`, `checks_ready`, and existing `existing_task` routing decisions — including comments on Archie-managed PR branches, branch-state comment dedup for those PRs, event message formatting for PR-attributed events, and the self-event filter condition — SHALL be byte-for-byte unaffected by the mention trigger. Comments on Archie-managed PR branches SHALL NOT incur a permission lookup. `pull_request_review_comment` events gain no mention handling.

#### Scenario: Archie-managed PR comments route as today (AC11)
- **WHEN** a comment arrives on a PR whose branch matches the Archie task pattern
- **THEN** it routes `existing_task` with identical formatting, identical skip/advance dedup behavior, and no permission lookup, exactly as before this change

#### Scenario: Merge and checks paths unaffected (AC11)
- **WHEN** `pull_request_review` approvals, `push`, `workflow_run`, or `check_suite` events arrive
- **THEN** they route to `merge_check`/`checks_ready`/`existing_task` exactly as before this change
