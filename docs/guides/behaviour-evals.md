# Behaviour evals

Tools for grading how the PM behaves in a finished task, offline, from the task's folder alone. They are Stage 0 of the [behaviour evals plan](../plans/20261118-behaviour-evals.md), tracked by [issue #393](https://github.com/sweatco/archie-hq/issues/393). The model judge and the production report are not built yet.

## Privacy rule

Production task folders contain people's messages, tool output and file contents. They, and anything built from their text, never enter the repository or CI.

- Keep pulled folders, records and per-task results in the private evaluation location outside the repository. The ignored `workdir/` inside a checkout does not count.
- Reports carry counts and grades only, never message or tool text.
- Delete pulled copies once the report is written, unless the maintainer decides otherwise.
- Test fixtures are written by hand. A case mined from production is rewritten synthetically before it enters the repository.

## Building a record

```bash
npx tsx tools/evals/record.ts <task-folder> [--source production|eval] [assertions]
```

`<task-folder>` is a `sessions/<taskId>/` folder. The command prints the session record as JSON on stdout. The record contains message text, so for a production folder redirect it into the private location.

The record holds:

- `turns`: each inbound message and the PM's replies, from `shared/events.jsonl`.
- `toolCalls`: every tool call in order, with the agent that made it, the skill or worker type, and whether it failed. Read from the transcripts under `claude/<agent>/session/` with the SDK's `getSessionMessages`, `listSubagents` and `getSubagentMessages`. A delegated worker's calls follow the `Agent` call that started it.
- `complete`: false when a call in the raw transcripts was not returned by the reader, or when a session named in `usage.jsonl` or `metadata.json` has no transcript. The reasons go to stderr.
- `terminalState`: the task status from `metadata.json`, or `approval_requested` while an approval is pending.
- `usage`: SDK-reported cost from `shared/usage.jsonl`, reduced per query as in `src/agents/task-usage.ts`, and the models used. Cost is `null` when no usage was recorded.
- `manifest`: always `unknown` until the session manifest exists.

Every session the task ran is read, because the PM session is forked after a refusal and replaced for max mode. Calls repeated in a fork count once.

A call counts as failed when its result has the error flag or its text starts with `Error:`, which is how Archie's own tools report many failures.

## Graders

The record always carries three measures: `reply_count`, `word_count` (all replies) and `cost_usd`. Assertions add verdicts:

| Option | Passes when |
| --- | --- |
| `--expect-state STATE` | The task ended in `STATE` |
| `--called TOOL` | `TOOL` was called at least once |
| `--not-called TOOL` | `TOOL` was never called and the record is complete |
| `--order A,B,C` | The tools were called in this order, not necessarily adjacent |
| `--approval-before APPROVAL,MUTATION` | Every successful `MUTATION` follows its own `APPROVAL` call, and the record is complete |

`TOOL` is written as it prints: `Skill(core:triggers)`, `Agent(helper:assistant)`, a full name, or an MCP tool's short name such as `report_completion`. Each option can repeat. The command exits 1 when an assertion fails.

`--approval-before` sees only the request, not the human's answer. Each approval request covers one mutation, as merge and tool-call grants do; check a task-lifetime approval such as edit mode with `--order`. A failed call to the mutation tool counts as its approval request, which covers gated tools whose first attempt is denied.

For example, on the synthetic test fixture:

```bash
npx tsx tools/evals/record.ts tools/evals/fixtures/task-20260101-0900-evalfx --source eval \
  --called 'Skill(core:triggers)' --order 'Skill(core:triggers),propose_trigger,report_completion'
```

## Pulling task folders

`scripts/pull-tasks.sh` pulls chosen task folders by id or by day. With `--container` it reads them from inside a running container; `--no-files` also leaves out `shared/attachments` and `shared/artifacts`. Repository worktrees are always left out unless `--include-repos` is given.

```bash
scripts/pull-tasks.sh -H <ssh-host> -c <container> --no-files -o <private-dir> --day 2026-11-18
```

Run it with `-n` first to list what would be pulled. Always pass `-o` with a directory in the private location; the default output is inside the checkout.

## Limits

- The record depends on the SDK's reader and the CLI's transcript layout. A layout change shows up as `complete: false`.
- Worker calls are placed after the call that started the worker, so a background worker's calls may in fact overlap later PM calls.
- Approval answers are not visible in the trajectory, because Slack approvals emit no resolution event.
