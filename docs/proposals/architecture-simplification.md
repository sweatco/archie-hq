# Architecture Simplification Proposal

> **Historical rationale — filing review 2026-11-11.** The structural change was adopted and later evolved into the flat PM. Preserve the reasons; the old track and triage mechanics are not a current design. Current contract: [System map](../architecture/overview.md).

> **Status (2026-05-01): Largely implemented.** The structural reorganization described below has been adopted. `connectors/slack/` and `connectors/github/` exist and absorb the old slack/github modules; `agents/registry.ts`, `agents/spawn.ts` (track-branching), and co-located `agents/tools.ts` replace the old per-track spawners and split tool defs/impls; `tasks/task.ts` (the `Task` class with `sendMessage`) replaces the `task-runtime.ts` god module; `tasks/persistence.ts` consolidates persistence; `index.ts` owns the HTTP server and mounts connectors. The "Problem" section below describes the *historical* pre-refactor codebase and is preserved for context. Note: the triage agent referenced throughout is currently disabled — Slack messages route directly to the PM (see commented-out call in `src/connectors/slack/events.ts`). Also note that the proposed `connectors/github/worktree.ts` module did not survive: worktrees were later replaced by shared clones in `connectors/github/repo-clone.ts` (see [v18-shared-clones](../plans/v18-shared-clones.md)).

## Problem (historical)

The pre-refactor core flow (message → triage → task → agent → response) touched 11+ files spread across `system/`, `agents/`, `mcp/`, `slack/`, and `github/`. Understanding "what happens when a Slack message arrives" required jumping through server, webhook router, event handler, task runtime, three separate agent spawners, tool definitions, tool callback implementations, and three persistence modules.

Key pain points:

1. **Scatter** — Related logic was split across distant files. Tool *definitions* lived in `mcp/tools.ts`, but their *implementations* were closures inside `task-runtime.ts`. Three nearly identical agent spawners sat in separate files. Three config builders (`plugin-loader` → `repo-configs` → `plugin-configs`) transformed the same plugin data into different shapes.

2. **God module** — `task-runtime.ts` (1140 lines) did everything: created tasks, spawned agents, built 20+ tool callbacks, handled approvals, managed timeouts, and orchestrated task lifecycle.

3. **Circular dependencies** — Tools needed task state to operate, and the task runtime needed to create the tools. Solved with callback interfaces, but the real issue was one module doing too many things.

## Core Model

A **task** is a folder on disk + metadata. It contains agents. The only way to interact with a task from the outside is:

```
sendMessage(taskId, message)                    → PM (default)
sendMessage(taskId, message, 'backend-agent')   → specific agent
```

That's it. Every external event — Slack message, GitHub webhook, button click — ultimately becomes a `sendMessage` call. Triage figures out which task. Connectors figure out what message to send and optionally which agent.

Inside the task, agents talk to each other the same way — `sendMessage` within the same task. The agent gets lazily spawned on first message if not already running.

## Proposed Structure

```
src/
  index.ts                Bootstrap, start server, mount connectors, shutdown

  connectors/             External integrations — self-contained per system
    slack/
      client.ts              API wrapper
      events.ts              Bolt app, event handlers, button handlers
    github/
      client.ts              Octokit wrapper + GitHub types
      webhooks.ts            Routing, signature verification, event formatting
      worktree.ts            Git worktree lifecycle
      merge.ts               PR merge logic

  agents/                 Agent definitions and lifecycle
    registry.ts             Scan plugins → AgentDef[], validate
    spawn.ts                Single spawnAgent() for all tracks
    tools.ts                MCP tool definitions + implementations, co-located

  tasks/                  Task state, persistence, recovery
    task.ts                 The Task — sendMessage, lazy spawn, lifecycle
    persistence.ts          Metadata I/O, knowledge log, path helpers, task lookup
    recovery.ts             Startup recovery + idle detection
    message-queue.ts        Async queues + RecoverableInputGenerator

  system/                 Shared infrastructure
    workdir.ts              Bootstrap + path constants (unchanged)
    logger.ts               Unified logging (unchanged)
    triage.ts               Stateless Haiku classifier

  types/                  Shared type definitions
    task.ts                 TaskMetadata, etc. (unchanged)
    agent.ts                AgentDef, AgentHandle

  prompts/                Unchanged
  utils/                  Unchanged
```

