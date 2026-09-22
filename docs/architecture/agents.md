# Agents Architecture

A task runs exactly **one** agent: the PM. Everything the PM does not do itself it delegates to a **subagent** spawned through the Claude Agent SDK's built-in `Agent` tool, inside the PM's own session and process. There are no peer agents, no message queues between agents, no task owner and no triage classifier.

**Source:** `src/agents/spawn.ts`, `src/agents/registry.ts`, `src/agents/agent.ts`, `src/tasks/task.ts`, `prompts/pm-agent.md`

## The PM

One `Agent` instance per task (`Task.agent`), created lazily on the first message (`Task.ensurePm`) and torn down by `stop()` / `complete()`. Its definition is engine-owned and static apart from three things read from the plugins repo root — the MCP servers in `.mcp.json`, the network allowlist in `archie.json`, and the model/effort/max-mode overrides and body text in `pm.md` — and is rebuilt on every task start/reload so a plugins-repo change is picked up without a restart (`getPmDef()` / `scanPmDef()` in `src/agents/registry.ts`).

| | Value | `pm.md` frontmatter | Env override |
|---|---|---|---|
| Agent id / key | `pm-agent` / `pm` | — | — |
| Model | `opus` | `model` | `ARCHIE_PM_MODEL` |
| Effort | `medium` | `effort` | `ARCHIE_PM_EFFORT` |
| Max-mode model | `claude-fable-5-1` | `maxMode.model` | `ARCHIE_PM_MAX_MODEL` |
| Max-mode effort | `high` | `maxMode.effort` | `ARCHIE_PM_MAX_EFFORT` |
| Max turns per query | 100 | — | — |

