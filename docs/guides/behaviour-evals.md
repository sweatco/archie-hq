# Behaviour evals

Tools for grading how the PM behaved in a task: offline, from a finished task's folder alone, or live, by running the same cases on a base and a candidate instance and reporting the change. They are Stages 0 and 2 of the [behaviour evals plan](../plans/20261118-behaviour-evals.md), tracked by issues [#393](https://github.com/sweatco/archie-hq/issues/393) and [#395](https://github.com/sweatco/archie-hq/issues/395). [promptfoo](https://www.promptfoo.dev/) runs the cases, trials and reports; this repository adds what is specific to Archie: the session record, a replay provider, a live provider, the code graders and the comparison script.

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

- `turns`: each inbound message and the PM's replies, from `shared/events.jsonl`. Messages the engine posts to the user itself, such as pause notices and reminders, are not replies.
- `toolCalls`: every tool call in order, with the agent that made it, the skill or worker type, and whether it failed. Read from the transcripts under `claude/<agent>/session/` with the SDK's `getSessionMessages`, `listSubagents` and `getSubagentMessages`, and ordered by the timestamp of the transcript line that made each call, so a delegated worker's calls sit among the PM calls made at the same time.
- `complete`: false when a call in the raw transcripts was not returned by the reader, or when a session named in `usage.jsonl` or `metadata.json` has no transcript. The reasons go to stderr.
- `terminalState`: the task status from `metadata.json`, or `approval_requested` while an approval is pending. The engine stops a task to wait for an approval, so a stopped task with a pending request reports `approval_requested`.
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
- sends HTTP(S) requests to a closed local proxy, because promptfoo 0.125.1 still posts one "telemetry disabled" event with telemetry off, and the replay provider needs no network. It sets the proxy variables and `NODE_USE_ENV_PROXY`, which on Node 24 also routes Node's built-in `fetch`, `WebSocket` and `http`/`https` requests on the default agent, in promptfoo and in Node processes it starts. A [live run](#paired-runs-on-live-instances) exempts the `host:port` of each instance it names, and nothing else;
- refuses a data directory inside the repository, and fails with exit code 3 if a file git sees in the checkout, tracked or untracked but not ignored, was created or changed during the run. Ignored paths such as `workdir/` and `node_modules/`, `.git`, nested repositories and deletions are not checked, because a running instance or another tool may write there at any time.

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

Do not use promptfoo's `trajectory:*` assertions: they read OpenTelemetry traces, which the providers do not produce.

## Paired runs on live instances

