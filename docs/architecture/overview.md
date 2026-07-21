# Architecture Overview

Archie (Autonomous Responsive and Collaborative Hyper Intelligent Employee) is a multi-agent AI software engineering system built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Specialized agents collaborate on tasks across multiple repositories, coordinated through Slack and GitHub integrations.

## Core Principles

- **Human-like behavior**: To users, Archie presents as a single AI assistant. Internal agent coordination is never exposed. The PM agent writes as "I", not "my agent" or "the backend agent."
- **Context-aware sessions**: Each task gets its own runtime with per-agent message delivery, metadata, and a shared `knowledge.log` that all agents read for context.
- **Direct agent communication**: Agents communicate peer-to-peer via `send_message_to_agent`, with messages delivered through simple in-memory queues in the task runtime.
- **Mostly reactive, with triggers**: Archie acts in response to external events (Slack messages, GitHub webhooks). It can also act on **triggers** — persistent, user-approved "do Y when X happens" rules (a schedule, or a new channel message) that spawn a fresh task when they fire. Triggers are the one sanctioned form of self-initiated work; every trigger is created via an explicit Approve/Deny gate. See [triggers.md](./triggers.md).
- **Interruptible**: Tasks can be stopped, resumed, and recovered. Edit mode requires explicit user approval via Slack buttons.

## System Architecture

```
                    External Events
                    ┌──────────┐  ┌──────────┐
                    │  Slack   │  │  GitHub   │
                    │  Bolt    │  │  Webhooks │
                    └────┬─────┘  └─────┬─────┘
                         │              │
─────────────────────────┼──────────────┼──────────── Connector Layer
                         │              │
              ┌──────────▼──┐  ┌────────▼────────┐
              │ Slack Events│  │  GitHub Events  │
              │ (events.ts) │  │  (events.ts)    │
              └──────┬──────┘  └────────┬────────┘
                     │                  │
                     │  Deterministic routing: thread/branch/PR
                     │  lookup → existing task or new task.
                     │  (Triage agent exists but is currently
                     │   disabled — events go straight to the
                     │   PM via the Task.)
                     │                  │
─────────────────────┼──────────────────┼─────────── Task Layer
                     │                  │
                    ┌▼──────────────────▼─────┐
                    │      Task Class         │
                    │  (tasks/task.ts)        │
                    │  Message queues, agent  │
                    │  spawning, callbacks    │
                    └────────────┬────────────┘
                                 │
─────────────────────────────────┼─────────────────── Agent Layer
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼──────┐  ┌───────▼──────┐  ┌────────▼────────┐
     │   PM Agent    │  │  Repo Agents │  │  Plugin Agents  │
     │   (Opus)      │  │  (Sonnet)    │  │  (Sonnet)       │
     └───────────────┘  └──────────────┘  └─────────────────┘
                                 │
─────────────────────────────────┼─────────────────── Persistence Layer
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼──────┐  ┌───────▼──────┐  ┌────────▼────────┐
     │  metadata.json│  │ knowledge.log│  │  Git Clones     │
     └───────────────┘  └──────────────┘  └─────────────────┘
```

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js >= 20, TypeScript, ES modules |
| Agent Framework | `@anthropic-ai/claude-agent-sdk` ^0.2.77 |
| Models | Opus (PM), Sonnet (repo agents, plugin agents, research). Haiku (title generation, triage — triage currently disabled) |
| Slack Integration | `@slack/bolt` ^4.6.0, `@slack/web-api` ^7.0.0 |
| GitHub Integration | `@octokit/app` ^16.1.2, `@octokit/webhooks` ^14.2.0 |
| Schema Validation | `zod` ^4.3.6, `zod-to-json-schema` ^3.25.0 |
| Prompt Parsing | `gray-matter` ^4.0.3 (frontmatter extraction) |
| Build | `tsc` (TypeScript compiler), `tsx` (dev mode) |
| Deployment | Docker Compose (dev + prod configurations) |

## Key Innovations

### Two-Channel Communication

Agents have two distinct communication channels (see [agents.md](agents.md) for details):

- **`send_message_to_agent`**: Direct peer-to-peer messaging. The sender's message is queued to the target agent. The target is spawned on demand if not already running.
- **`log_finding`**: Write to the shared `knowledge.log` visible to all agents and the PM. Used for discoveries, decisions, completions, and blockers.

### Thread Owner Pattern

Every task has a designated **task owner** (a repo or plugin agent) responsible for coordinating the overall work. The PM agent assigns ownership via `assign_task_owner` and communicates it in the delegation message. Task owners coordinate with participant agents using sequential or parallel strategies, then report back to the PM.

### Streaming Generators