Precedence resolves narrowest-wins: an env var beats `pm.md`, which beats the built-in default. `pm.md`'s body text — everything after the frontmatter — is appended to the PM's system prompt under a `# Deployment context` heading regardless of which values it overrides; a missing file or malformed frontmatter falls back to the built-ins with no error (see [plugin-system.md](plugin-system.md#pm-overlay-pmmd)).

### Tools

Six in-process MCP servers are attached at spawn, plus every server in the plugins repo's root `.mcp.json` (see [plugin-system.md](plugin-system.md#the-root-mcp-config)). A seventh, `runner-tools`, is attached only when an operator-defined runner profile allows `pm-agent`.

| Server | Tools |
|---|---|
| `comms-tools` | `post_to_user`, `post_files_to_user`, `find_slack_user`, `find_slack_channel`, `list_channels`, `read_channel_history`, `read_thread`, `post_to_channel`, `mute_channel`, `react_to_message`, `unreact_from_message`, `get_message_reactions`, `fetch_slack_reference` |
| `orchestration-tools` | `report_completion`, `request_edit_mode`, `request_max_mode`, `get_task_usage`, `list_available_repos`, `mount_repo`, and the five trigger tools |
| `scheduling-tools` | `parse_datetime`, `set_reminder`, `cancel_reminder` |
| `repo-tools` | git and PR lifecycle against clones this task mounted — read side always, write side only in edit mode (see [edit-mode.md](edit-mode.md)) |
| `research-tools` | `web_research` |
| `file-bridge` | forwards a local file's bytes into another MCP server's call without routing them through the model; always attached |
| `runner-tools` | optional task-scoped Tart VM provisioning, repository sync, execution, repository MCP calls, polling, artifact collection, bounded debugging and release (see [runners.md](runners.md)) |

`Agent`, `Skill`, `Read`, `Bash`, `Write` and `Edit` come from the SDK itself. `WebSearch`, `WebFetch` and `Cron*` are in `disallowedTools` on every spawn, as are the write-side `repo-tools` before edit mode and every `deny`-tiered MCP tool ([tool-approvals.md](tool-approvals.md)).

> **Caveat on `Glob` and `Grep`, pre-existing and unverified.** The filesystem guard's read check covers `Read`, `Glob` and `Grep`, but `Glob` is not actually present in this runtime — a live agent asking for it gets `No such tool available: Glob`. Nothing disallows it: the SDK ships as a native build, and native builds omit the dedicated `Grep`/`Glob` tools in favour of Bash `find`/`grep` unless they are named in `tools`/`allowedTools`, which this app does not do. `Grep` is very likely absent for the same reason, though that was never confirmed. Use `Bash` to enumerate a directory.

### Skills

Skills come from the SDK's own plugin loader — every plugin directory is passed through the `plugins` option, and the SDK reads its `skills/` itself. Names are namespaced `plugin:skill` (`core:thread-conduct`, `engineering:pr-workflow`), so same-named skills in different plugins no longer collide, and there is no symlinking and no per-track mount table. The engine's own skills ship as one more plugin directory, `core-plugin/`, inside this repository.

### Prompt

`prompts/pm-agent.md`, loaded with no template substitution — there is no team roster to inject, because the `Agent` tool lists the available agent types itself. Spawn appends, in order: the Current Task Context block (task id, status, channels, reminder, plugins-repo HEAD, mounted repos with their paths and branches, working directory, shared folder), the `<people_in_task>` section, a shared-channel notice when applicable, the channel pin index, the channel canvas brief, the trigger-data section on a trigger-fired task, and organizational memory. The layered `agent-core.md` / `repo-agent.md` / `plugin-agent.md` / `triage-agent.md` prompts are gone.

## Workers

The PM delegates with the SDK `Agent` tool. Two kinds of worker exist:

- **Plugin-defined agents** — an `agents/*.md` file in a plugin, loaded natively by the SDK and spawnable as `plugin:agent`. The SDK honours `name`, `description`, `model`, `effort`, `tools`, `disallowedTools`, `skills`, `memory` and background/worktree isolation; it ignores `mcpServers`, `permissionMode` and `hooks` with a warning. Only roles that earn a file get one — a fixed procedure and output envelope (analytics), or a reviewer that must be blind to how the material was made.
- **The built-in general-purpose worker** — everything else. The PM writes the brief and names the model per spawn.

**Model and effort.** The PM's prompt requires a model on every spawn: `sonnet` for coding, research and analysis, `opus` only when the work clearly needs it. A worker is never spawned on `fable` — max mode upgrades the PM's own model and effort, not its workers'. An unset model inherits the PM's own, which is the expensive accident the rule exists to prevent. **Effort is not settable per spawn** — a generic worker inherits the session's effort, so effort variety needs an agent definition file.

**What a worker sees.** Only its final report reaches the PM's context; everything it read stays with it. That is the point of delegating — the PM's prompt sends anything expected to produce more than a screen of output through a worker regardless of domain. Workers have no Slack tools, so nothing they find reaches a user until the PM relays it.

**Background by default.** The PM's turn can end while a worker runs. The SDK emits `task_started` and `task_notification`; spawn tracks in-flight ids on `agent.backgroundTasks` (so the idle check treats the PM as busy rather than stalled) and, on settle, enqueues a wake naming the outcome. A task that settles mid-turn emits no notification, so the Stop hook reconciles `backgroundTasks` against the SDK's authoritative `background_tasks` list before parking. A background task started by a tool call inside a worker (its `tool_use_id` belongs to an event with a `parent_tool_use_id`) is not tracked: the worker's own task covers it while the worker runs, and once the worker has reported nothing waits on it.

**Reuse.** A finished worker's agent id can be addressed again to continue it with its context intact, rather than spawning a fresh worker that has to rediscover the material.

**Isolation.** There is none beyond the task. Subagents run in the PM's process and share its cwd, additional directories, sandbox, network allowlist and credentials — see [security.md](security.md#what-the-flat-model-gave-up). Two workers must never be pointed at the same clone at once; the PM keeps them apart by briefing, not by enforcement.

## Max mode

Max mode is the PM's own upgrade — a per-task, human-approved switch to a stronger model and effort, requested with `request_max_mode` and approved from Slack or the API. It upgrades the PM because the PM now does the coding and investigation work the upgrade exists for. See [max-mode.md](max-mode.md).

## Session lifecycle

**Streaming input.** The PM reads from a `MessageQueue` (`src/agents/message-queue.ts`) through `createRecoverableInputGenerator`, which tracks consumed messages so a failed session can replay them. Wakes carry their content: a Slack message, a GitHub event or a system notice arrives as the text itself, framed by a builder in `src/agents/prompts.ts`, not as a pointer to a file.

**Resume.** `agent.session.session_id` is hydrated from `metadata.agent_sessions['pm-agent']` and passed as `resume`. On failure the loop clears the bad session, resets the generator and retries fresh exactly once.

**Idle detection and recovery.** When the turn ends the SDK Stop hook calls `task.updateAgentState(false)`, which schedules an idle check 3 s later. `idleDecision` (`src/tasks/recovery.ts`) returns `wait` (not active, teardown pending, still busy, or a background task in flight), `complete` (quiescent and `report_completion` was called) or `recover` (quiescent with nobody parked). Recovery nudges the live agent with `AGENT_PROMPTS.reinforcePM` twice, then goes nuclear: stop the task, reload it from disk, re-send `AGENT_PROMPTS.recovery` (the reloaded spawn resumes the persisted session, it does not clear it). After three nuclear cycles in one activation the task is paused instead, with one notice to the user, so a PM that keeps going idle can't loop stop→resume until the wall-clock cap.

**Interruption.** Stopping the queue rejects the pending `nextMessage()` and the generator exits. A mid-turn agent is also hard-aborted, because a closed stream otherwise loops it on "Stream closed" control requests until `maxTurns`.

## No persistent code memory (two exceptions)

Each task starts fresh. Context comes from the conversation delivered inline, `metadata.json`, the repository itself, the [memory layer](memory.md), and — on a trigger-fired task only — that trigger's persistent directory, shared by every fire of the same trigger ([triggers.md](triggers.md#persistent-per-trigger-directory)).

## Budgets

| Budget | Default | Enforcement |
|---|---|---|
| Research requests | 5 per task | Hard stop, Slack approval for +5 |
| Wall-clock | 60 minutes | Posts a pause message and parks the task |

## Related Documentation

- [Architecture Overview](overview.md) — system-level architecture and technology stack
- [Orchestration](orchestration.md) — task runtime, routing, and recovery
- [Edit Mode](edit-mode.md) — approval flow, `mount_repo`, and the git workflow
- [Plugin System](plugin-system.md) — how plugins contribute skills and agents
- [Security](security.md) — sandbox, credentials, and what the flat model gave up