`index.ts` is the app — bootstrap, create the Express server, mount connectors, start listening, handle shutdown.

Five directories: `connectors/`, `agents/`, `tasks/`, `system/`, `types/`. Adding a new integration means adding a subdirectory under `connectors/` and mounting it in `index.ts`.

## Core Ideas

### 1. `sendMessage` is the only entry point

Every external event becomes `sendMessage(taskId, message, agent?)`. Default target is PM. GitHub webhooks for a specific repo can target that repo's agent directly.

This replaces the current tangle of `createTask` + `loadTask` + `sendMessage` + `ensureAgentSpawned` + queue management. The task handles all of that internally — if it doesn't exist yet, `sendMessage` creates it. If the agent isn't running, it spawns it. The caller doesn't need to know.

Inter-agent communication uses the same function. When an agent's `send_message` tool fires, it's the same `sendMessage` call, same task, different target agent.

### 2. Task as the unit

A task is a self-contained unit that holds:
- Metadata (persisted to disk)
- Message queues (per agent, in memory)
- Running agent handles (in memory)

The current `task-runtime.ts` god module splits because most of it becomes the task itself. What's left — the `activeTasks` map and the `sendMessage` entry point — is tiny.

### 3. Connectors: one directory per external system

Each external system gets its own subdirectory under `connectors/` containing *everything* for that integration — API client, event handling, domain logic.

- `connectors/slack/` — API client, Bolt app, events, buttons
- `connectors/github/` — API client, webhooks, worktrees, merging

Connectors receive external events, call `sendMessage`, and export outbound APIs (like `postToSlack`) that tools import directly.

### 4. Unified agent registry — scan fresh every time

Replace three config modules (`plugin-loader` → `repo-configs` → `plugin-configs`) with one `agents/registry.ts` producing one `AgentDef` type.

**Startup**: scan plugins, validate. Fail-fast on broken config.

**Per-task**: scan fresh from disk every time a task starts or restarts. A restarted task picks up the latest agent definitions, fixed prompts, newly added agents.

### 5. Single agent spawner

Replace three near-identical spawners (`pm.ts`, `repo-agent.ts`, `plugin-agent.ts`) with one `spawnAgent()` that branches on `def.track`. Session recovery logic appears once instead of three times.

### 6. Co-located tools

Tool definitions and implementations live together in `agents/tools.ts`. Each tool is a self-contained function. To understand a tool, read one function in one file.

### 7. Merged persistence

Combine `task-manager.ts` + `task-persistence.ts` into `tasks/persistence.ts`. All task disk I/O in one place.

## Dependency Flow

```
            index.ts
               |
          mounts connectors
           ╱          ╲
          ↓            ↓
    connectors/     connectors/
      slack/          github/
          ╲           ╱
        sendMessage()
               |
               ↓
          tasks/task
          ╱         ╲
         ↓           ↓
     agents/     tasks/persistence
   (registry,   tasks/recovery
    spawn,       tasks/message-queue
    tools)
```

Connectors call `sendMessage`. The task spawns agents and delivers messages. Tools import connectors and persistence directly. All one-way.

## What Changes, What Doesn't

**Changes:**
- `connectors/slack/` absorbs `slack/client.ts` + event handling from `server.ts` and `event-handler.ts`
- `connectors/github/` absorbs `github/*` + webhook routing from `webhook-router.ts` and `webhook-utils.ts`
- `index.ts` absorbs server setup from `system/server.ts`
- `tasks/task.ts` replaces god module `task-runtime.ts` — centered around `sendMessage`
- `tasks/persistence.ts` merges scattered persistence modules
- `agents/` replaces three spawners + three config builders + separated tool defs/impls
- `mcp/tools.ts` deleted — all tools move to `agents/tools.ts`
- `AgentDef` replaces `RepoAgentConfig` and `PluginAgentConfig`

**Unchanged:**
- SDK patterns (streaming, session recovery, MCP)
- Triage (stateless classifier, moves to `system/`)
- Workdir bootstrap
- All edge cases (edit mode, worktree creation, progressive recovery, debounced writes, legacy compat)
- Prompts, utils
