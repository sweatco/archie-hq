# Managing Archie development

Use the private [Archie project](https://github.com/orgs/sweatco/projects/16) as the repository-wide work board. Initiatives group related work; Memory is the first. [.github/project.json](../../.github/project.json) records its identity. This is developer tooling for the repository, independent of Archie's deployed PM.

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

## Agent maintenance

Use the repo-local `technical-project-management` and `github-issues` skills. Read the relevant current proposal, issue, milestone, and PR before asking the user to repeat context. Prefer connected tools; use authenticated `gh` for missing Project capabilities and discover current field/option IDs.

1. On resuming an initiative, identify its stage, next step, pending decision, and owning records. Do not conduct a portfolio audit on every coding task.
2. Offer to capture substantial ideas as drafts. The user owns ideas and priorities; process nudges do not critique ideas or expand scope.
3. When a direction is accepted, record the decision and prepare actionable work as needed. The [task form](../../.github/ISSUE_TEMPLATE/task.yml) captures objective, observable acceptance, context, and dependencies.
4. During authorized execution, maintain the owning issue and link PRs. At checkpoints, reconcile status with actual verification, deployment, and acceptance evidence.
5. At handoff, offer one useful process nudge after completing the requested work. Avoid ceremony on unrelated coding tasks and repeated declined nudges without new evidence.

Prepare related external edits as one concrete, reviewable batch. Require explicit approval in the current chat for each GitHub mutation, Git remote write, or release. An approved automation may execute its defined rules; its setup does not authorize broader agent edits. Do not invent priorities, owners, dates, acceptance, or permission to implement. Issue closures and scope changes require a recorded human disposition.

## GitHub automation

Native Project workflows handle open-item intake, initial Backlog placement, linked implementation work, merge-to-Review, reopen-to-Backlog, and sub-issue inclusion. Disable both Item closed → Done and Done → close issue: the former does not distinguish closure reasons, and a board edit must not close an issue. Record acceptance explicitly before setting Done or closing as completed. Use a PR closing keyword only when merging satisfies the issue's acceptance criteria.

Auto-archive only completed issues closed for at least one month. Do not automatically archive merged PRs: they can still await rollout or acceptance. Native event-driven workflows use the Project's access and need no new PAT or GitHub App secret.

The [Project health workflow](../../.github/workflows/project-health.yml) runs Mondays at 09:00 UTC and by manual dispatch. Its read-only job summary lists every open issue/PR, explicit attention flags, missing owners/milestones, and aging. It makes no model calls, posts no comments, and changes no records. Backlog items may legitimately have no owner or milestone; the report is review input, not a failure gate.

Repository-scoped `GITHUB_TOKEN` cannot read organization Project fields. The report states that limitation and does not claim to check initiative or stage consistency. Broader automatic synchronization needs a separate organization GitHub App permission; do not copy the local CLI login into Actions.

Run `node --test tools/pm/issue-health.test.mjs` for focused checks and `node tools/pm/issue-health.mjs` for an authenticated live preview. Run the repository's full `npm run check` before a code handoff. After native workflow edits, inspect saved settings, read back enabled states, and exercise a relevant event; record untested transitions.

A short weekly review covers changes, blockers, decisions, and the next accepted milestone. The Actions summary is its input; agents synthesize it when asked or at the next relevant session. No scheduled chat monitor or new meeting is implied. Review supersession candidates before expanding the backlog; never close work merely because it is old.

## Installed skills

Canonical copies live in `.agents/skills/`; `.claude/skills/` links to the same files. A short Claude rule points to canonical guidance rather than duplicating it.

| Skill | Upstream revision | License |
|---|---|---|
| `technical-project-management` | [magnus919/agent-skills @ da4ce5c](https://github.com/magnus919/agent-skills/tree/da4ce5c6823cce6da80f4e09c84998a4928402c1/technical-project-management) | [MIT](../../.agents/skills/technical-project-management/LICENSE.md) |
| `github-issues` | [github/awesome-copilot @ eaaffd5](https://github.com/github/awesome-copilot/tree/eaaffd5d020b756a2777a4b1b161d2bdc126d9a0/skills/github-issues) | [MIT](../../.agents/skills/github-issues/LICENSE) |

Keep upstream contents intact and local behavior here. Sibling-skill links do not require extra installations. Review a pinned revision, preserve its license, and verify discovery and link targets on updates. Install locally developed skills from the persistent main checkout, never a task worktree.
