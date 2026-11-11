# Memory

> Project brief, 2026-11-11. The user agreed to group D4 under Memory, an initiative in the repository-wide [Archie project](https://github.com/orgs/sweatco/projects/16/views/4). Delivery owners, priorities, dates, and implementation commitments remain open.

## Purpose and scope

Manage Archie's knowledge memory as one workstream: storage and audience safety, extraction and recall, evaluation, and evidence for enablement. D4 is the human review task within that workstream, rather than a standalone project decision. This grouping reuses the current implementation and existing issues and PRs; it does not propose a replacement memory system.

## Existing work

| Area | Owning record | Recorded state and next process step |
|---|---|---|
| Audience-scoped storage and recall | [Architecture](https://github.com/sweatco/archie-hq/blob/main/docs/architecture/memory.md), [PR #315](https://github.com/sweatco/archie-hq/pull/315) | #315 merged on 2026-09-20. Treat it as the existing baseline; verify current deployment and flags before making rollout claims. |
| Explicit memory writes and duplicate extraction | [PR #341](https://github.com/sweatco/archie-hq/pull/341) | Merged on 2026-09-29. Preserve the author and audience approval boundaries in later work. |
| Store preservation on startup | [Issue #351](https://github.com/sweatco/archie-hq/issues/351) | Open. Assign an owner, check the current implementation, and record acceptance evidence for preserving a non-empty unmarked store. |
| Offline evaluation and paired baselines | [Draft PR #228](https://github.com/sweatco/archie-hq/pull/228) | Open draft. Complete the source and human review work below before drawing a quality conclusion. |

These are source snapshots, not a second task tracker. Keep changing status, assignments, and implementation evidence in the owning issue or PR. Existing merged capabilities are project context, not tasks to rebuild.

## First milestone: reviewed evaluation baseline

The [reviewed evaluation baseline milestone](https://github.com/sweatco/archie-hq/milestone/1) groups the work to produce an auditable evaluation record whose source authorization, execution, grading, and independent human review are distinguishable. It establishes review readiness; it does not require or imply positive memory uplift. Delivery priority and reviewer acceptance are not yet agreed; no deadline is assigned.

### D4 — Complete source review and human calibration

Owning task: [#374](https://github.com/sweatco/archie-hq/issues/374).

Owning implementation: [PR #228](https://github.com/sweatco/archie-hq/pull/228). Its [evaluation guide at the reviewed head](https://github.com/sweatco/archie-hq/blob/4c39814dacec1f302b3b964ba822eeacee6e4cb1/docs/memory-evaluation.md) identifies the private review records and workflow. It reports pending source labels, quarantined Archie cases, and zero of three human reviews on the recorded diagnostic run. Private artifacts were not inspected for this brief, so recheck their current state before treating those counts as current.

- Confirm the reviewer and identify the current run, corpus revision, and immutable evidence packet. Keep the corpus, transcripts, and detailed human responses in their existing private location.
- Review source labels separately from answers. For historical Archie cases, verify channel kind, app access, requester membership, and relevant message spans at the required times. Leave cases with missing or unknown authorization quarantined.
- Independently review each required answer sample against the original authorized evidence and what its reader actually saw. Use `calibration/human-responses.json`; do not prefill human judgments or expose model verdicts before the independent review.
- Record any disagreement resolution and check `calibration/readiness.json` for missing, stale, incomplete, or unresolved reviews.
- Refresh the saved packet and reports using the existing offline workflow. A substantive case or history change requires a new run; review-only updates can reuse compatible saved results. New model calls need separate scope and budget authorization.
- Report execution, grading, source-label approval, and human calibration separately. A complete eligible run may reach `review_ready`, while `qualityOutcome` remains `not_gated`. An incomplete run stays incomplete even when its available samples are reviewed.

The milestone is complete when the selected run's required stages and reviews are complete and current, unresolved cases are explicitly quarantined or recorded as gaps, and the reviewer accepts the resulting evidence record. The readiness of one selected run does not release every quarantined case or approve production enablement. A later quality decision must state its own criteria and evidence.

Store-safety work in #351 can proceed independently of this human review. Do not turn membership in the Memory project into an execution dependency.

## Related work and boundaries

- [Replay evaluation PR #365](https://github.com/sweatco/archie-hq/pull/365) covers attention, memory, and response behavior. Link it as related evaluation infrastructure; its replay-coverage problems are not resolved by completing D4, and it is not automatically part of this milestone.
- [Self-evolution PR #361](https://github.com/sweatco/archie-hq/pull/361) remains separate. Reflection, learned behavior, and production activation are not authorized by organizing Memory.
- The [analytics proposal](analytics-plugin-gaps.md) records an older system-wide memory direction. Reconcile it with the existing memory architecture before promoting any remaining gap into new work; its historical priority labels are not new delivery commitments.
- Live Slack observation and attention have separate storage and authorization. A Memory project does not combine those subsystems or their controls.

## Next process step

The accepted tracking surface is the Memory view within the private repository-wide Archie project, replacing the earlier separate-board proposal. Existing issue #351 and draft PR #228 remain their owning records. Task #374 tracks D4 and carries `pm:decision`; the first actionable input is an accepted reviewer with access to the current private packet. The milestone has no due date or assigned reviewer.

The view is configured, but initial initiative assignments remain proposed: the user chose to retain the board classification as a proposal on 2026-11-11. Native intake added #374 at Backlog; no manual backfill was applied.

Keep new evaluation commitments pending until accepted. A board entry does not complete human review, establish evaluation uplift, or authorize production enablement. The [project management guide](../guides/project-management.md) defines maintenance and acceptance boundaries.
