# Architecture Overview

Archie (Autonomous Responsive and Collaborative Hyper Intelligent Employee) is an AI employee built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Work arrives from Slack, the CLI or GitHub, becomes a task, and a single agent — the PM — handles it, delegating pieces of the work to subagents it spawns.

## Core Principles

- **One agent per task.** A task is one Claude Agent SDK session, resumed across turns. Everything the PM does not do itself it hands to a subagent through the SDK's built-in `Agent` tool, inside the same session and process. There are no peer agents and no message queues between agents.
- **Coordination is prose, not machinery.** The PM briefs a worker and reads its report. There is no task owner, no handoff protocol and no shared blackboard to keep in sync.
- **Context protection is the reason to delegate.** Only a worker's final report reaches the PM's context; everything it read stays with it. Anything expected to produce more than a screen of output goes through a worker regardless of domain.
- **Human-like behavior.** To users, Archie presents as a single assistant. Internal mechanics are never exposed — the PM writes as "I", never "my worker".
- **Mostly reactive, with triggers.** Archie acts on external events, and on **triggers** — persistent, user-approved "do Y when X happens" rules that spawn a fresh task when they fire. Every trigger passes an explicit Approve/Deny gate. See [triggers.md](./triggers.md).
- **Interruptible.** Tasks can be stopped, parked, resumed and recovered. Code changes require explicit user approval.
- **Optional remote execution.** When an operator enables a runner profile for the PM, mounted repositories can execute generic commands and repository MCP tools in task-scoped Tart VMs through Orchard. The canonical checkout stays on Archie.

## System Architecture

```
                    External Events
                    ┌──────────┐  ┌──────────┐
                    │  Slack   │  │  GitHub  │
                    │  Bolt    │  │ Webhooks │
                    └────┬─────┘  └─────┬────┘
                         │              │
─────────────────────────┼──────────────┼──────────── Connector Layer
                         │              │
              ┌──────────▼──┐  ┌────────▼────────┐
              │ Slack Events│  │  GitHub Events  │
              │ (events.ts) │  │   (events.ts)   │
              └──────┬──────┘  └────────┬────────┘
                     │                  │
                     │  Deterministic routing: thread / branch / PR
                     │  lookup → existing task or new task. The wake
                     │  carries the message text itself.
                     │                  │
─────────────────────┼──────────────────┼─────────── Task Layer
                     │                  │
                    ┌▼──────────────────▼─────┐
                    │       Task Class        │
                    │     (tasks/task.ts)     │
                    │  one message queue,     │
                    │  one agent, callbacks   │
                    └────────────┬────────────┘
                                 │
─────────────────────────────────┼─────────────────── Agent Layer
                                 │
                    ┌────────────▼────────────┐
                    │      PM  (Opus)         │
                    │  one SDK session        │
                    │   ├─ Skill  (plugin:skill)
                    │   └─ Agent  (plugin:agent | general-purpose)
                    │        └─ subagents, same process
                    └────────────┬────────────┘
                                 │
─────────────────────────────────┼─────────────────── Persistence Layer
                                 │
        ┌────────────────┬───────┴────────┬────────────────┐
   metadata.json    knowledge.log    usage/events     task clones
                    (write-only)        .jsonl        repos/<org>/<repo>
```

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js >= 20, TypeScript, ES modules |
| Agent Framework | `@anthropic-ai/claude-agent-sdk` 0.3.257 |
| Models | Opus (the PM), Fable (the PM in max mode), Sonnet/Opus per worker spawn, Haiku (title generation, research preset classification) |
| Slack Integration | `@slack/bolt` ^5.0.0, `@slack/web-api` |
| GitHub Integration | `@octokit/app` ^16.1.4, `@octokit/webhooks` |
| Schema Validation | `zod` ^4.3.6, `zod-to-json-schema` ^3.25.0 |
| Build | `tsc`, `tsx` (dev mode) |
| Deployment | Docker Compose (dev + prod) |

## Key Design Choices

### Delegation through the SDK

The PM spawns workers with the built-in `Agent` tool. A worker is either an agent type a plugin defined (loaded natively by the SDK, addressable as `plugin:agent`) or the general-purpose worker with a model the PM names per spawn. Workers run in the background by default, so the PM's turn can end while one runs and it is woken when the worker reports. See [agents.md](agents.md).

### Native plugin loading

Plugin directories are passed straight to the SDK's `plugins` option; it reads their skills, agents, commands and hooks itself. Skills are namespaced `plugin:skill`, so same-named skills in different plugins no longer collide. Archie keeps only what the SDK does not do: cloning and refreshing the plugins repo, enumerating plugin directories, and the two engine-owned root files — `.mcp.json` (MCP servers plus their approval tiers) and `archie.json` (network allowlist, warm repos, auto-merge). See [plugin-system.md](plugin-system.md).

### Repos are mounted, not declared

Nothing is cloned when a task starts. The GitHub App installation is the allowlist; the PM calls `mount_repo("owner/repo")`, gets a `git clone --shared` checkout at `sessions/{taskId}/repos/{owner}/{repo}` and passes the path into a worker's brief. One clone per repo per task — the task is the isolation boundary. Read-only until edit mode is approved, at which point every clone moves onto `archie/{taskId}` and the PM resumes with a writable mount. See [edit-mode.md](edit-mode.md).

### Wakes carry their content