A paired run plays the same cases on a base and a candidate [eval instance](../../.claude/skills/archie-e2e/SKILL.md#5-eval-profile--a-hermetic-instance-for-behaviour-evals) and reports the change against base. The two instances are two live providers in one promptfoo run, and the trials are promptfoo's repeats.

A run spends model credit on every trial, so the wrapper refuses one without a spend cap.

1. Check out the base and the candidate ref in two directories, and in each run `npm ci` and `npx tsx tools/e2e/boot.ts --profile eval`, one after the other. Note the `ARCHIE_URL=` line each boot prints.
2. Run the cases through the wrapper, from a checkout that has promptfoo installed:

   ```bash
   npx tsx tools/evals/promptfoo/run.ts --data-dir <private-dir> \
     --instance base=http://localhost:3001,<base checkout> \
     --instance candidate=http://localhost:3002,<candidate checkout> \
     --spend-cap-usd 2 \
     tools/evals/promptfoo/paired.promptfooconfig.yaml -- --repeat 3
   ```

3. Report the change:

   ```bash
   npx tsx tools/evals/promptfoo/compare.ts <private-dir>/results-<stamp>.json
   ```

4. Tear both instances down with `npx tsx tools/e2e/teardown.ts --profile eval` in each checkout.

`--instance <label>=<url>,<checkout>` names an instance for the providers and opens the wrapper's proxy for that URL only. The URL must be plain HTTP on `localhost` or `127.0.0.1` with a port. Two labels may name the same instance, which compares it with itself.

### Live provider

`file://live-provider.ts` drives one instance over the HTTP API, with no agent session and no debug MCP. For each trial it creates a task from the case's first turn, sends the later turns as messages, and after each turn follows the task's events until it completes, stops or asks for an approval. It answers the approvals the case specifies, then builds the session record from the task folder in the instance's checkout. The response has the replay provider's shape, so the same assertions grade it, plus `metadata.live`: the instance, the commit it attests on `/health`, the SDK version in the checkout's lockfile, how the trial ended, whether its cost is complete, and the spend so far. `record.eval` holds the case, that commit and promptfoo's zero-based repeat number.

Before it reads a trial's record, the provider waits up to `recordSettleSeconds` for the usage of the PM's last turn: the engine writes a turn's usage when the SDK reports its result, which can come after the event that settled the task. The usage is in when some usage record is at least as new as the last `agent:active` event. If the wait runs out, `metadata.live.costComplete` is false.

Nothing ties a URL to a checkout before a task exists, since two worktrees of one commit attest the same ref. So a provider creates its first tasks one at a time until one shows up as a folder in the checkout. If the first does not, within `taskFolderWaitSeconds`, the URL belongs to another checkout: that trial and every later one on the provider fail with a message naming both, and no further task is created.

| `config` | Default | Meaning |
| --- | --- | --- |
| `instance` | required | Label of a `--instance` given to the wrapper |
| `maxConcurrency` | 6 | Tasks run at once on the instance. Six is the most measured on one instance |
| `trialReserveUsd` | 0.5 | What a trial is assumed to cost before one has been measured |
| `turnTimeoutSeconds` | 600 | How long one turn, approvals included, may take to settle |
| `timedOutHoldSeconds` | 900 | How long a timed-out task keeps its place on the instance while it is still running |
| `recordSettleSeconds` | 60 | How long to wait for the usage of the PM's last turn once a trial has ended |
| `taskFolderWaitSeconds` | 5 | How long a created task's folder may take to appear in the checkout |
| `pollIntervalMs` | 2000 | Pause between reads while waiting on a task: its events, then its folder |

promptfoo's own limit (`evaluateOptions.maxConcurrency`, or `-j`) counts both arms together, so the paired config sets it to 12.

A trial ends without a record, as a promptfoo error, when the spend cap refuses it, the instance cannot be reached, or the URL does not belong to the checkout.

A turn that does not settle in time ends the trial as `timed_out` in `metadata.live.end`: no later turn or approval is played. The API has no way to stop a task, so the trial keeps its place on the instance until the task completes, stops or parks on an approval, or until `timedOutHoldSeconds` have passed, and only then is the record read as it stands. `metadata.live.stillRunning` is true when the hold ran out first; each such task then runs on the instance beyond its `maxConcurrency`.

### Cases

A case is a promptfoo test. [paired.promptfooconfig.yaml](../../tools/evals/promptfoo/paired.promptfooconfig.yaml) holds two smoke cases on the `orders` fixture plugin.

- `vars.caseId` names the case in the report.
- `vars.turns` lists the messages in order. A turn's `approvals` lists the answers to the approvals it is expected to raise, each as `{ type, approve }` with a type of `tool_call`, `edit_mode`, `research_budget`, `trigger` or `max_mode`, and each used once. An approval with no answer ends the trial in `approval_requested`.
- `assert` holds the assertions above; `metadata.guards` names the input the case protects.
- The tool fixtures are the plugins every eval instance mounts from `examples/plugins`.

### Spend cap

The providers of a run share one budget. A trial's cost is known only after it ran, so each trial first reserves an allowance, the higher of `trialReserveUsd` and the costliest trial so far, and starts only if the cap covers what is spent, what is reserved by trials in flight, and that allowance. A trial waits while trials in flight hold the room, and is refused once the spend alone leaves none.

A trial's recorded cost is taken as it is only when the trial settled and its cost is complete. A timed-out trial, a trial whose last usage never arrived and a trial that failed after its task was created count at the recorded cost or the allowance, whichever is higher, and a trial with no recorded cost counts at its allowance. `metadata.live.spend` holds both the recorded `trialUsd` and the `countedUsd`.

Each trial prints its cost and the running total, and each provider prints its total when the run ends. The comparison report repeats the spend per arm.

### Comparing

`compare.ts` reads the results file and, for each case and candidate arm, reports candidate minus base: the share of trials that passed every assertion, each assertion's pass rate, and the mean cost, replies, words and tool calls. It applies no noise floor or tolerance and has no pass mark. A trial is graded when it has a record, whether its assertions passed or failed; a trial without one, because it was not started or broke, is left out of the rates and counted in the notes. A case with no graded trial in an arm gets no change, and arms that ran different models or SDK versions are noted. The report is written as JSON and Markdown to `--out-dir`, by default the ignored `eval-reports/`, and holds counts, rates and assertion text only.

`--base <label>` names the base arm when it is not `base`.

### Reusing base results

To skip the base arm, run only the candidate and compare against an earlier results file:

```bash
npx tsx tools/evals/promptfoo/run.ts --data-dir <private-dir> \
  --instance candidate=http://localhost:3002,<candidate checkout> --spend-cap-usd 1 \
  tools/evals/promptfoo/paired.promptfooconfig.yaml -- --filter-providers candidate --repeat 3
npx tsx tools/evals/promptfoo/compare.ts <private-dir>/results-<stamp>.json \
  --baseline <private-dir>/results-<earlier stamp>.json --base-ref <base commit>
```

A case reuses the earlier base trials only when they ran on exactly `--base-ref` (the full commit the instance attested, never a `-dirty` one), the case's vars and assertions are unchanged, and the models and SDK version match the candidate's. Otherwise the report says a base run is needed for that case and the command exits 3. A change to the grader code in `assertions.ts` is not detected.

## Pulling task folders

`scripts/pull-tasks.sh` pulls chosen task folders by id or by day. With `--container` it reads them from inside a running container; `--no-files` also leaves out `shared/attachments` and `shared/artifacts`. Repository worktrees are always left out unless `--include-repos` is given.

```bash
scripts/pull-tasks.sh -H <ssh-host> -c <container> --no-files -o <private-dir> --day 2026-11-18
```

Run it with `-n` first to list what would be pulled. Always pass `-o` with a directory in the private location; the default output is inside the checkout.

## Limits

- The record depends on the SDK's reader and the CLI's transcript layout. A layout change shows up as `complete: false`.
- Call order across sessions and workers comes from transcript timestamps, which have millisecond resolution. Calls stamped in the same millisecond are ordered by session and worker id.
- Approval answers are not visible in the trajectory, because Slack approvals emit no resolution event.
- The wrapper's proxy stops promptfoo's HTTP(S) requests, so a model-graded assertion such as `llm-rubric` cannot run through it yet.
- The spend cap is checked before a trial starts. The API cannot stop a task, at a cost or at all, so a trial that costs more than its allowance can take the run over the cap by the difference.
- A task that is still running when its hold runs out goes on spending. The budget has counted it at its allowance or its recorded cost, whichever was higher; anything it spends beyond that is not counted.
- A turn that is aborted writes no usage, so its cost is never recorded. The trial then shows `costComplete: false` and counts at its allowance at least.
- Trials on one instance share its machine and its model rate limits. Concurrency above six per instance is unmeasured.
- The proxy is not a sandbox. Raw TCP and UDP sockets, HTTP/2, an `http`/`https` request with its own `Agent` (including `agent: false`), DNS lookups, and child processes that ignore the proxy variables still reach the network. Providers and assertion files must not open connections of their own.
