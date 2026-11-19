# Managing Archie development

Ideas, plans and status live in GitHub issues, not in the repository. This is developer tooling for the repository, independent of Archie's deployed PM.

## How work flows

An issue's state is read from the issue itself, so anyone can see it and nobody has to maintain it.

| State | Meaning | How to tell |
|---|---|---|
| Idea | Proposed, not committed. These issues are the idea inbox | Open, no milestone |
| Planned | Accepted, with agreed scope and acceptance criteria | Has a milestone |
| In progress | Someone is building it | Has an assignee or a linked pull request |
| Done | The acceptance criteria are met | Closed as completed |

Maintainers accept an idea by adding it to a milestone, or close it as not planned with a reason. A pull request implements an issue and links it. Close an issue only when its acceptance criteria are met; merging alone is not enough. Small work skips Planned: assign the issue or open the pull request.

## What is on an issue

| Thing | Answers | Values |
|---|---|---|
| Type | What kind of item is it? | **Feature:** an idea, a request or an accepted feature. **Bug:** something broken. **Task:** one agreed piece of work |
| Sub-issues | What does a Feature consist of? | Its Tasks. The Feature shows their progress |
| Milestone | Which outcome does it deliver? | One shippable stage of a Feature, such as "Incoming events: a webhook runs a routine in Slack". Dated only when agreed |
| Assignee | Who is doing it now? | Empty until someone starts |
| Labels | Does it need attention? | `pm:decision`: waiting for a human choice, which the issue states. `good first issue` and `help wanted`: open to contributors |

When one issue waits on another, mark it as blocked by that issue instead of using a label.

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
- Leave milestones and labels to maintainers.

## Maintainers

- **Triage the inbox:** accept an idea into a milestone, leave it in the inbox, or close it as not planned with a reason. Age alone is not a reason to close.
- **Stay visible:** open a public issue before starting feature work a contributor could duplicate.
- **Keep it light:** simple fixes and PR-only maintenance need no issue or milestone.
- **Keep it honest:** assign an issue only when someone starts, and leave dates unset until agreed. Link records instead of copying their state. Do not count an issue and its PR as two outcomes.
- **Review weekly:** cover changes, blockers, decisions and the next milestone, and check for superseded items before adding new ones. No new meeting or scheduled monitor is implied.

The private [board](https://github.com/orgs/sweatco/projects/16) is an optional view of the same issues; [how it is fed](project-access-and-automation.md#the-board) is automatic. The [initial disposition review](../plans/20261111-issue-disposition.md) is a dated snapshot whose classification remains a proposal, not a second backlog.

## Agents: required routine

The user owns priorities, scope and acceptance. Agents keep the records; they do not decide technical direction through tracking or invent priorities, owners, dates, acceptance or permission to implement.

1. **Resume:** find the owning issue, its state and next action.
2. **Capture:** when research yields an implementation idea, prepare a Feature issue with source links. Keep declined ideas declined.
3. **Decide:** record the user's decision to proceed and the agreed scope in that issue.
4. **Track:** reuse existing issues; prepare missing ones with the [task form](../../.github/ISSUE_TEMPLATE/task.yml). Link dependencies and use milestones for agreed outcomes.
5. **Maintain:** update decisions, blockers and next actions in the issue as work progresses.
6. **Accept:** link delivery evidence and record the user's acceptance before preparing closure. Keep remaining work visible.

Rules that always apply:

- **Approval:** each GitHub mutation, Git remote write or release needs explicit approval in the current chat. Prepare related edits as one concrete, reviewable batch. An approved automation may run its defined rules; its setup authorizes nothing broader.
- **Human decisions:** issue closures and scope changes need a recorded human decision.
- **Access:** follow [the access rules](project-access-and-automation.md#who-may-write) before any upstream access. Only a `sweatco/archie-hq` checkout writes tracking records.
- **Restraint:** respect analysis-only and no-recording requests. Pending tracking approval must not block otherwise authorized work.
- **Limits:** this routine creates no background monitoring and no authority for paid runs or deployments.
- **Tools:** use the `github-issues` skill for issue operations. Prefer connected tools; use authenticated `gh` for missing Project capabilities.
