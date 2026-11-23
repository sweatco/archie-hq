# Proposal: behaviour evals for prompt and skill changes

> **Status:** Accepted for planning on 2026-11-18. The [plan](../plans/20261118-behaviour-evals.md) owns the design, stages and tracking; this document keeps the research and the decision record. Tracked by milestones [4](https://github.com/sweatco/archie-hq/milestone/4) and [5](https://github.com/sweatco/archie-hq/milestone/5).

## Problem

Archie's behaviour is set mostly by prose, and no automated check covers it. Unit tests mock the SDK, and the three live E2E recipes verify plumbing (task lifecycle, approval gates), not how the PM answers.

- Merged behaviour changes [#261](https://github.com/sweatco/archie-hq/pull/261), [#303](https://github.com/sweatco/archie-hq/pull/303), [#344](https://github.com/sweatco/archie-hq/pull/344), [#347](https://github.com/sweatco/archie-hq/pull/347) and [#381](https://github.com/sweatco/archie-hq/pull/381) each claim a behaviour that nothing re-checks.
- The [concise pilot](../plans/20260926-prompt-only-concise-pilot.md) compared five arms by hand, one run per arm, and concluded that single runs do not establish an error rate. Its fixtures were never committed.
- An SDK bump replaces the CLI's own system prompt with no behavioural signal.

## What shapes a PM session

| Input | Owner | Reproducible in this repo |
| --- | --- | --- |
| `prompts/pm-agent.md` | Engine | Yes |
| Five core skills in `core-plugin/skills/` | Engine | Yes |
| Tool descriptions in `src/agents/tools.ts` | Engine | Yes |
| Dynamic sections built in `src/agents/spawn.ts` (task context, people, pins, canvas, trigger data, notices) | Engine code, task state | Yes, from fixture task state |
| Deployment plugins repo (agents, skills, `pm.md`, `.mcp.json`) | Separate repository | No |
| Memory injection and memory tools (both default off) | Store contents | Only with a seeded store |
| Model, effort, SDK and CLI version | Configuration | Yes, when pinned |

## Recommended design

### A baseline plus single-factor arms, not a matrix

Cost is cases × trials × arms. A full memory × plugins × model matrix multiplies cost by 8 or more and makes a failure hard to attribute.

| Arm | Configuration | Question it answers | Cadence |
| --- | --- | --- | --- |
| **Baseline** | Engine prompt, core skills, pinned fixture plugins, memory off, pinned model | Did this engine change alter behaviour? | Every qualifying change |
| **Memory** | Baseline plus a seeded synthetic store, injection and tools on | Does memory interfere with conduct (scope, verbosity, stale or leaked facts)? | Memory changes, nightly |
| **Full plugins** | Baseline with the real plugins repo | Does the PM still pick the right skill or agent among many? | Plugins repo changes, nightly |
| **Model or SDK** | Baseline on the candidate version | Is a bump safe? | Before each bump |

- **Memory stays out of the baseline.** Its contents are stateful and deployment-specific, and an engine-prompt diff should be the only variable. It is off by default in code but on in production, so the baseline is not the configuration production runs. The memory arm measures interference only; uplift belongs to the [Memory evaluation](https://github.com/sweatco/archie-hq/milestone/1).
- **The full skill set stays out of the baseline.** It lives in another repository, changes on its own schedule and needs credentials. The runner should accept a plugins directory so that repository can run the same harness with its own cases.

### Compare against main instead of scoring

Run the same cases on the base ref and the candidate, and report the per-case change. The pilot's control arm also failed the factuality check, so an absolute gate would block every change.

### Substrate

A live instance driven through the API channel, as `archie-e2e` does: the real spawn path, no Slack. The driver is a script over HTTP, like `tools/e2e/tool-gate-check.ts`, and is shared with scripted E2E scenarios. A stub MCP server (the `gatecheck` pattern) supplies fixed tool results, which the pilot lacked. Since 2026-11-19 the driver is a promptfoo custom provider, and promptfoo supplies the case files, trials, assertions and report.

### Graders

- **Code:** terminal state, post count, word count, tools and skills called, approval before mutation, cost and latency.
- **Model judge with a rubric:** requested facts present, unsupported claims, scope kept, result first.
- **Human calibration** of the judge on a small sample.

Grading the trajectory needs telemetry the engine does not record yet; see [Required changes](#required-changes).

### Variance

At least three trials per case. Hard invariants (for example, no merge without approval) must hold in every trial. Soft metrics (length, factuality rate) are reported as a change against main with a tolerance.

### Cadence

On demand first. Later: PRs touching `prompts/`, `core-plugin/`, `src/agents/tools.ts`, `spawn.ts`, `prompts.ts` or the SDK pin, plus a nightly run on main for model and CLI drift. CI runs are paid and need a separate decision.

## Required changes

Findings from the code at `29290acc`, checked on 2026-11-18 against a live instance booted from that commit with example plugins and no Slack or GitHub credentials. Six synthetic tasks were created at once through the API.

- **Concurrency.** All six ran together (`/health` reported six active tasks) and completed in 10 to 15 seconds with correct, separate replies. Total cost was $0.75. Production memory records also show up to six tasks starting within a minute. More than six is untested.
- **Transcript reading.** With `CLAUDE_CONFIG_DIR` set to `sessions/<id>/claude/pm/session`, the SDK's `getSessionMessages` returned each task's tool sequence, including the skill name, the subagent type and MCP tool names. `listSubagents` and `getSubagentMessages` returned the delegated worker's messages.
- **Limits of the transcript.** It holds no `init` message, so the session manifest (T2) is still needed. Archie's own tools report failures as text without the error flag: `list_available_repos` failed unflagged, while `find_slack_user` was flagged.
- **API-channel reach.** Slack tools are callable and fail with "Slack client not initialized". `propose_trigger` refuses because a trigger needs a Slack destination. Without Slack the memory layer does not initialise at all ("Slack auth did not provide a team ID").

A sample of five completed production tasks from 2026-11-18 was read the same way and then deleted; counts only:

- **Same layout and reader.** Each had one PM transcript written by CLI 2.1.321, and the SDK reader returned its tool calls and delegated workers' messages.
- **Events confirm T1.** No event type records a tool, skill or subagent call in structured form.
- **Production differs from the baseline arm.** All five were Slack tasks. Memory tools were available in all and memory was injected into the prompt in three, adding roughly a third to its length. All five invoked a plugin skill and four called a plugin MCP server; none invoked a core skill.
- **Real tasks are multi-turn and costly.** Three to eleven inbound messages, 13 to 27 tool calls and $1.55 to $8.51 per task, against about $0.12 for the synthetic single-turn tasks above.
- **The raw transcript records the request.** `api-request-shape` lines hold the system prompt blocks and tool definitions sent to the model, with a hash, and `api-request` lines hold the model parameters. This is CLI-internal and not exposed by the reader.

### Architecture

| # | Finding | Change | Needed for |
| --- | --- | --- | --- |
| A1 | `e2e:prepare` links the worktree's `workdir` to the main checkout's: real plugins, memory and channel store. `docker-compose.yml` mounts `./workdir` at a fixed path. | An eval profile for boot: a fresh `ARCHIE_WORKDIR` built from fixtures, with memory and proactivity off and no Slack or GitHub tokens. | Baseline |
| A2 | The prompt, core plugin, model, memory flags and plugins directory are process-wide (environment or code-relative paths). Nothing is per task. | One instance per arm and ref, booted side by side. Do not add per-task overrides; that is a production seam. | Baseline |
| A3 | `POST /api/tasks` returns the task id, so no nonce is needed. The harness is serial-only because parallel runs are unvalidated, though production runs up to six tasks at once. A paired run is about 150 tasks. | A scripted driver over HTTP, starting at a concurrency of about six and raising it only with evidence. | Baseline |
| A4 | API tasks get a `cli` channel. The people, pins, canvas and shared-channel prompt sections never render, and Slack tools are listed but have no client. `SLACK_DRY_RUN` needs real tokens and real inbound events. | A simulated Slack surface: feed `handleSlackEvent` scripted events and back the module-level `WebClient` in `client.ts` with a fixture workspace. | Thread conduct, canvas, multi-user cases, memory arm |
| A5 | Memory is authorised only through a Slack channel scope (`memory_destination`), so an API task never receives injection or memory tools. A seeded store also needs the `.scoped-v1.json` marker ([#351](https://github.com/sweatco/archie-hq/issues/351)). | The memory arm runs on the simulated Slack surface, with a seeded store fixture. | Memory arm |
| A6 | Repo tools return "GitHub is not configured" without a GitHub App client. The E2E recipes open real PRs. | Keep repo-backed behaviour in live E2E for now; a fake GitHub client with a local remote is a later option. | Edit-mode and merge cases |
| A7 | Triggers and reminders read the wall clock; there is no clock seam. | Grade schedules relative to run time; no frozen clock at first. | Trigger cases |

### Telemetry

| # | Finding | Change | Needed for |
| --- | --- | --- | --- |
| T1 | Tool calls reach only the stdout logger; `events.jsonl` has no structured tool-call event, only status lines and background-task entries. Each session transcript sits under `sessions/<id>/claude/<agent>/session/`, and the SDK reads it through a supported API. | The runner reads transcripts through the SDK reader; no engine change. Structured tool-call events become optional production observability. | Trajectory grading |
| T2 | No manifest is persisted. `/health` reports only `git_sha`, and the model appears in `usage.jsonl`. The SDK `init` message already lists model, CLI version, tools, skills, plugins and MCP servers; today it is only checked and logged. | Persist a session manifest event per spawn: the `init` fields, a hash of the assembled system prompt, and the memory flags. Reject a paired comparison whose manifests differ beyond the intended change. | Attribution |
| T3 | `usage.jsonl` already records cost, per-model usage and turns per result. | None in the engine. The runner reads it from the eval workdir. | Cost and latency |

### Data

| # | Need | Notes |
| --- | --- | --- |
| D1 | Case format | Turns, surface fixture, tool fixtures, code assertions, rubric, the input each case guards, and applicable arms. Synthetic content only in the repo. |
| D2 | Result store | Gitignored. One record per trial with its manifest, posts, trajectory, usage and grades. Cache base-ref results by ref, case hash, model and SDK version. |
| D3 | Fixture plugin | A stub MCP server with canned data, following `gatecheck`. |
| D4 | Seeded memory store | Synthetic, for the memory arm. Production layout: a `.scoped-v1.json` marker, `public/` and `private/` channel folders of task and rolling summaries, and `public/entities` and `public/users`. |
| D5 | Budget ledger | Borrow the design from [#228](https://github.com/sweatco/archie-hq/pull/228). |
| D6 | Real-task corpus | Pulled production session folders, kept outside the repo. Used to grade real sessions offline and to mine cases, which are rewritten synthetically before entering the repo. The existing pull scripts take every session or assume an on-disk host; a per-task pull from a container host is missing. |

### Sequence

1. **Session records and graders, offline first** (T1, T3, D6). No engine change and no task execution. One record format built from a task folder (replies, tool sequence, usage), with code graders and a judge, run on pulled production sessions. This covers the production configuration, memory and plugins included, and calibrates the graders on real data.
2. **Eval profile, driver and cases** (A1–A3, D1–D3). No engine change. Runs synthetic cases on a base and a candidate instance and grades them with the same records and graders.
3. **Session manifest** (T2). Makes results attributable to a configuration, from a new engine event or from the request shape already in the transcript.
4. **Simulated Slack** (A4). The largest piece. Unlocks thread conduct, canvas and multi-user cases, and is a prerequisite for the memory arm (A5, D4). Overlaps [#50](https://github.com/sweatco/archie-hq/issues/50).
5. **Repo-backed cases** (A6), if live E2E proves insufficient.

Consequence for the arms above: the memory arm cannot start before step 4. Until then, offline grading is the only view of behaviour with memory, Slack and the real plugins, and it can describe that behaviour but not attribute a change to it.

## Seed cases

About 25 to start:

- One per merged behaviour PR listed above.
- One or two per core skill.
- The edit-mode and merge gate behaviours from the E2E recipes.
- Length and factuality cases rewritten from the pilot's descriptions.

## Related records

- [Memory evaluation milestone](https://github.com/sweatco/archie-hq/milestone/1), [#374](https://github.com/sweatco/archie-hq/issues/374) and draft [#228](https://github.com/sweatco/archie-hq/pull/228): reuse its design (arms, budget ledger, calibration packet). #228 has been a draft since 2026-09-28, so this work should not depend on it merging.
- [archie-e2e skill](../../.claude/skills/archie-e2e/SKILL.md), [#179](https://github.com/sweatco/archie-hq/issues/179) and [#180](https://github.com/sweatco/archie-hq/issues/180).

## Open decisions

1. Accept the baseline-plus-arms design.
2. First milestone scope: an on-demand baseline suite only (recommended), or CI as well.
3. Budget per run, and who authorises paid runs.
4. How soon the memory and full-plugin arms are needed. Production runs with memory injection and tools on and leans on plugin skills, so the baseline arm covers engine conduct only.
5. Whether to add structured tool-call events for production observability. Evals no longer need them.
6. Whether the session manifest should come from a new engine event or from the request shape the CLI already writes to the transcript.
7. Whether a model judge may read pulled production sessions, and under what budget. Code graders need no model call.

## Decisions

- **2026-11-18, maintainer:** the simulated Slack surface is out of the first milestone. The memory arm, Slack-specific cases and repo-backed cases come later and have no milestone yet.
- **2026-11-18, maintainer:** offline grading of pulled production sessions is in the first milestone. The milestone therefore covers sequence steps 1 to 3.
- **2026-11-18, maintainer:** evals should eventually run on pull requests with prompt or architecture changes, only when the maintainer approves the run. Approval uses a protected GitHub Environment with a required reviewer.
- **2026-11-18, maintainer:** a model judge may read pulled production sessions, under a spend cap.
- **2026-11-18, independent review:** the transcript reader follows one message chain, so the record builder must read every session of a task and mark incomplete records; the pull-request gate controls spend on the eval key and is not a security boundary against collaborators.
- **2026-11-19, maintainer:** use promptfoo for case files, trials, assertions, the judge and the report, and build only the Archie-specific parts: the record builder, two providers, the hermetic boot, the manifest, the comparison script and the approval gate. A review of ready-made tools on that day found none that covers the whole loop:
  - `claude plugin eval` runs a plugin inside stock Claude Code, so it cannot target the PM prompt or in-process tools.
  - Promptfoo's built-in Claude Agent SDK provider and Inspect's Claude Code solver launch their own agent, not Archie.
  - Tracing platforms over OpenTelemetry would move session content out of the task folder for no gain over the SDK reader.
  - The review read documentation only. A check on a synthetic task folder the same day confirmed that promptfoo 0.125.1 assertions read a custom provider's record.
