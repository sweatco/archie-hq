# Architecture Overview

Archie (Autonomous Responsive and Collaborative Hyper Intelligent Employee) is a multi-agent AI software engineering system built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Specialized agents collaborate on tasks across multiple repositories, coordinated through Slack and GitHub integrations.

## Core Principles

- **Human-like behavior**: To users, Archie presents as a single AI assistant. Internal agent coordination is never exposed. The PM agent writes as "I", not "my agent" or "the backend agent."
- **Context-aware sessions**: Each task gets its own runtime with per-agent message delivery, metadata, and a shared `knowledge.log` that all agents read for context.
- **Direct agent communication**: Agents communicate peer-to-peer via `send_message_to_agent`, with messages delivered through simple in-memory queues in the task runtime.
- **Non-proactive**: Archie only acts in response to external events (Slack messages, GitHub webhooks). It never initiates work on its own.
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
                    ┌▼──────────────────▼─────┐
                    │     Triage Agent        │
                    │  (Haiku — classifier)   │
                    └────────────┬────────────┘
                                 │
─────────────────────────────────┼─────────────────── Task Layer
                                 │
                    ┌────────────▼────────────┐
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
     │  metadata.json│  │ knowledge.log│  │  Git Worktrees  │
     └───────────────┘  └──────────────┘  └─────────────────┘
