# Managing Archie development

Use the private [Archie project](https://github.com/orgs/sweatco/projects/16) as the repository-wide work board. Initiatives group related work; Memory is the first. [.github/project.json](../../.github/project.json) records its identity. This is developer tooling for the repository, independent of Archie's deployed PM.

## Repository scope

This routine and the shared Project belong only to canonical `sweatco/archie-hq` (GitHub repository ID `1120227357`). "Canonical" identifies the repository, not its `main` branch: its feature branches and worktrees are eligible. A fork's own records and agent sessions must not create or change upstream Project items, drafts, fields, views, issues, milestones, labels, or assignments.

Before upstream PM access or an approved write batch, run `node tools/pm/check-repository.mjs`. It verifies this checkout's `origin`, GitHub's non-fork repository identity, and the repository name/ID in Actions context. Stop on failure or unknown identity. An `upstream` remote pointing to Archie, credentials with Project access, or a copied `.github/project.json` does not qualify a fork. Recheck after changing repository context. Forks can maintain local artifacts when requested and submit contributions for upstream review; they must not redirect their tracking into Archie's Project.

Before adding an issue or PR through either MCP or CLI, verify its owning repository is canonical. A PR opened against Archie is an upstream-owned record even when its source branch is in a fork; trusted upstream intake may track it, while the fork session cannot write to the Project. External records may be linked as references, not added as Project items. Native intake targets only the canonical repository. Keep unfiltered sub-issue auto-add disabled, because sub-issues can belong to other repositories; same-repository sub-issues enter through normal repository-scoped intake. GitHub permissions remain the access boundary: do not provide Project-write credentials to forks or execute fork-controlled code in a privileged upstream workflow.

## Records and stages

Proposals in `docs/proposals/` own ideas, scope, rationale, and decisions. Issues own actionable deliverables or decisions, acceptance criteria, dependencies, and next steps. Milestones name bounded accepted outcomes; dates appear only when agreed. PRs carry implementation and verification evidence. Reuse the implementation workflow's existing plan rather than mandate both Forge and OpenSpec. Link owning records instead of copying live status. PR-only maintenance does not need a duplicate issue.

| Stage | Entry condition |
|---|---|
| Backlog | Recorded work without an accepted delivery commitment; owner and milestone may be unset |
| Ready | Accepted scope, observable acceptance criteria, owner, and next action; dependencies permit starting |
| In progress | Execution or linked implementation work has started; not proof that an agent is currently running |
| Review | Implementation or acceptance evidence awaits review, including merged code with outstanding delivery checks |
| Done | The agreed deliverable has acceptance evidence; merging alone is insufficient |

Use native assignees and milestones. Leave unknown owners and dates unset. Initiative membership does not imply a priority or delivery commitment. Avoid counting an issue and its implementation PR as independent delivered outcomes.

Use `pm:decision` for a concrete pending human choice, `pm:blocked` for an identified prerequisite, and `pm:parked` for explicitly deferred work. State the decision or unblocker in the issue. Missing ownership and age are triage signals, not proof of blockage or abandonment. Active, Decisions, Backlog, and Memory are views of the same items. The [initial disposition review](../plans/20261111-issue-disposition.md) is a dated snapshot, not another live backlog.

## Required research → idea → implementation routine

Perform the applicable steps as part of the user's work, rather than offering optional PM nudges. Use the repo-local `technical-project-management` and `github-issues` skills. The routine manages the process; the user owns ideas, priorities, scope commitments, and acceptance. Product critique or alternative ideation requires a separate request. It runs in active repository sessions, not as a background chat monitor.

1. **Resume from records.** Read the relevant current proposal, decisions, issues, milestone, and PR evidence before asking for context. Identify the phase, accepted scope, next step, and pending decision. Research done elsewhere needs its supplied notes or source links; do not invent findings or assume access to missing material.
2. **Capture the research conclusion.** When research yields a substantive implementation idea, create or update the owning draft in `docs/proposals/` without asking whether to capture it. Link research sources and existing work; distinguish findings, the user's conclusion, assumptions, decisions, and unresolved questions. Record intended behavior and the next process step. Keep large/private evidence in its owning location. An idea stays a draft or explicitly parked until the user chooses to advance it; capture does not authorize implementation or GitHub publication.
3. **Record the implementation decision.** When the user chooses implementation, record the dated decision, bounded first version, acceptance criteria, and deferred extensions in the proposal or existing owning plan. Resolve missing decisions that materially affect scope or acceptance; choose routine engineering details within the authorized task. Reuse the existing implementation planning workflow rather than imposing another plan format.
4. **Prepare actionable work.** Map the accepted outcome to existing issues first, then prepare only needed new tasks and a useful bounded milestone. Use the [task form](../../.github/ISSUE_TEMPLATE/task.yml). Include objective, observable acceptance, proposal/decision links, dependencies, agreed ownership, and next action. Show proposed external changes as a concrete batch and apply them only within explicit approval. Leave unknown owners/dates unset and uncommitted work in Backlog; Ready requires the entry conditions above.
5. **Maintain execution and scope.** During authorized work, maintain local decisions and prepare or apply approved updates to owning issues and PR links at meaningful checkpoints. Track a specific decision or blocker with its attention label. Record later research ideas as draft extensions; they enter an accepted milestone only after a recorded scope decision. If evidence or dependencies change, state the effect on the agreed outcome and obtain the necessary decision before changing the commitment. Do not start new paid runs or deployments merely to keep a milestone moving.
6. **Reconcile at handoff and acceptance.** Report stage, changes, verification evidence, exact pending decisions/blockers, and the next action. Keep proposals linked to live tracking instead of copying a second backlog. Distinguish implementation, merge, deployment, review, and accepted outcome. Record acceptance and prepare the approved Done/closure updates only when the agreed deliverable is evidenced; retain residual work explicitly.

Respect explicit analysis-only or no-recording requests, parked work, and declined changes. Do not reapply the initial issue classification: the user retained it as a proposal. Keep simple fixes and PR-only maintenance lightweight; they need the applicable scope, verification, and handoff steps, not a fabricated research proposal or milestone. Do not block useful authorized implementation while unrelated tracking edits await approval.

For example, research can lead the user to request on-demand meeting briefs. Capture the sources and idea, then record the user's first-version decision. Prepare context collection, referenced generation, and integrated acceptance work with their dependencies, reusing existing records. A later onboarding-brief idea stays a draft extension until the user changes scope. On resumption, read these records and report the accepted version and next step instead of asking the user to retell the research.

Prepare related external edits as one concrete, reviewable batch. Require explicit approval in the current chat for each GitHub mutation, Git remote write, or release. An approved automation may execute its defined rules; its setup does not authorize broader agent edits. Do not invent priorities, owners, dates, acceptance, or permission to implement. Issue closures and scope changes require a recorded human disposition.

Prefer connected tools; use authenticated `gh` for missing Project capabilities and discover current field/option IDs. The repository check applies regardless of the chosen tool and must not be bypassed by making a direct MCP call from a fork.

## GitHub automation

Native Project workflows handle canonical-repository open-item intake, initial Backlog placement, linked implementation work, merge-to-Review, and reopen-to-Backlog. Unfiltered sub-issue intake is disabled; canonical sub-issues use the same repository intake as other issues. Disable both Item closed → Done and Done → close issue: the former does not distinguish closure reasons, and a board edit must not close an issue. Record acceptance explicitly before setting Done or closing as completed. Use a PR closing keyword only when merging satisfies the issue's acceptance criteria.

Auto-archive only completed issues closed for at least one month. Do not automatically archive merged PRs: they can still await rollout or acceptance. Native event-driven workflows use the Project's access and need no new PAT or GitHub App secret.

The [Project health workflow](../../.github/workflows/project-health.yml) runs Mondays at 09:00 UTC and by manual dispatch. Its job requires the canonical repository name and ID, and the report's CLI also verifies checkout scope before GitHub reads. Fork copies skip the job and cannot inherit an upstream Project writer: this workflow only has repository read permissions. Its summary lists every open issue/PR, explicit attention flags, missing owners/milestones, and aging. It makes no model calls, posts no comments, and changes no records. Backlog items may legitimately have no owner or milestone; the report is review input, not a failure gate.

Repository-scoped `GITHUB_TOKEN` cannot read organization Project fields. The report states that limitation and does not claim to check initiative or stage consistency. Broader automatic synchronization needs a separate organization GitHub App permission; do not copy the local CLI login into Actions.

Run `node --test tools/pm/*.test.mjs` for focused checks and `node tools/pm/issue-health.mjs` for an authenticated live preview. Run the repository's full `npm run check` before a code handoff. After native workflow edits, inspect saved settings, read back enabled states, and exercise a relevant event; record untested transitions.

A short weekly review covers changes, blockers, decisions, and the next accepted milestone. The Actions summary is its input; agents synthesize it when asked or at the next relevant session. No scheduled chat monitor or new meeting is implied. Review supersession candidates before expanding the backlog; never close work merely because it is old.

## Installed skills

Canonical copies live in `.agents/skills/`; `.claude/skills/` links to the same files. A short Claude rule points to canonical guidance rather than duplicating it.

| Skill | Upstream revision | License |
|---|---|---|
| `technical-project-management` | [magnus919/agent-skills @ da4ce5c](https://github.com/magnus919/agent-skills/tree/da4ce5c6823cce6da80f4e09c84998a4928402c1/technical-project-management) | [MIT](../../.agents/skills/technical-project-management/LICENSE.md) |
| `github-issues` | [github/awesome-copilot @ eaaffd5](https://github.com/github/awesome-copilot/tree/eaaffd5d020b756a2777a4b1b161d2bdc126d9a0/skills/github-issues) | [MIT](../../.agents/skills/github-issues/LICENSE) |

Keep upstream contents intact and local behavior here. Sibling-skill links do not require extra installations. Review a pinned revision, preserve its license, and verify discovery and link targets on updates. Install locally developed skills from the persistent main checkout, never a task worktree.
