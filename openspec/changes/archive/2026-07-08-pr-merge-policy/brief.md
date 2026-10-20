# Brief: per-repo auto-merge policy (issue #139)

**Change name:** `pr-merge-policy` · **Branch:** `forge/pr-merge-policy` · **Source:** issue [sweatco/archie-hq#139](https://github.com/sweatco/archie-hq/issues/139) · **Signed off:** 2026-07-06

## Problem

Archie auto-merges every linked PR the moment it's approved and mergeable — hardcoded in `checkAndMergeLinkedPRs()` (`src/connectors/github/merge.ts`). Some repos need supervision: manual rollout, more eyes, or no bot merges at all. There is no per-repo control, and no way to require an explicit human "merge it".

## Goals

1. Single per-repo knob: `autoMerge` boolean in the repo agent's frontmatter (`metadata.archie.repo.autoMerge`, next to `github`/`baseBranch` in `plugins/<domain>/agents/*.md`). **Default: off.**
2. **Off (default):** system never merges automatically. When a PR becomes approved + green, PM notifies the Slack thread once ("ready — ask me to merge"). Merge happens only via explicit user request: agent calls `merge_pull_request` → tool surfaces a merge-approval request and pauses the task (mirroring the edit-mode approval flow, new `merge` approval type) → user approves (Slack button or API) → merge executes if GitHub reports the PR mergeable.
3. **On (`autoMerge: true`):** current behavior preserved — approval event + mergeable → squash merge.
4. Hard enforcement in the engine, not prompts: the orchestrator skips non-auto repos, and the `merge_pull_request` tool checks policy itself.
5. Archie imposes no approval-count requirement of its own — GitHub branch protection is the sole authority on mergeability.

## Non-goals

- Approval counting (`min_approvals`), merge-method override, channel-scoped permissions, a separate "prohibited" knob (off + user never asking = effectively prohibited).
- Setting `autoMerge: true` for any real repo in archie-plugins — repo owners opt in later; this change ships all-off.
- Changing how approval webhooks arrive or the debounce mechanics.

## Constraints

- Config lives only in agent frontmatter (archie-plugins); engine changes in archie-hq. No new config files.
- Deliberate behavior break: existing repos stop auto-merging on deploy day. That's the point.
- Multi-repo tasks: policy is evaluated **per PR**. How the current "all PRs approved before any merge" coupling interacts with mixed policies is an open design question — plan stage resolves it and adds an AC for whatever it decides.

**Risk class:** engine (archie-hq `src/connectors/github/`, `src/agents/tools.ts`, `src/connectors/slack/events.ts`, registry/frontmatter parsing). Plugins repo: docs only.

## Acceptance criteria

| ID | Criterion | Method |
|----|-----------|--------|
| AC1 | WHEN a PR linked to a task is in a repo whose agent frontmatter lacks `autoMerge: true`, and an approval webhook arrives with the PR mergeable, THEN the system does not merge, and the PM posts **exactly one** Slack-thread notification that the PR is ready and can be merged on request — including when multiple merge-triggering webhooks (approval, synchronize, push, workflow_run) arrive for the same PR state. | integration |
| AC2 | WHEN the repo agent frontmatter sets `autoMerge: true` and an approval webhook arrives with the PR mergeable, THEN the system squash-merges as today. | integration |
| AC3 | WHEN an agent calls `merge_pull_request` in a non-auto repo, THEN the tool does not merge; the task pauses with an `approval_requested` event of type `merge` (observed live via `wait_for_task` `APPROVAL_TYPE=merge`), and denying the request results in no merge. | live-e2e |
| AC4 | WHEN the user approves the surfaced merge request AND GitHub reports the PR mergeable, THEN the merge executes and the user is notified; if not mergeable, the tool reports why instead. | integration |
| AC5 | WHEN the explicit-request merge path runs on a PR with zero GitHub review approvals but GitHub reports it mergeable, THEN the merge proceeds — no Archie-side approval floor. | unit |
| AC6 | WHEN an agent calls `merge_pull_request` in an `autoMerge: true` repo in edit mode, THEN it merges directly with no extra approval prompt (current behavior). | integration |
| AC7 | WHEN no frontmatter is changed anywhere, THEN no repo auto-merges — the default is off for every agent, including Archie's own repo. | unit |
| AC8 | WHEN a user clicks the approve/deny button on a merge-approval Slack message, THEN the merge approval resolves identically to the API path (new action ids wired to the same resolution code as `approve_edit_mode`/`deny_edit_mode` at `src/connectors/slack/events.ts:217`). | integration |
| AC9 | First real merge-on-request after deploy: in a non-auto repo, a merge request is approved via the actual Slack button and the PR actually merges. | deploy-only |

## QA limitations (accepted at sign-off)

- **AC9 (deploy-only):** live Slack rendering, prod GitHub App permissions, and real webhook timing are unverifiable pre-merge. Ships as a named post-merge step: the operator runs the first real merge request and confirms.
- **AC3 (live-e2e):** harness supports the recipe today (edit-mode recipe extended, deny path, no real merge executed). Only risk is docker/env availability at QA time; if blocked, degrades to integration + AC9 absorbs the live check — return to the user before taking that waiver.
- All other ACs are unit/integration — CI-verifiable, no waivers expected.

## Interview notes (context for later stages)

- User explicitly scrapped approval-counting and merge-method knobs — one boolean only.
- "If repo does not require approvals to merge, we should not force any approvals from our end" — GitHub branch protection is the authority (AC5).
- Merge-approval UX deliberately mirrors edit-mode approval: tool call → interactive prompt → user approves → execute.
- Approval plumbing to extend: `postInteractiveToUser` approvalType union (`src/tasks/task.ts:585`), API route branch (`src/connectors/api/routes.ts:253`), Slack action handlers (`src/connectors/slack/events.ts:217,266`), debug MCP `approve` tool.
