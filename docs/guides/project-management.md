# Managing Archie development

Ideas, plans and status live in GitHub issues. None of them are committed to the repository. This is developer tooling for the repository, independent of Archie's deployed PM.

## The short version

1. **Idea or request:** open a Feature issue. Open Feature issues are the idea inbox.
2. **Something broken:** open a Bug issue.
3. **Decision:** maintainers discuss in the issue, then accept, park or close it.
4. **Plan:** an accepted issue gets acceptance criteria. Large work is split into Task issues and grouped under a milestone.
5. **Build:** a pull request implements the issue and links it.
6. **Done:** the acceptance criteria are met with evidence. Merging alone is not done.

## The four things on an issue

| Thing | Answers | Values |
|---|---|---|
| Type | What kind of item is it? | **Feature:** an idea, a request or an accepted feature. **Bug:** something broken. **Task:** one agreed piece of work, often part of a Feature |
| Status | Where is it? | Backlog → Ready → In progress → Review → Done |
| Milestone | Which outcome does it deliver? | A named result that several issues deliver together, such as "Incoming events: a webhook runs a routine in Slack". Optional |
| Labels | Does it need attention? | `pm:decision`: waiting for a human choice. `pm:blocked`: waiting for a named prerequisite. `pm:parked`: deliberately deferred. `good first issue` and `help wanted`: open to contributors |

Status is a column on the [board](https://github.com/orgs/sweatco/projects/16):

| Status | Meaning |
|---|---|
| Backlog | Recorded, not committed. New ideas wait here |
| Ready | Accepted: scope, acceptance criteria, owner and next action are set |
| In progress | Work has started; not proof that anyone is working on it right now |
| Review | Awaiting review or acceptance checks, including merged code not yet verified |
| Done | Acceptance criteria met with evidence |

The board is private, so outside contributors cannot see Status. They read progress from the issue itself: its assignee, milestone, labels and linked pull requests. The board's views (Active, Decisions, Backlog, Memory) are filters over the same items. Its Initiative field is an optional theme for maintainers; it implies no priority or commitment.

## Where things live

| Content | Home |
|---|---|
| Idea, proposal, research findings | A Feature issue |
| Agreed scope, acceptance criteria, tasks, next action | The issue and its sub-issues |
| Approach taken and verification evidence | The PR description |
| Design and rationale that outlive the work | `docs/architecture/` or the owning guide, updated in the same PR |
| Private drafts and working notes | Outside the repository; not a record others can rely on |

A large proposal is one Feature issue with Task sub-issues, so each part can be discussed and referenced on its own.

[docs/plans/](../plans/README.md) and [docs/proposals/](../proposals/README.md) are frozen archives. Add no files and no status updates there. Existing files stay because code comments and documents link to them.

Issues and PRs are public. Keep internal links, production data and private plugin details out of them.

## Contributors

- Pick the matching issue form and search for duplicates first.
- For a feature, agree the approach in the issue before a large PR.
- Link the issue from the PR. Use a closing keyword only when merging meets the issue's acceptance criteria.
- Maintainers set milestones, labels and board status. You do not need to.

## Maintainers

- **Triage the inbox:** accept an idea by setting acceptance criteria and an owner, park it with `pm:parked` and a reason, or close it with a reason. Age alone is no reason to close, and a missing owner is a triage signal, not proof of abandonment.
- **Stay visible:** open a public issue before starting feature work a contributor could duplicate.
- **Milestones:** name each after its outcome. Add a date only when agreed.
- **Attention labels:** state the pending decision or the unblocker in the issue.
- **Keep it honest:** leave unknown owners and dates unset. Link records instead of copying status. Do not count an issue and its PR as two outcomes. PR-only maintenance needs no issue.
- **Weekly review:** cover changes, blockers, decisions and the next milestone, using the [health report](project-access-and-automation.md#github-automation) as input. Check for superseded items before adding to the backlog. No new meeting or scheduled monitor is implied.

The [initial disposition review](../plans/20261111-issue-disposition.md) is a dated snapshot whose classification remains a proposal, not another live backlog.

## Agents: required routine

The user owns priorities, scope and acceptance. Agents organize records and transitions; they do not make technical decisions through tracking or invent priorities, owners, dates, acceptance or permission to implement.

1. **Resume:** find the owning issue, its status and next action.
2. **Capture:** when research yields an implementation idea, prepare a Feature issue with source links. Keep parked ideas parked.
3. **Decide:** record the user's decision to proceed and the agreed scope in that issue.
4. **Track:** reuse existing issues; prepare missing tasks with the [task form](../../.github/ISSUE_TEMPLATE/task.yml). Link dependencies; use milestones for agreed outcomes.
5. **Maintain:** update status, decisions, blockers and next actions as work progresses. Scope changes need the user's decision.
6. **Accept:** link delivery evidence and record the user's acceptance before preparing closure. Keep remaining work visible.

Rules that always apply:

- **Approval:** each GitHub mutation, Git remote write or release needs explicit approval in the current chat. Prepare related edits as one concrete, reviewable batch. An approved automation may run its defined rules; its setup authorizes nothing broader.
- **Access:** before any upstream access, follow [the access rules](project-access-and-automation.md#repository-scope). Run `node tools/pm/check-repository.mjs` and stop on failure. Forks must not write upstream records, and adding a PR to the board needs maintainer approval.
- **Restraint:** respect analysis-only and no-recording requests. Simple fixes need no separate issue or milestone. Pending tracking approval must not block otherwise authorized work.
- **Human decisions:** issue closures and scope changes need a recorded human decision.
- **Limits:** this routine creates no background monitoring and no authority for paid runs or deployments.
- **Tools:** use the `github-issues` skill for issue operations. Prefer connected tools; use authenticated `gh` for missing Project capabilities and discover current field and option IDs.
