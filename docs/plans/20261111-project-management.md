# Archie project management setup

ID: 2026-11-11-archie-project-management-setup-18f675
Created: 2026-11-11T20:17:00+00:00

Status: active, 2026-11-11. The private [Archie project](https://github.com/orgs/sweatco/projects/16) and native workflows are configured. The repository package is verified locally; the user approved committing it, pushing codex/pm-workflow, and opening a draft PR. The user chose to retain the board classification as a proposal; no backfill was applied. The [management guide](../guides/project-management.md) owns the ongoing process; the [issue disposition review](20261111-issue-disposition.md) records this dated audit.

## Agreed outcome and decisions

Formalize a small PM flow for this repository: capture ideas and decisions, prepare actionable work, group milestones and initiatives, and reconcile progress against evidence. Nudges concern the process; the user retains ideas, priorities, commitments, and acceptance. Memory groups D4 with existing memory work rather than becoming a separate board.

Use one repository-wide GitHub Project with Backlog, Ready, In progress, Review, and Done. Initiative groups do not create ownership or delivery commitments. Reuse issues, assignees, milestones, proposals, and PRs as their owning records. Keep one canonical guide and shared repo-local skills for Codex and Claude. Retain the existing rule requiring explicit current-chat approval for GitHub mutations, Git remote writes, and releases; approved automation is limited to its defined rules.

Choose native Project workflows for deterministic intake and event transitions, plus a read-only weekly repository report. This avoids an additional organization token or GitHub App. A broader Project synchronization Action is deferred: repository-scoped GITHUB_TOKEN cannot read organization Project fields. Revisit only if native automation demonstrably leaves a recurring coordination gap. Issue age, missing assignments, and an open PR are signals for review rather than invented delivery status or abandonment.

## Expected results and acceptance

The setup should make the agreed records, stage criteria, next process step, and human decision boundary discoverable to both agents. Every existing open issue and PR should have a proposed placement with evidence and a next step. Automation should perform the approved mechanical transitions and publish a useful health summary without changing priorities, accepting outcomes, closing issues, or making model calls.

Verify the native saved settings and at least a meaningful live intake event. Verify that the report reads all API pages, distinguishes issues and PRs, uses explicit attention flags, and handles issue metadata safely. Run the repository's required checks. Treat hosted execution and transitions that were only inspected as verification gaps, not proven behavior. Publication and classification require their concrete approval before execution.

## Outcome so far, 2026-11-11

- Created private Project 16, linked archie-hq, with Initiative and Status fields and Active, Decisions, Backlog, and Memory views.
- Configured native open-item intake and initial Backlog, linked-PR to In progress, merge to Review, reopen to Backlog, sub-issue inclusion, and archive of completed closed issues after one month without updates. Disabled Item closed to Done and Done to close issue.
- Created D4 [#374](https://github.com/sweatco/archie-hq/issues/374) under [Memory: reviewed evaluation baseline](https://github.com/sweatco/archie-hq/milestone/1), with no owner or deadline. Native intake added it to Backlog without a manual project mutation. Saved settings and enabled states were read back; merge, reopen, sub-issue, and archive events have not been exercised.
- Audited all 44 pre-existing open issues and 26 open PRs. Prepared a metadata-only backfill for 71 items including D4: 48 Backlog, 23 Review, no Ready/In progress/Done assumptions. No closures, reassignment, or scope rewrites are included. The user explicitly chose to keep classification as a proposal, so the backfill was not executed. The disposition matrix is a snapshot, not another live tracker.
- Added explicit decision labels to #200, #210, #327, and #374. The live repository report correctly reads 45 issues, 26 PRs including seven drafts, and four explicit decision flags. It states its Project-field limitation.
- Local npm run check passed under Node 24 and npm 11.16: formatting, lint, type checking, build, 2,355 Vitest tests, and four focused report tests. The first check identified formatting in the two new scripts; formatting was corrected and the full check passed. No dependency changes were required.
- The weekly Monday 09:00 UTC Actions workflow, agent guidance, task form, and shared skills are prepared on codex/pm-workflow. Publication as a draft PR is authorized; hosted workflow execution requires merge. Existing persistent-checkout edits were preserved.

Two bounded read-only scouts supplied issue/source evidence and current GitHub automation capabilities; one fresh critic reviewed the core flow and read-only report. All inherited the available model; independent model-family diversity was not established. The critic found an approval-policy discrepancy, corrected by preserving the stricter existing repository rule. No material technical defects were reported. Stop reason: settled; remaining gaps are merge and hosted/event verification, not further planning review.

## Next process steps

Keep classification as a proposal until the user chooses to revisit it; do not repeat that nudge without new information. Review the draft PR and decide whether to merge before expecting scheduled Actions runs. Inspect the first hosted health report after merge. For Memory, select a reviewer with access to the current private evaluation packet; choosing a reviewer does not authorize new model calls or production enablement. Resolve the existing supersession/acceptance candidates only after the evidence checks in the disposition review.

## Technical evidence

The local source and tests are the implementation authority. Current native workflow settings were inspected through GitHub UI and GraphQL. GitHub documents the [built-in workflows](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations), [automatic intake](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically), [archiving](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically), and [Actions authentication](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions). Workflow creation/configuration currently requires UI; GraphQL exposes workflow reads and deletion, while field/view/item setup is available through GraphQL.