Agents receive input via async generators connected to `MessageQueue` instances (`src/agents/message-queue.ts`). This enables continuous streaming: new messages are fed to running agents without restarting them. The `RecoverableInputGenerator` tracks consumed messages and can replay them on session recovery failure.

### Per-Task Instances

Each task gets its own `Task` instance (a class that encapsulates runtime state) with:

- Isolated message queues for every agent
- Independent agent handles and session state
- Task-scoped budgets (research requests, inter-agent messages, wall-clock timeout)
- Metadata and knowledge log persisted to disk

### Shared Git Clones

All repo agents work in isolated `git clone --shared` checkouts (`src/connectors/github/repo-clone.ts`), regardless of mode. Each clone has its own `.git/` directory, refs, index, and HEAD, but borrows objects from the base repo's object store via alternates. In **readonly mode**, the clone is checked out on `origin/{baseBranch}`. In **edit mode**, the clone has a feature branch (`archie/task-{taskId}`) based on the repository's default branch. Agents can track multiple branches per clone via `BranchState` records. Agents commit locally and manage their own PRs via the `repo-tools` MCP server; clones for readonly tasks are cleaned up on task stop/complete. Legacy worktrees are migrated to shared clones on first encounter (`migrateWorktreeToClone`).

### Plugin Architecture

Agents and capabilities are loaded dynamically from the plugins directory under the runtime workdir (`$ARCHIE_WORKDIR/plugins`, default `./workdir/plugins`). On startup `bootstrapWorkdir()` (`src/system/workdir.ts`) clones the repo specified by `ARCHIE_PLUGINS` into that location (or pulls/resets it on subsequent boots) before `initPlugins()` (`src/system/plugin-loader.ts`) scans it. `initRegistry()` then builds `AgentDef`s from the loaded plugins, and `cloneRepos()` clones every repo declared by repo-track agent frontmatter into `$ARCHIE_WORKDIR/repos/<repo-key>` (or fetches+resets if already cloned). Each plugin can provide:

- **Repo agents**: Via `agents/*.md` with repo metadata in frontmatter (or legacy `repo-config.json`)
- **Plugin agents**: Via `agents/*.md` without repo metadata (lightweight, read-only)
- **PM overlay**: Via `pm/` plugin (`agents/pm.md` body appended to PM prompt)
- **Agent skills**: Via `skills/` directories (agent-specific capabilities symlinked at spawn)
- **Hooks**: Via `hooks/hooks.json` (plugin-defined hooks injected into agent settings)
- **MCP servers**: Via root `.mcp.json` (agent frontmatter references server names)

See [plugin-system.md](plugin-system.md) for details.

## High-Level Message Flow

### Slack Message Flow

```
1. Slack event (app_mention, DM, or thread reply)
   → connectors/slack/events.ts receives via Slack Bolt

2. Route filters
   → routeSlackEvent() discards our own bot messages; external/guest authors
     are skipped in handleSlackEvent() before any task work

3. Deterministic thread→task lookup (triage agent is currently disabled)
   → findTaskByThread(threadId): if a task is already linked to this Slack
     thread, route to it (Task.get → task.append → task.sendMessage with
     AGENT_PROMPTS.existingTask)
   → Otherwise start a new task if it's an @mention, a DM, or a human reply to
     a thread Archie itself started (rootAuthorWasBot — a post it made via the
     post_to_channel explore tool)
     (Task.create → task.append → task.sendMessage with AGENT_PROMPTS.newTask)
   → Replies in human-started threads the bot didn't start are ignored

4. PM Agent processes input:
   → Reads knowledge.log for context
   → Loads relevant PM skill via Skill tool
   → Delegates to repo/plugin agents via send_message_to_agent
   → Or responds directly via post_to_user + report_completion

5. Specialist Agents work:
   → Read knowledge.log for context
   → Investigate/modify code in their repository
   → Report findings back to PM or task owner via send_message_to_agent
```

### GitHub Webhook Flow

```
1. GitHub webhook (PR review, comment, push, check_run)
   → connectors/github/events.ts receives via Express endpoint

2. connectors/github/webhooks.ts performs deterministic routing:
   → Matches task by branch name (archie/task-{id}, legacy feature/task-{id}) or PR number
   → Routes to: direct (reviews, CI, comments), merge_check, or discard

3. Events are appended to the matched task and the PM agent is messaged
   directly (the GitHub path has never used the triage agent)
4. For merge checks: merge orchestrator evaluates and merges if ready
```

See [slack-integration.md](slack-integration.md) and [github-integration.md](github-integration.md) for details.

## Source Code Structure

