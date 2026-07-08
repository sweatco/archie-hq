# pr-merge-policy Specification

## Purpose
TBD - created by archiving change pr-merge-policy. Update Purpose after archive.
## Requirements
### Requirement: Per-repo autoMerge flag, default off

Repo-agent frontmatter SHALL accept an optional `autoMerge` boolean on each repo entry (`metadata.archie.repos[].autoMerge`; the legacy singular `metadata.archie.repo.autoMerge` SHALL be auto-migrated with the rest of the singular shape). The flag SHALL default to off: only the boolean literal `true` enables it, and absent or non-boolean values SHALL resolve to false. The resolved value SHALL be threaded through the plugin-loader and registry copies so it is available on every `RepoEntry`; dynamic (PM-spawned) agents SHALL always resolve to false.

#### Scenario: Flag absent everywhere (the shipped state)
- **WHEN** no agent frontmatter anywhere sets `autoMerge`
- **THEN** every repo resolves to autoMerge off, including Archie's own repo, and no repo auto-merges

#### Scenario: Flag parsed from the plural shape
- **WHEN** an agent declares `metadata.archie.repos: [{github: X, autoMerge: true}]`
- **THEN** the registry's `RepoEntry` for X carries `autoMerge: true`

#### Scenario: Non-boolean value fails safe
- **WHEN** frontmatter sets `autoMerge` to a non-boolean value (e.g. the string `"true"`)
- **THEN** the entry resolves to autoMerge off

#### Scenario: Legacy singular shape migrates
- **WHEN** an agent declares the legacy `metadata.archie.repo: {github: X, autoMerge: true}`
- **THEN** the synthesized plural form preserves `autoMerge: true` for X

### Requirement: Repo-level policy resolution requires unanimous opt-in

The system SHALL resolve a repo's merge policy at merge time via the registered agents that declare it: a repo is auto-mergeable only when at least one registered agent declares it AND every declaring agent's entries for it set `autoMerge: true`. A repo declared by no registered agent SHALL never be auto-mergeable. Conflicting declarations SHALL resolve to off and be logged as a warning.

#### Scenario: Conflicting flags resolve to off
- **WHEN** two agents declare the same repo, one with `autoMerge: true` and one without
- **THEN** the repo resolves to autoMerge off and a warning is logged

#### Scenario: Undeclared repo is never auto-merged
- **WHEN** a PR belongs to a repo no registered agent declares (e.g. attached only via a dynamic agent)
- **THEN** the repo resolves to autoMerge off

### Requirement: Orchestrator holds non-auto PRs and notifies once per ready state

When a merge-triggering webhook arrives, the merge orchestrator SHALL evaluate policy per PR. A ready PR (open, approved, and mergeable per GitHub) in a non-auto repo SHALL NOT be merged; instead the PM SHALL be prompted to post exactly one Slack-thread notification that the PR is ready and can be merged on request. A ready PR whose merge-approval request is currently pending SHALL NOT produce the notification — the user already holds an actionable prompt for it. A ready PR that is already armed for auto-merge (`BranchState.merge_armed`) SHALL NOT produce the notification either — the user has already approved it, so a "ready — ask me to merge" nudge would be noise. Once-ness SHALL be enforced by a persisted per-branch marker that is set when the notification fires and cleared when a merge check observes the PR no longer ready, so repeated webhooks for the same ready state never re-notify, restarts do not re-notify, and a PR that becomes un-ready and then ready again notifies again.

#### Scenario: Non-auto ready PR is held and notified once (AC1)
- **WHEN** an approval webhook arrives for a mergeable PR in a repo without `autoMerge: true`
- **THEN** the system does not merge the PR and the PM posts exactly one ready notification to the Slack thread

#### Scenario: Webhook burst for the same ready state does not re-notify (AC1)
- **WHEN** multiple merge-triggering webhooks (approval, synchronize, push, workflow_run) arrive for the same PR while it stays ready
- **THEN** no additional ready notification is produced

#### Scenario: Re-ready after new commits notifies again
- **WHEN** a previously-notified PR becomes not-ready (e.g. new commits, CI pending) and later becomes ready again
- **THEN** the ready notification is produced once more

#### Scenario: Pending merge approval suppresses the ready nudge
- **WHEN** a merge check observes a ready non-auto PR whose merge-approval request is currently pending
- **THEN** no ready notification is produced for that PR

#### Scenario: Armed PR is excluded from the ready notification (AC1)
- **WHEN** a merge check observes a ready non-auto PR that is already armed for auto-merge
- **THEN** no ready notification is produced for that PR — the user already approved it

#### Scenario: Auto repo merges as today (AC2)
- **WHEN** an approval webhook arrives for a mergeable PR in a repo whose policy resolves to `autoMerge: true`
- **THEN** the system squash-merges the PR exactly as before this change

#### Scenario: Mixed-policy task is evaluated per PR
- **WHEN** one task has a ready PR in an auto repo and a ready PR in a non-auto repo
- **THEN** the auto PR merges and the non-auto PR is held with a ready notification

