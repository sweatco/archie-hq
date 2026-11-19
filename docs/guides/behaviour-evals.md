# Behaviour evals

Tools for grading how the PM behaved in a finished task, offline, from the task's folder alone. They are Stage 0 of the [behaviour evals plan](../plans/20261118-behaviour-evals.md), tracked by [issue #393](https://github.com/sweatco/archie-hq/issues/393). [promptfoo](https://www.promptfoo.dev/) runs the cases, trials and reports; this repository adds what is specific to Archie: the session record, a replay provider and the code graders.

## Privacy rule

Production task folders contain people's messages, tool output and file contents. They, and anything built from their text, never enter the repository or CI.

- Keep pulled folders, records, promptfoo configs for production samples, and promptfoo's results in the private evaluation location outside the repository. The ignored `workdir/` inside a checkout does not count.
- Run promptfoo only through `tools/evals/promptfoo/run.ts`, which keeps its state there and never shares results.
- Reports carry counts and grades only, never message or tool text.
- Delete pulled copies once the report is written, unless the maintainer decides otherwise.
- Test fixtures are written by hand. A case mined from production is rewritten synthetically before it enters the repository.

## Building a record

```bash
npx tsx tools/evals/record.ts <task-folder> [--source production|eval]
```

`<task-folder>` is a `sessions/<taskId>/` folder. The command prints the session record as JSON on stdout. The record contains message text, so for a production folder redirect it into the private location.

The record holds:

- `turns`: each inbound message and the PM's replies, from `shared/events.jsonl`.
- `toolCalls`: every tool call in order, with the agent that made it, the skill or worker type, and whether it failed. Read from the transcripts under `claude/<agent>/session/` with the SDK's `getSessionMessages`, `listSubagents` and `getSubagentMessages`. A delegated worker's calls follow the `Agent` call that started it.
- `complete`: false when a call in the raw transcripts was not returned by the reader, or when a session named in `usage.jsonl` or `metadata.json` has no transcript. The reasons go to stderr.
- `terminalState`: the task status from `metadata.json`, or `approval_requested` while an approval is pending.
- `usage`: SDK-reported cost from `shared/usage.jsonl`, reduced per query as in `src/agents/task-usage.ts`, and the models used. Cost is `null` when no usage was recorded.
- `manifest`: always `unknown` until the session manifest exists.

Every session the task ran is read, because the PM session is forked after a refusal and replaced for max mode. Calls repeated in a fork count once. A call counts as failed when its result has the error flag or its text starts with `Error:`, which is how Archie's own tools report many failures.

## Grading with promptfoo

promptfoo is pinned in its own package under `tools/evals/promptfoo/`, outside the root install, because it adds about 700 MB. Install it once per checkout:

```bash
npm ci --prefix tools/evals/promptfoo
```

Then run a config through the wrapper, giving a private directory for promptfoo's results, database, cache and logs:

```bash
npx tsx tools/evals/promptfoo/run.ts --data-dir <private-dir> tools/evals/promptfoo/fixture.promptfooconfig.yaml
```

Options after `--` go to `promptfoo eval`, for example `-- --repeat 3`. The wrapper:

- sets `PROMPTFOO_CONFIG_DIR`, `PROMPTFOO_CACHE_PATH` and `PROMPTFOO_LOG_DIR` under `<private-dir>/promptfoo` and writes a JSON results file to `<private-dir>`;
- sets `PROMPTFOO_DISABLE_TELEMETRY`, `PROMPTFOO_DISABLE_UPDATE` and `PROMPTFOO_DISABLE_SHARING`, passes `--no-share` and refuses `--share`;
- points promptfoo's HTTP proxy at a closed local port, because promptfoo 0.125.1 still posts one "telemetry disabled" event with telemetry off, and the replay provider needs no network;
- refuses a data directory inside the repository, and fails with exit code 3 if any file under the repository was created or changed during the run.

[fixture.promptfooconfig.yaml](../../tools/evals/promptfoo/fixture.promptfooconfig.yaml) is the reference config. Paths in a config are relative to the config file.

### Replay provider

`file://replay-provider.ts` makes no model call. Each test's `taskDir` var names a task folder; the provider builds its record and returns:

- `output`: the PM's replies, so text assertions and later `llm-rubric` read what the user saw;
- `cost`: the recorded cost, which promptfoo's `cost` assertion checks;
- `metadata`: the full `record`, `gaps`, the printed `toolSequence`, `skillCalls` for promptfoo's `skill-used` assertion, and `measures` (reply and word counts) for comparing runs against base.

### Assertions

Use promptfoo's `skill-used` for skills and `cost` for cost. The Archie-specific checks are `javascript` assertions in `assertions.ts`, with arguments in `config`:

| Value | `config` | Passes when |
| --- | --- | --- |
| `file://assertions.ts:terminalState` | `state` | The task ended in that state |
| `file://assertions.ts:called` | `tool` | The tool was called at least once |
| `file://assertions.ts:notCalled` | `tool` | The tool was never called and the record is complete |
| `file://assertions.ts:order` | `tools` (list) | The tools were called in this order, not necessarily adjacent |
| `file://assertions.ts:approvalBeforeMutation` | `approval`, `mutation` | Every successful mutation follows its own approval call, and the record is complete |

A tool is written as it prints: `Skill(core:triggers)`, `Agent(helper:assistant)`, a full name, or an MCP tool's short name such as `report_completion`.

`approvalBeforeMutation` sees only the request, not the human's answer. Each approval request covers one mutation, as merge and tool-call grants do; check a task-lifetime approval such as edit mode with `order`. A failed call to the mutation tool counts as its approval request, which covers gated tools whose first attempt is denied.

Do not use promptfoo's `trajectory:*` assertions: they read OpenTelemetry traces, which the replay provider does not produce.

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
- The wrapper blocks all of promptfoo's network access, so a model-graded assertion such as `llm-rubric` cannot run through it yet.