```
src/
├── index.ts                     # Entry point, HTTP server, startup, plugin/agent loading
├── connectors/
│   ├── slack/
│   │   ├── client.ts            # Slack Web API wrapper, posting helpers, mention resolution, file downloads
│   │   ├── events.ts            # Slack Bolt app, event handlers, deterministic thread→task routing, button actions
│   │   └── title.ts             # Assistant-thread title sync (DM list naming)
│   ├── github/
│   │   ├── client.ts            # GitHub App / Octokit wrapper, git identity, GIT_ASKPASS
│   │   ├── events.ts            # GitHub webhook dispatch (deterministic, no triage)
│   │   ├── webhooks.ts          # Signature verification, routing, context extraction, formatting
│   │   ├── merge.ts             # PR merge logic, linked PR checking
│   │   ├── repo-clone.ts        # Shared `git clone --shared` lifecycle (setup, remove, worktree migration)
│   │   └── branch-state.ts      # Per-branch state helpers (hydrate, mirror legacy, find by PR)
│   ├── api/
│   │   └── routes.ts            # REST + SSE routes for the CLI/admin UI
│   └── oauth/
│       └── routes.ts            # OAuth provider redirect endpoints (token exchange)
├── agents/
│   ├── agent.ts                 # Agent class: prompt composition, spawning, session management
│   ├── spawn.ts                 # Agent spawn entrypoint, clone setup, tool wiring, edit-mode branching
│   ├── registry.ts              # Agent definition registry (from plugins)
│   ├── tools.ts                 # MCP tool definitions (PM + repo agent tools)
│   ├── sandbox.ts               # Filesystem-guard hook + sandbox config builder
│   ├── artifacts.ts             # Per-task artifact capture
│   ├── task-usage.ts            # Token/cost aggregation + report formatting for get_task_usage
│   ├── message-queue.ts         # Async message queue with recovery
│   └── prompts.ts               # Shared prompt constants (new task, recovery, etc.)
├── tasks/
│   ├── task.ts                  # Task class: lifecycle, budgets, agent management, callbacks
│   ├── launch.ts                # Spawn an independent child task from a running task
│   ├── persistence.ts           # Disk I/O: metadata, knowledge log, debounced writes, lookups
│   ├── recovery.ts              # Startup recovery, idle detection, progressive recovery
│   └── title-generator.ts       # Haiku-authored task title pipeline
├── system/
│   ├── shutdown.ts              # Shutdown state (getIsShuttingDown / setShuttingDown)
│   ├── logger.ts                # Unified color-coded logger
│   ├── triage.ts                # Triage agent (Haiku classifier — currently disabled, not invoked from any connector)
│   ├── plugin-loader.ts         # Plugin directory scanner ($ARCHIE_WORKDIR/plugins)
│   ├── workdir.ts               # Bootstrap: path constants (WORKDIR, PLUGINS_DIR, REPOS_DIR, SESSIONS_DIR, SECRETS_DIR), clone/pull/fetch helpers
│   ├── secrets-vault.ts         # Encrypted vault for OAuth tokens (master-key validated at startup)
│   ├── reminder-scheduler.ts    # Periodic reminder scheduler
│   ├── event-bus.ts             # Process-local event emitter (for SSE / observers)
│   └── oauth/                   # OAuth flow helpers (token injection into agent env)
├── mcp/
│   └── research-tools.ts        # Web research pipeline (multi-agent, prompts inline)
├── types/
│   ├── task.ts                  # TaskMetadata, SlackThread, RepositoryInfo, etc.
│   ├── agent.ts                 # AgentDef, AgentHandle, AgentSessionState
│   └── index.ts                 # Type re-exports
└── utils/
    └── prompt-loader.ts         # Markdown prompt file loader with variable substitution

prompts/                         # Repo-root: layered system prompts
├── agent-core.md                # Layer 1: Universal multi-agent protocol
├── pm-agent.md                  # PM agent system prompt
├── repo-agent.md                # Layer 2: Repo agent track extension
├── plugin-agent.md              # Layer 2: Plugin agent track extension
└── triage-agent.md              # Triage agent system prompt (loaded only if triage is re-enabled)
```

## Related Documentation

- [Agents Architecture](agents.md) -- agent types, communication, and prompt composition
- [Orchestration](orchestration.md) -- task runtime, message queues, and agent lifecycle
- [Persistence](persistence.md) -- task storage, metadata, and knowledge log
- [Slack Integration](slack-integration.md) -- Slack Bolt setup, event handling, interactive messages
- [GitHub Integration](github-integration.md) -- webhooks, PR management, merge orchestrator
- [Edit Mode](edit-mode.md) -- approval flow, shared clones, and git workflow
- [Max Mode](max-mode.md) -- per-task, human-approved model/effort upgrade for coding agents
- [Plugin System](plugin-system.md) -- plugin structure, loading, and agent registration
- [Web Research](web-research.md) -- multi-agent research pipeline and defense layers
- [Security](security.md) -- research budget, sandwich defense, prompt injection mitigations