### Requirement: Orchestrator merges armed PRs when GitHub reports them clean

The merge orchestrator SHALL maintain an armed bucket alongside the auto-merge bucket. A PR whose `BranchState.merge_armed` marker is set SHALL be merged on the next merge-triggering webhook once GitHub reports it `state: open` and `mergeableState: clean` — with NO Archie review-approval floor (GitHub branch protection is the sole authority) and NO `blocked` tolerance. An armed PR that GitHub reports `blocked` (a required review or check still pending) SHALL NOT be merged; it stays armed until it turns clean. The `merge_armed` marker SHALL be cleared when the PR is observed merged or closed. Because a branch's `pr_number` outlives any single PR, the per-PR markers (`merge_armed` and `merge_ready_notified`) SHALL be reset whenever a branch's PR number is reassigned (a new PR opened on a reused branch), so a new PR never inherits a prior PR's arm or notification state.

#### Scenario: Armed PR merges when clean (AC5)
- **WHEN** an armed PR reaches `mergeableState: clean` and a merge-triggering webhook arrives
- **THEN** the orchestrator merges it with no Archie review-approval floor and clears the `merge_armed` marker

#### Scenario: Armed but blocked PR is not merged (AC5)
- **WHEN** an armed PR is `mergeableState: blocked` (required review or CI still pending)
- **THEN** the orchestrator does not merge it and it stays armed

#### Scenario: Armed marker cleared on merge or close (AC5)
- **WHEN** an armed PR is observed merged or closed
- **THEN** the `merge_armed` marker is cleared

#### Scenario: Branch reuse resets per-PR markers
- **WHEN** a branch whose BranchState carried `merge_armed` or `merge_ready_notified` has a new PR number assigned (a new PR opened on the reused branch)
- **THEN** both markers are cleared so the new PR starts unarmed and un-notified

### Requirement: merge_pull_request arms auto-merge in non-auto repos

The `merge_pull_request` tool SHALL check the repo's merge policy before acting. In an auto repo it SHALL merge directly when GitHub reports the PR `clean` and SHALL otherwise return the current not-ready status with no prompt (current behavior). In a non-auto repo it SHALL NOT merge and SHALL NOT interpret the PR's mergeable state: for any open PR it SHALL post a merge-approval request (approval type `merge`) mirroring the edit-mode flow — interactive approve/deny message, duplicate-request suppression, status suspension, and a deferred task pause — and SHALL persist the requested PR (`github`, `pr_number`, requesting agent) in task metadata so resolution survives restarts. The prompt SHALL frame approval as arming auto-merge ("merge when ready"), not merging now. A closed or merged PR SHALL be reported as such instead of prompting. The tool SHALL NOT require the PR to be mergeable yet and SHALL NOT require any GitHub review approvals. Duplicate suppression SHALL be gated on task-level quiescence: while any agent process in the task holds the parked pause of an unresolved request, a repeat call SHALL report the request as already pending and post nothing. A pending request left unresolved after the task has quiesced and been reactivated (no agent in the task holds a parked pause) SHALL be superseded by a later call: the persisted request is rewritten for the newly requested PR and a fresh prompt is posted, so a stale request can never permanently block merging.

#### Scenario: Non-auto repo arms instead of merging (AC3)
- **WHEN** an agent calls `merge_pull_request` for an open PR in a non-auto repo
- **THEN** no merge occurs and nothing is armed, an `approval:requested` event of type `merge` is emitted, the pending request is persisted, and the task pauses — regardless of whether the PR is currently mergeable

#### Scenario: Auto repo merges directly (AC6)
- **WHEN** an agent calls `merge_pull_request` in an `autoMerge: true` repo in edit mode and GitHub reports the PR `clean`
- **THEN** the tool merges immediately with no approval prompt

#### Scenario: Auto repo non-clean PR does not merge (AC6)
- **WHEN** an agent calls `merge_pull_request` in an `autoMerge: true` repo and GitHub reports the PR not `clean`
- **THEN** the tool returns the not-ready status and does not merge

#### Scenario: Not-yet-mergeable PR still prompts (AC3)
- **WHEN** `merge_pull_request` is called in a non-auto repo for an open PR that GitHub does not yet report mergeable (e.g. checks pending, `blocked`)
- **THEN** the approval request is posted normally — approving arms the PR to merge once it becomes ready

#### Scenario: Duplicate request while the pause is parked is suppressed
- **WHEN** `merge_pull_request` is called again while any agent process in the task still holds the parked pause of an unresolved merge request — whether in the same agent turn that posted it or from a concurrently running second agent in a multi-repo task
- **THEN** no second prompt is posted, the pending request is not superseded, and the tool reports the request is already pending

#### Scenario: Stale pending request is superseded after quiescence
- **WHEN** the task quiesced and was reactivated without its pending merge request being resolved (no agent in the task holds a parked pause) and `merge_pull_request` is called again
- **THEN** the persisted request is rewritten for the requested PR and a fresh approval prompt is posted

