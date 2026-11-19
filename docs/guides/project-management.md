# Managing Archie development

Ideas, plans and status live in GitHub issues, not in the repository. This is developer tooling for the repository, independent of Archie's deployed PM.

## How work flows

| Step | What happens | Status |
|---|---|---|
| 1. Propose | Anyone opens a Feature issue for an idea or request, or a Bug issue for a defect | Backlog |
| 2. Decide | Maintainers discuss in the issue, then accept, park or close it. Accepting sets the scope, acceptance criteria, owner and next action | Ready |
| 3. Build | A pull request implements the issue and links it | In progress |
| 4. Verify | The work awaits review or acceptance checks. Merged code that is not yet verified stays here | Review |
| 5. Accept | The acceptance criteria are met with evidence. Merging alone is not enough | Done |

Backlog is the idea inbox: recorded, not committed. In progress means work has started, not that someone is on it right now.

## What is on an issue

| Thing | Answers | Values |
|---|---|---|
| Type | What kind of item is it? | **Feature:** an idea, a request or an accepted feature. **Bug:** something broken. **Task:** one agreed piece of work, usually a sub-issue of a Feature |
| Status | Where is it? | Its column on the [board](https://github.com/orgs/sweatco/projects/16), from the table above |
| Milestone | Which outcome does it deliver? | A named result that several issues deliver together, such as "Incoming events: a webhook runs a routine in Slack". Optional, and dated only when agreed |
| Labels | Does it need attention? | `pm:decision`: waiting for a human choice. `pm:blocked`: waiting for a named prerequisite. `pm:parked`: deliberately deferred. Each states its reason in the issue. `good first issue` and `help wanted`: open to contributors |

The board is private, so outside contributors read progress from the issue itself: its assignee, milestone, labels and linked pull requests. The board's views (Active, Decisions, Backlog, Memory) filter the same items. Its Initiative field is an optional theme for maintainers and implies no priority or commitment.

## Where things live

| Content | Home |
|---|---|
| Idea, proposal, research findings | A Feature issue. A large one gets Task sub-issues, so each part can be discussed and referenced on its own |
| Agreed scope, acceptance criteria, tasks, next action | The issue and its sub-issues |
| Approach taken and verification evidence | The PR description |
| Design and rationale that outlive the work | `docs/architecture/` or the owning guide, updated in the same PR |
| Private drafts and working notes | Outside the repository; not a record others can rely on |

[docs/plans/](../plans/README.md) and [docs/proposals/](../proposals/README.md) are frozen archives: no new files and no status updates. Existing files stay because code comments and documents link to them.

Issues and PRs are public. Keep internal links, production data and private plugin details out of them.

## Contributors

- Pick the matching issue form and search for duplicates first.
- For a feature, agree the approach in the issue before a large PR.
- Link the issue from the PR. Use a closing keyword only when merging meets the issue's acceptance criteria.
- Leave milestones, labels and status to maintainers.

## Maintainers

- **Triage the inbox:** accept an idea, park it with `pm:parked`, or close it with a reason. Age or a missing owner is a triage signal, not a reason to close.
- **Stay visible:** open a public issue before starting feature work a contributor could duplicate.
- **Keep it light:** simple fixes and PR-only maintenance need no issue or milestone.
- **Keep it honest:** leave unknown owners and dates unset. Link records instead of copying their status. Do not count an issue and its PR as two outcomes.
- **Review weekly:** cover changes, blockers, decisions and the next milestone, and check for superseded items before adding to the backlog. The [weekly report](project-access-and-automation.md#health-checks) is the input; agents summarize it when asked. No new meeting or scheduled monitor is implied.

The [initial disposition review](../plans/20261111-issue-disposition.md) is a dated snapshot whose classification remains a proposal, not a second backlog.

## Agents: required routine

The user owns priorities, scope and acceptance. Agents keep the records; they do not decide technical direction through tracking or invent priorities, owners, dates, acceptance or permission to implement.

1. **Resume:** find the owning issue, its status and next action.
2. **Capture:** when research yields an implementation idea, prepare a Feature issue with source links. Keep parked ideas parked.
3. **Decide:** record the user's decision to proceed and the agreed scope in that issue.
4. **Track:** reuse existing issues; prepare missing ones with the [task form](../../.github/ISSUE_TEMPLATE/task.yml). Link dependencies and use milestones for agreed outcomes.
5. **Maintain:** update status, decisions, blockers and next actions as work progresses.
6. **Accept:** link delivery evidence and record the user's acceptance before preparing closure. Keep remaining work visible.

Rules that always apply:

- **Approval:** each GitHub mutation, Git remote write or release needs explicit approval in the current chat. Prepare related edits as one concrete, reviewable batch. An approved automation may run its defined rules; its setup authorizes nothing broader.
- **Human decisions:** issue closures and scope changes need a recorded human decision.
- **Access:** follow [the access rules](project-access-and-automation.md#who-may-write) before any upstream access. They start with `node tools/pm/check-repository.mjs`.
- **Restraint:** respect analysis-only and no-recording requests. Pending tracking approval must not block otherwise authorized work.
- **Limits:** this routine creates no background monitoring and no authority for paid runs or deployments.
- **Tools:** use the `github-issues` skill for issue operations. Prefer connected tools; use authenticated `gh` for missing Project capabilities and look up current field and option IDs.
