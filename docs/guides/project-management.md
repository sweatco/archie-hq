# Managing Archie development

Use the private [Archie project](https://github.com/orgs/sweatco/projects/16) as the repository-wide work board. Initiatives group related work; Memory is the first. [.github/project.json](../../.github/project.json) records its identity. This is developer tooling for the repository, independent of Archie's deployed PM.

## Repository scope

This routine and the shared Project belong only to canonical `sweatco/archie-hq` (GitHub repository ID `1120227357`). "Canonical" identifies the repository, not its `main` branch: its feature branches and worktrees are eligible. A fork's own records and agent sessions must not create or change upstream Project items, drafts, fields, views, issues, milestones, labels, or assignments.

Before upstream PM access or an approved write batch, run `node tools/pm/check-repository.mjs`. It verifies this checkout's `origin`, GitHub's non-fork repository identity, and the repository name/ID in Actions context. Stop on failure or unknown identity. An `upstream` remote pointing to Archie, credentials with Project access, or a copied `.github/project.json` does not qualify a fork. Recheck after changing repository context. Forks can maintain local artifacts when requested and submit contributions for upstream review; they must not redirect their tracking into Archie's Project.

Before adding an issue or PR through either MCP or CLI, verify its owning repository is canonical. PR intake also requires explicit approval from an upstream maintainer for adding that PR to the Project. Check the base and head repository metadata; a fork-origin PR targeting Archie remains an external submission until admitted, and an unknown or deleted head must not be treated as same-repository work. Record the maintainer's intake decision in the owning record or approved batch. Approval to open or review a PR, a label, or passing CI alone does not grant intake approval. A canonical agent can add approved PRs in a batch; the fork session still cannot write to the Project.

Native automatic intake targets only open canonical issues with `is:issue is:open`. GitHub's [native intake filters](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically) do not distinguish head repositories, so every PR, including same-repository PRs, uses explicit maintainer-controlled intake. This trades automatic PR intake for a simple strict boundary without another credential or privileged workflow. Apply this policy to new intake; leave existing Project items in place unless a separate disposition is approved.

External repository issues may be linked as references, not added as Project items. Keep unfiltered sub-issue auto-add disabled, because sub-issues can belong to other repositories; canonical sub-issues enter through normal issue intake. GitHub permissions remain the access boundary: do not provide Project-write credentials to forks or execute fork-controlled code in a privileged upstream workflow.

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

Apply this workflow during active tasks. Use `github-issues` for issue operations. The user owns priorities, scope and acceptance; PM organizes records and transitions, not technical decisions or plan content.

1. **Resume:** Find the owning records, current stage and next action.
2. **Capture:** When research yields an implementation idea, save or update its draft in `docs/proposals/` with source links. Keep parked ideas parked.
3. **Decide:** Record the user's decision to proceed and agreed scope in the existing proposal or plan.
4. **Track:** Reuse existing issues; prepare missing tasks with the [task form](../../.github/ISSUE_TEMPLATE/task.yml). Link related records and dependencies; use milestones for agreed outcomes.
5. **Maintain:** Update status, decisions, blockers and next actions as work progresses. Scope changes require the user's decision.
6. **Accept:** Link delivery evidence and record the user's acceptance before preparing closure. Keep remaining work visible.

Respect analysis-only and no-recording requests. Simple fixes need no separate proposal or milestone. Pending tracking approval must not block otherwise authorized work. The historical issue classification remains a proposal. This routine creates no background monitoring or authority for paid runs or deployments.

Prepare related external edits as one concrete, reviewable batch. Require explicit approval in the current chat for each GitHub mutation, Git remote write, or release. An approved automation may execute its defined rules; its setup does not authorize broader agent edits. Do not invent priorities, owners, dates, acceptance, or permission to implement. Issue closures and scope changes require a recorded human disposition.

Prefer connected tools; use authenticated `gh` for missing Project capabilities and discover current field/option IDs. The repository check applies regardless of the chosen tool and must not be bypassed by making a direct MCP call from a fork.

## GitHub automation

Native Project workflows handle canonical open-issue intake, initial Backlog placement, linked implementation work, merge-to-Review, and reopen-to-Backlog. PR additions require maintainer-approved intake. Unfiltered sub-issue intake is disabled; canonical sub-issues use the same issue intake as other issues. Disable both Item closed → Done and Done → close issue: the former does not distinguish closure reasons, and a board edit must not close an issue. Record acceptance explicitly before setting Done or closing as completed. Use a PR closing keyword only when merging satisfies the issue's acceptance criteria.

Auto-archive only completed issues closed for at least one month. Do not automatically archive merged PRs: they can still await rollout or acceptance. Native event-driven workflows use the Project's access and need no new PAT or GitHub App secret.

The [Project health workflow](../../.github/workflows/project-health.yml) runs Mondays at 09:00 UTC and by manual dispatch. Its job requires the canonical repository name and ID, and the report's CLI also verifies checkout scope before GitHub reads. Fork copies skip the job. It uses only repository-scoped `GITHUB_TOKEN` read permissions for the repository inventory, including explicit attention flags, owners, milestones, and aging. It makes no model calls, posts no comments, and changes no records.

Board consistency checks are an explicit on-demand step in an authorized local repository session. Run `node tools/pm/issue-health.mjs --project` to include the Project audit, or add `--output /tmp/archie-project-health.md` to save the report. Without `--project`, the command reads repository records only, matching the scheduled workflow. The Project reader uses the existing GitHub CLI login and rejects execution in GitHub Actions. No additional App, token, key, secret, or permission grant is configured; unattended board checks are deferred until a new user decision.

The on-demand audit verifies the configured Project ID, number, and URL on every page, then reads Status, Initiative, and membership. It checks stage/ownership/attention-label contradictions, closed issue dispositions, merged or closed PR placement, and noncanonical records. Missing Initiative and Project membership are coverage notes: PR intake is maintainer-controlled and the declined historical classification is not an automatic repair request. Archived items and Project drafts are excluded from stage comparisons. Hidden content is explicitly reported as incomplete; access errors, missing fields, identity mismatches, and incomplete pagination fail the audit rather than silently claiming consistency.

The checker sends read queries only. It cannot prove accepted scope, human acceptance, deployment, or maintainer intake approval from board fields. Findings are review input, not a failure gate or authorization to change records. The local login may have broader permissions; the checker does not narrow those credentials or create a security sandbox. All PR admissions, board corrections, issue closures, and other writes retain the existing approval rules. Do not copy the interactive CLI login into Actions.

Run `node --test tools/pm/*.test.mjs` for focused checks and `node tools/pm/issue-health.mjs --project` for a local live preview with board checks. Run the repository's full `npm run check` before a code handoff. After native workflow edits, inspect saved settings, read back enabled states, and exercise a relevant event; record untested transitions.

A short weekly review covers changes, blockers, decisions, and the next accepted milestone. The Actions summary is its input; agents synthesize it when asked or at the next relevant session. No scheduled chat monitor or new meeting is implied. Review supersession candidates before expanding the backlog; never close work merely because it is old.

## Installed skills

Canonical copies live in `.agents/skills/`; `.claude/skills/` links to the same files. A short Claude rule points to canonical guidance rather than duplicating it.

| Skill | Upstream revision | License |
|---|---|---|
| `github-issues` | [github/awesome-copilot @ eaaffd5](https://github.com/github/awesome-copilot/tree/eaaffd5d020b756a2777a4b1b161d2bdc126d9a0/skills/github-issues) | [MIT](../../.agents/skills/github-issues/LICENSE) |

Keep repository policy in this guide. Preserve licenses when updating upstream skills, and verify discovery and link targets. Install locally developed skills from the persistent main checkout, never a task worktree.