A Slack message, a GitHub event or a system notice reaches the PM as the text itself, framed by a builder in `src/agents/prompts.ts` — not as a pointer telling it to go and read a file. `knowledge.log` is still written, but as a record for offline consumers (memory extraction, the people section) and as the audit trail; the running PM never reads it. See [persistence.md](persistence.md#the-knowledge-log).

### Per-task instances

Each task gets its own `Task` instance holding one message queue, one agent handle and session, task-scoped budgets (research requests, wall-clock timeout) and metadata persisted to disk through a 500 ms debounce.

## High-Level Message Flow

### Slack

```
1. Slack event (app_mention, DM, or thread reply)
   → connectors/slack/events.ts receives via Slack Bolt

2. Route filters
   → routeSlackEvent() discards our own bot messages; external/guest authors
     are skipped in handleSlackEvent() before any task work

3. Deterministic thread→task lookup
   → findTaskByThread(threadId): if a task is linked to this thread, route to it
     (Task.get → append → sendMessage with AGENT_PROMPTS.inboundActivity(entries))
   → Otherwise start a new task if it is an @mention, a DM, or a human reply to a
     thread Archie itself started (rootAuthorWasBot), AND the fetched thread
     carries at least one visible message
     (Task.create → append → sendMessage with AGENT_PROMPTS.inboundNewTask(entries))
   → Replies in human-started threads the bot didn't start are ignored

4. The PM processes the messages it was handed inline:
   → loads the relevant skill
   → answers directly, or mounts a repo and spawns a worker
   → relays anything the user needs via post_to_user, then report_completion
```

### GitHub

```
1. GitHub webhook (PR review, comment, push, check_run)
   → connectors/github/events.ts receives via an Express endpoint

2. connectors/github/webhooks.ts routes deterministically:
   → matches the task by branch name (archie/task-{id}, legacy feature/task-{id})
     or by PR number
   → direct (reviews, CI, comments), merge_check, or discard

3. The event is appended and the same line is delivered to the PM inline
4. For merge checks: the merge orchestrator evaluates and merges if ready
```

See [slack-integration.md](slack-integration.md) and [github-integration.md](github-integration.md).

## Source Code Structure

```
src/
├── index.ts                     # Entry point, HTTP server, startup sequence
├── connectors/
│   ├── slack/                   # Bolt app, events, client, canvases, pins, status, title sync
│   ├── github/                  # App auth, webhooks, PR/merge logic, repo-clone, branch state
│   ├── api/routes.ts            # REST + SSE for the CLI/admin UI
│   └── oauth/routes.ts          # OAuth provider redirect endpoints
├── agents/
│   ├── agent.ts                 # Agent class: queue, handle, session, background tasks
│   ├── spawn.ts                 # The single spawn path: workspace, prompt, plugins, MCP, sandbox, hooks
│   ├── registry.ts              # The PM definition (model, effort, MCP servers, policy union)
│   ├── tools.ts                 # In-process MCP servers (comms, orchestration, scheduling, repo)
│   ├── sandbox.ts               # Filesystem guard hook + sandbox/network policy builders
│   ├── tool-approval-gate.ts    # Per-call MCP approval gate
│   ├── mcp-file-bridge.ts       # Forwards local file bytes into other MCP servers
│   ├── activity.ts              # Tool call → status phrase
│   ├── task-usage.ts            # Token/cost aggregation for get_task_usage
│   ├── message-queue.ts         # Async message queue with replay
│   ├── model-label.ts           # Model/effort resolution + display labels
│   └── prompts.ts               # Wake builders (inline content) and recovery prompts
├── tasks/
│   ├── task.ts                  # Task class: lifecycle, budgets, the one agent, approvals
│   ├── persistence.ts           # Disk I/O, path helpers, task lookups
│   ├── recovery.ts              # Startup recovery, idle detection, progressive recovery
│   ├── status.ts                # The single "Archie is …" status line
│   └── title-generator.ts       # Haiku-authored task titles
├── system/
│   ├── workdir.ts               # Path constants, plugins clone/refresh, warm base clones
│   ├── plugin-loader.ts         # Plugin enumeration, root .mcp.json and archie.json
│   ├── plugin-sync.ts           # Per-task plugins refresh
│   ├── logger.ts                # Unified color-coded logger
│   ├── event-bus.ts             # Process-local event emitter (SSE / observers)
│   ├── secrets-vault.ts         # Encrypted vault for OAuth tokens
│   ├── reminder-scheduler.ts    # Pending reminders
│   ├── trigger-*.ts             # Trigger store, scheduler, matching, visibility
│   └── oauth/                   # OAuth flow helpers and header injection
├── memory/                      # Cross-task memory: extraction, index, injection
├── runners/                     # Optional Orchard/Tart leases, execution, transfers, tools
├── mcp/research-tools.ts        # Web research pipeline
├── types/                       # TaskMetadata, AgentDef, channels, triggers
└── utils/prompt-loader.ts       # Markdown prompt loader with variable substitution

core-plugin/                     # The engine's own plugin: skills that ship with archie-hq
prompts/
├── pm-agent.md                  # The one engine prompt
├── memory-extractor.md
└── memory-housekeeper.md
```

## Related Documentation

- [Agents](agents.md) — the PM, its workers, models and effort, session lifecycle
- [Orchestration](orchestration.md) — task runtime, routing, recovery
- [Persistence](persistence.md) — task storage, metadata, the knowledge log, usage accounting
- [Slack Integration](slack-integration.md) — Bolt setup, event handling, interactive messages
- [GitHub Integration](github-integration.md) — webhooks, PR management, merge orchestrator
- [Edit Mode](edit-mode.md) — `mount_repo`, the approval gate, the git workflow
- [Max Mode](max-mode.md) — the PM's per-task, human-approved model/effort upgrade
- [Tool Approvals](tool-approvals.md) — per-call human approval for critical MCP tools
- [Plugin System](plugin-system.md) — what a plugin contributes and how it is loaded
- [Web Research](web-research.md) — research pipeline and defense layers
- [Security](security.md) — sandbox, credentials, and the flat model's posture change
