# Project access rules and automation

Reference for maintainers and agents. [Managing Archie development](project-management.md) explains the process; this page covers who may write tracking records and how the board is fed.

## Who may write

Only the canonical repository, `sweatco/archie-hq` (GitHub repository ID `1120227357`), writes to the shared Project and its tracking records. Any branch or worktree of that repository qualifies. A fork never does, even with an `upstream` remote pointing to Archie or credentials with Project access.

- **Check first:** confirm the checkout's `origin` is `sweatco/archie-hq` before upstream access or an approved write batch, and again after changing repository context. Stop when it is a fork or unknown. This applies whichever tool makes the call, including a direct MCP call.
- **Forks:** a fork's records and agent sessions must not create or change upstream Project items, drafts, fields, views, issues, milestones, labels or assignments. A fork may keep local artifacts when requested and submit contributions for upstream review.
- **Permissions are the boundary:** never give Project-write credentials to a fork or run fork-controlled code in a privileged upstream workflow.

## The board

The private [Archie project](https://github.com/orgs/sweatco/projects/16) is an optional maintainer view. The process reads state from issues, so nothing has to be set on the board by hand.

| Item | How it enters |
|---|---|
| Open issue in the canonical repository, including a sub-issue | Automatically, through `is:issue is:open` |
| Pull request | Not added; it shows through its linked issue |
| Issue from another repository | Never; link it as a reference |

Keep unfiltered sub-issue auto-add disabled, because sub-issues can belong to other repositories.

Native Project workflows keep Status in step. They run on the Project's own access, with no extra PAT or GitHub App secret.

| Event | Status |
|---|---|
| Issue opened | Backlog |
| Pull request linked to the issue | In progress |
| Issue closed | Done |
| Issue reopened | Backlog |
| Closed for one month | Archived |

A closed issue lands in Done whatever the reason; the close reason on the issue tells completed from not planned. "Done → close issue" stays off, because a board edit must not close an issue.

After editing a native workflow, inspect the saved settings, read back the enabled states and exercise a relevant event. Record any transition you did not test.

## Installed skills

Canonical copies live in `.agents/skills/`; `.claude/skills/` links to the same files. A short Claude rule points to the canonical guidance instead of duplicating it.

| Skill | Upstream revision | License |
|---|---|---|
| `github-issues` | [github/awesome-copilot @ eaaffd5](https://github.com/github/awesome-copilot/tree/eaaffd5d020b756a2777a4b1b161d2bdc126d9a0/skills/github-issues) | [MIT](../../.agents/skills/github-issues/LICENSE) |

Keep repository policy in these guides, not in skills. Preserve licenses when updating an upstream skill, then verify discovery and link targets. Install locally developed skills from the persistent main checkout, never a task worktree.