```

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js >= 20, TypeScript, ES modules |
| Agent Framework | `@anthropic-ai/claude-agent-sdk` ^0.1.0 |
| Models | Haiku (triage), Opus (PM), Sonnet (repo agents, plugin agents, research) |
| Slack Integration | `@slack/bolt` ^4.6.0, `@slack/web-api` ^7.0.0 |
| GitHub Integration | `@octokit/app` ^16.1.2, `@octokit/webhooks` ^14.2.0 |
| Schema Validation | `zod` ^3.22.0, `zod-to-json-schema` ^3.25.0 |
| Prompt Parsing | `gray-matter` ^4.0.3 (frontmatter extraction) |
| Markdown | `slackify-markdown` ^4.5.0 (Slack formatting) |
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

### Git Worktrees

In edit mode, repo agents work in isolated git worktrees (`src/connectors/github/worktree.ts`). Each worktree gets a feature branch (`feature/task-{taskId}`) based on the repository's default branch. Agents commit locally; the PM agent handles `git push`, PR creation, and remote operations via GitHub API.

### Plugin Architecture

Agents and capabilities are loaded dynamically from a `plugins/` directory (`src/system/plugin-loader.ts`). Each plugin can provide:

- **Repo agents**: Via `repo-config.json` (infrastructure config) + `agents/*.md` (identity/prompts)
- **Plugin agents**: Via `agents/*.md` in plugins without `repo-config.json` (lightweight, read-only)
- **PM skills**: Via `pm-skills/` directories (domain-specific workflows symlinked into task workspaces)
- **Agent skills**: Via `skills/` directories (agent-specific capabilities symlinked at spawn)

See [plugin-system.md](plugin-system.md) for details.

## High-Level Message Flow

### Slack Message Flow

```
1. Slack event (app_mention or thread reply)
   → connectors/slack/events.ts receives via Slack Bolt

2. Route filters (bot messages)
   → routeSlackEvent() discards own bot messages or passes through

3. Triage Agent classifies (Haiku, structured JSON output)
   → new_task | existing_task | cancel_task | noop

4. Event handler routes based on triage result:
   → new_task:      Task.createFromSlackThread() → task.sendMessage(pm-agent)
   → existing_task: Task.get()   → append to knowledge.log → task.sendMessage(pm-agent)
   → cancel_task:   task.stop()  → post cancellation to Slack
   → noop:          no action

5. PM Agent processes input:
   → Reads knowledge.log for context
   → Loads relevant PM skill via Skill tool
   → Delegates to repo/plugin agents via send_message_to_agent
   → Or responds directly via post_to_slack + report_completion

6. Specialist Agents work:
   → Read knowledge.log for context
   → Investigate/modify code in their repository
   → Report findings back to PM or task owner via send_message_to_agent
```

### GitHub Webhook Flow

```
1. GitHub webhook (PR review, comment, push, check_run)
   → index.ts receives via Express endpoint

2. connectors/github/webhooks.ts performs deterministic routing:
   → Matches task by branch name (feature/task-{id}) or PR number
   → Routes to: triage (comments), direct (reviews, CI), merge_check, or discard

3. For PR comments: Triage Agent classifies (existing_task or noop)
4. For deterministic events: Direct routing to PM agent
5. For merge checks: Merge orchestrator evaluates and merges if ready
```

See [slack-integration.md](slack-integration.md) and [github-integration.md](github-integration.md) for details.

## Source Code Structure

```
src/
├── index.ts                     # Entry point, HTTP server, startup, plugin/agent loading
├── connectors/
│   ├── slack/
│   │   ├── client.ts            # Slack Web API wrapper, mention resolution, file downloads
│   │   ├── callbacks.ts         # Slack callback registry (post_to_slack, interactive messages)
│   │   └── events.ts            # Slack Bolt app, event handlers, triage routing, button actions
│   └── github/
│       ├── client.ts            # GitHub App / Octokit wrapper, git identity, GIT_ASKPASS
│       ├── events.ts            # GitHub webhook dispatch, triage processing
│       ├── webhooks.ts          # Signature verification, routing, context extraction, formatting
│       ├── merge.ts             # PR merge logic, linked PR checking
│       └── worktree.ts          # Git worktree lifecycle
├── agents/
│   ├── agent.ts                 # Agent class: prompt composition, spawning, session management
│   ├── spawn.ts                 # Agent spawn entrypoint, worktree setup, tool wiring
│   ├── registry.ts              # Agent definition registry (from plugins)
│   ├── tools.ts                 # MCP tool definitions (PM + repo agent tools)
│   ├── message-queue.ts         # Async message queue with recovery
│   └── prompts.ts               # Shared prompt constants (new task, recovery, etc.)
├── tasks/
│   ├── task.ts                  # Task class: lifecycle, budgets, agent management, callbacks
│   ├── persistence.ts           # Disk I/O: metadata, knowledge log, debounced writes, lookups
│   └── recovery.ts              # Startup recovery, idle detection, progressive recovery
├── system/
│   ├── shutdown.ts              # Shutdown state (getIsShuttingDown / setShuttingDown)
│   ├── logger.ts                # Unified color-coded logger
│   ├── triage.ts                # Triage agent (Haiku classifier for Slack/GitHub)
│   ├── plugin-loader.ts         # Plugin directory scanner
│   └── workdir.ts               # Bootstrap: path constants, clone/pull/fetch helpers
├── mcp/
│   └── research-tools.ts        # Web research pipeline (multi-agent)
├── types/
│   ├── task.ts                  # TaskMetadata, SlackThread, RepositoryInfo, etc.
│   ├── agent.ts                 # AgentDef, AgentHandle, AgentSessionState
│   └── index.ts                 # Type re-exports
├── utils/
│   └── prompt-loader.ts         # Markdown prompt file loader with variable substitution
└── prompts/
    ├── agent-core.md            # Layer 1: Universal multi-agent protocol
    ├── pm-agent.md              # PM agent system prompt
    ├── repo-agent.md            # Layer 2: Repo agent track extension
    ├── plugin-agent.md          # Layer 2: Plugin agent track extension
    ├── triage-agent.md          # Triage agent system prompt
    └── research/                # Research pipeline prompts
        ├── lead-agent.md
        ├── researcher.md
        └── report-writer.md
```

## Related Documentation

- [Agents Architecture](agents.md) -- agent types, communication, and prompt composition
- [Orchestration](orchestration.md) -- task runtime, message queues, and agent lifecycle
- [Persistence](persistence.md) -- task storage, metadata, and knowledge log
- [Slack Integration](slack-integration.md) -- Slack Bolt setup, event handling, interactive messages
- [GitHub Integration](github-integration.md) -- webhooks, PR management, merge orchestrator
- [Edit Mode](edit-mode.md) -- approval flow, worktrees, and git workflow
- [Plugin System](plugin-system.md) -- plugin structure, loading, and agent registration
- [Web Research](web-research.md) -- multi-agent research pipeline and defense layers
- [Security](security.md) -- research budget, sandwich defense, prompt injection mitigations
