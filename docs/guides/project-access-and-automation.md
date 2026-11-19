# Project access rules and automation

Reference for maintainers and agents. [Managing Archie development](project-management.md) explains the process; this page covers who may write tracking records, what enters the board, what GitHub automates and how to check the board.

## Who may write

Only the canonical repository, `sweatco/archie-hq` (GitHub repository ID `1120227357`), writes to the shared Project and its tracking records. Any branch or worktree of that repository qualifies. A fork never does, even with an `upstream` remote pointing to Archie, credentials with Project access or a copied `.github/project.json`.

- **Check first:** run `node tools/pm/check-repository.mjs` before upstream access or an approved write batch, and again after changing repository context. It verifies the checkout's `origin`, GitHub's non-fork repository identity and, in Actions, the repository name and ID. Stop on failure or unknown identity. The check applies whichever tool makes the call, including a direct MCP call.
- **Forks:** a fork's records and agent sessions must not create or change upstream Project items, drafts, fields, views, issues, milestones, labels or assignments. A fork may keep local artifacts when requested and submit contributions for upstream review.
- **Permissions are the boundary:** never give Project-write credentials to a fork or run fork-controlled code in a privileged upstream workflow.

## What enters the board

| Item | How it enters |
|---|---|
| Open issue in the canonical repository | Automatically, into Backlog |
| Sub-issue in the canonical repository | Through the same issue intake |
| Pull request, including a same-repository one | Only with a maintainer's explicit approval for that PR |
| Issue from another repository | Never; link it as a reference |

Verify an item's owning repository before adding it by hand. Keep unfiltered sub-issue auto-add disabled, because sub-issues can belong to other repositories.

Pull requests are never added automatically. GitHub's [native intake filters](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically) cannot tell head repositories apart, so automatic intake is limited to `is:issue is:open`. This gives a strict boundary without another credential or privileged workflow. For each PR:

- Check the base and head repository metadata. A fork-origin PR stays an external submission until admitted, and an unknown or deleted head is not same-repository work.
- Get approval from an upstream maintainer to add that PR. Approval to open or review it, a label or passing CI is not intake approval.
- Record the decision in the owning record or the approved batch. A canonical agent may then add approved PRs in a batch; a fork session still may not.

These rules cover new intake. Existing Project items stay unless a separate disposition is approved.

## What GitHub automates

Native Project workflows run on the Project's own access, with no extra PAT or GitHub App secret.

| Event | Result |
|---|---|
| Canonical issue opened | Added in Backlog |
| Pull request linked to an issue | In progress |
| Pull request merged | Review |
| Issue reopened | Backlog |
| Completed issue closed for one month | Archived |

Three automations stay off:

- **Item closed → Done:** a closure does not say why the item closed.
- **Done → close issue:** a board edit must not close an issue.
- **Archiving merged PRs:** they can still await rollout or acceptance.

Record acceptance explicitly before setting Done or closing an issue as completed.

After editing a native workflow, inspect the saved settings, read back the enabled states and exercise a relevant event. Record any transition you did not test.

## Health checks

Both checks only read. They make no model calls, post no comments and change no records.

| | Weekly report | Board audit |
|---|---|---|
| Runs | [Project health workflow](../../.github/workflows/project-health.yml): Mondays 09:00 UTC or manual dispatch | On demand: `node tools/pm/issue-health.mjs --project` in an authorized local session |
| Reads | Repository records: attention labels, owners, milestones and aging | The same, plus the board's Status, Initiative and membership |
| Credentials | Repository-scoped, read-only `GITHUB_TOKEN` | The existing GitHub CLI login; refuses to run in Actions |
| Scope guard | Canonical repository name and ID; fork copies skip the job | Checkout scope, then the Project ID, number and URL on every page |

Without `--project` the command produces the weekly report locally. Add `--output <file>` to save either report.

The board audit:

- **Flags** contradictions between status, ownership and attention labels; issues whose open or closed state disagrees with their Status; merged or closed PRs in the wrong column; and non-canonical records.
- **Notes, without flagging,** a missing Initiative or missing board membership. PR intake is maintainer-controlled, and the declined historical classification is not a repair request.
- **Skips** archived items and Project drafts.
- **Fails** on access errors, missing fields, identity mismatches and incomplete pagination, and reports hidden content as incomplete, rather than claiming consistency.

Limits:

- Findings are review input. They are not a gate and do not authorize changing records; every write keeps the [approval rules](project-management.md#agents-required-routine).
- The audit cannot prove accepted scope, human acceptance, deployment or intake approval.
- It does not narrow the login's permissions and is not a security sandbox. Do not copy an interactive CLI login into Actions.
- No extra App, token, key or secret is configured, so unattended board checks wait for a new user decision.

After changing the tooling, run `node --test tools/pm/*.test.mjs`, then `npm run check` before handoff.

## Installed skills

Canonical copies live in `.agents/skills/`; `.claude/skills/` links to the same files. A short Claude rule points to the canonical guidance instead of duplicating it.

| Skill | Upstream revision | License |
|---|---|---|
| `github-issues` | [github/awesome-copilot @ eaaffd5](https://github.com/github/awesome-copilot/tree/eaaffd5d020b756a2777a4b1b161d2bdc126d9a0/skills/github-issues) | [MIT](../../.agents/skills/github-issues/LICENSE) |

Keep repository policy in these guides, not in skills. Preserve licenses when updating an upstream skill, then verify discovery and link targets. Install locally developed skills from the persistent main checkout, never a task worktree.