#### Scenario: Zero review approvals do not block the request (AC5)
- **WHEN** the PR has zero GitHub review approvals
- **THEN** the approval request is posted normally — Archie imposes no approval floor

#### Scenario: Closed or merged PR is not prompted
- **WHEN** `merge_pull_request` is called in a non-auto repo for a PR that is already closed or merged
- **THEN** the tool returns the state explanation and posts no approval request

### Requirement: Merge approval arms or merges, identically from every surface

Approving a pending merge request SHALL cause the engine to re-check the PR with GitHub and, when GitHub reports it open and `clean`, merge it immediately and notify the user via the PM. When the PR is open but not yet `clean`, approval SHALL instead **arm** it for auto-merge — setting a persisted per-PR marker (`BranchState.merge_armed`) — with no error surfaced and the task winding down while the PM relays that it will merge once checks pass. When the PR is already closed or merged, approval SHALL record that there is nothing to merge and SHALL arm nothing. No Archie-side review-approval requirement SHALL be imposed anywhere on this path — GitHub branch protection is the sole review authority. Denying SHALL result in no GitHub calls, no merge, and no arming, with the denial recorded and the PM reactivated. The Slack buttons (`approve_merge`/`deny_merge`) and the API path (`POST /tasks/:id/approve` with `type: "merge"`) SHALL resolve through the same Task resolution methods. Every resolution surface SHALL carry the identity of the PR being resolved — Slack buttons in their payload, the API path in its request body (required for merge-type requests) — and SHALL pass it into the Task resolution methods, which SHALL verify it against the pending request atomically with clearing it: a synchronous read-compare-clear with no await between reading the pending request, comparing it to the expected PR, and clearing it. The pending request SHALL be cleared only on a matching resolution, so a stale, repeated, or mismatched resolution is a no-op: a resolution whose PR does not match the current pending request SHALL resolve nothing and mark the prompt as stale, even when the pending request is superseded while that resolution is in flight.

#### Scenario: Approval of a clean PR merges immediately (AC4)
- **WHEN** the user approves the pending merge request and GitHub reports the PR open and `clean`
- **THEN** the PR is merged and the PM is reactivated to notify the user

#### Scenario: Approval of a not-yet-clean PR arms auto-merge (AC4)
- **WHEN** the user approves but GitHub reports the PR open and not yet `clean` (e.g. checks pending, `blocked`)
- **THEN** no merge occurs, the PR's `BranchState.merge_armed` marker is set, no error is surfaced, and the task winds down with the PM relaying that it will merge once checks pass

#### Scenario: Approval of a closed PR arms nothing (AC4)
- **WHEN** the user approves but GitHub reports the PR already closed or merged
- **THEN** no merge occurs, nothing is armed, and the outcome is recorded and surfaced to the user via the PM

#### Scenario: Zero review approvals still arm or merge on approval (AC5)
- **WHEN** the approved PR has zero GitHub review approvals
- **THEN** approval proceeds — the PR merges if `clean` and is armed otherwise, with no Archie approval floor

#### Scenario: Denial performs no merge and no arming (AC3)
- **WHEN** the user denies the pending merge request
- **THEN** no merge occurs, nothing is armed, the denial is recorded, and the PM is reactivated

#### Scenario: Slack button and API path resolve identically (AC8)
- **WHEN** a merge approval is resolved via the Slack button and, on an equivalent task, via the API route
- **THEN** both invoke the same Task resolution methods with the same effects

#### Scenario: Stale resolution is a no-op
- **WHEN** an approval arrives for a task with no pending merge request (already resolved)
- **THEN** nothing is merged or armed and the event is logged without error

#### Scenario: Click on a superseded prompt is a no-op
- **WHEN** an approve/deny click arrives from a prompt whose PR identity does not match the current pending request — including when a supersede rewrites the pending request mid-resolution, after the click was received but before it resolves
- **THEN** nothing is resolved, merged, or armed — the atomic compare rejects the resolution against the rewritten request — and the prompt's message is updated with a stale notice

### Requirement: Merge approval type is observable and resolvable in the debug MCP

The debug MCP SHALL surface a pending merge approval via `wait_for_task` as `STATE=approval_requested` with `APPROVAL_TYPE=merge`, and its `approve` tool SHALL accept `type: "merge"` together with the pending PR's identity (`github`, `pr_number`), forwarded in the API request body, to resolve it through the API path.

#### Scenario: wait_for_task surfaces the merge gate (AC3)
- **WHEN** `wait_for_task` observes a task paused on an unresolved `approval:requested` event with `approvalType: "merge"`
- **THEN** it returns `state: "approval_requested"` with `approval_type: "merge"`

#### Scenario: approve resolves a merge gate
- **WHEN** the `approve` tool is called with `type: "merge"`, `approve: false`, and the pending PR's `github`/`pr_number`
- **THEN** the task's merge request is denied via the standard API path and no merge occurs

