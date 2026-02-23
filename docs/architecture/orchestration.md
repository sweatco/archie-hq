# System Orchestration

How Archie routes messages, manages tasks, spawns agents, and recovers from failures.

> Source of truth: the code in `src/system/` and `src/mcp/`. This document describes
> only what is implemented, not aspirational features.

---

## System Layer Responsibilities

| Layer | Source | Purpose |
|---|---|---|
| **HTTP Server** | `src/system/server.ts` | Slack Bolt receiver (HTTP mode) + Express endpoints for GitHub webhooks and health checks |
| **Webhook Router** | `src/system/webhook-router.ts` | Fast, code-only routing: discard / triage / direct-handle for both Slack and GitHub events |
| **Event Handler** | `src/system/event-handler.ts` | Inline processing of Slack and GitHub triage results (no intermediate queues) |
| **Task Runtime** | `src/system/task-runtime.ts` | In-memory state management, agent spawning, tool callback wiring, task lifecycle (create/stop/complete) |
| **Active Tasks Registry** | `src/system/active-tasks.ts` | Global `Map<string, TaskRuntimeState>` shared across modules to avoid circular imports |
| **Task Manager** | `src/system/task-manager.ts` | Disk I/O: directory layout helpers, metadata read, knowledge-log append, task lookup by thread/PR |
| **Task Persistence** | `src/system/task-persistence.ts` | Debounced metadata writes (500 ms coalescing) |
| **Task Recovery** | `src/system/task-recovery.ts` | Startup recovery + idle detection + progressive recovery (reinforcement then nuclear restart) |
| **Message Queue** | `src/system/message-queue.ts` | Per-agent async producer-consumer queues with replay support |
| **MCP Tools** | `src/mcp/tools.ts` | Custom MCP tool definitions exposed to agents via the Claude Agent SDK |
| **Logger** | `src/system/logger.ts` | Unified, color-coded, semantic logging for all system and agent events |

---

## In-Memory State: TaskRuntimeState

Every active task is represented by a `TaskRuntimeState` instance stored in the global
`activeTasks` map (`src/system/active-tasks.ts`).

```typescript
// src/system/active-tasks.ts

interface TaskBudgets {
  researchRequestCount: number;     // web_research calls made
  researchRequestLimit: number;     // default: 5 (extended +5 per Slack approval)
  interAgentMessageCount: number;   // send_message_to_agent calls
  interAgentMessageLimit: number;   // default: 100
  taskStartTime: Date;              // wall-clock timeout anchor
  taskTimeoutMs: number;            // default: 1_800_000 (30 minutes)
}

interface TaskRuntimeState {
  taskId: string;
  metadata: TaskMetadata;                       // persisted to disk (debounced)

  queues: Map<AgentName, MessageQueue>;         // per-agent message queues
  handles: Map<AgentName, AgentHandle>;         // running agent process handles
  sessions: Map<AgentName, AgentSessionState>;  // session IDs + active flags
  spawned: Set<AgentName>;                      // agents spawned this lifecycle

  lastActivity: Date;
  isActive: boolean;                            // false after stop/complete

  budgets: TaskBudgets;                         // Defense 4 resource limits
  timeoutInterval?: ReturnType<typeof setInterval>;  // 60s wall-clock checker
  recoveryAttempts: number;                     // consecutive idle-recovery count
}
```

Key design choices:
- `metadata` is the in-memory authority while a task is active; disk is a crash-recovery checkpoint.
- `queues` are initialized for **all** known agents (PM + every repo agent + every plugin agent) at task creation, regardless of whether those agents are spawned.
- `sessions` is populated from `metadata.agent_sessions` on load and synced back before every disk write.

---

## Message Routing Flow

### Slack Messages

```
Slack webhook (POST /webhooks/slack)
  --> Slack Bolt event handler (app_mention or message)
    --> routeSlackEvent()          [webhook-router.ts]
        - discard own bot messages
        - everything else -> triage
    --> processSlackTriage()       [event-handler.ts]
        - fetch channel info, clean text, fetch thread history
        - triageSlackMessage()     [agents/triage.ts] classifies action:
            new_task     -> handleNewTask()     -> createTask() + sendMessage(pm-agent)
            existing_task-> handleExistingTask()-> loadTask() + append to knowledge.log + sendMessage(pm-agent)
            cancel_task  -> handleCancelTask()  -> stopTask()
            noop         -> log and discard
```

Thread replies without an @mention are handled via the `message` event listener and
follow the same pipeline. Messages that contain a bot mention are skipped by the
`message` handler (the `app_mention` handler processes them instead).

### GitHub Events

```
GitHub webhook (POST /webhooks/github)
  --> signature verification
  --> routeGitHubEvent()           [webhook-router.ts]
      - discard own bot events (GITHUB_APP_SLUG[bot])
      - extract branch name, derive task ID from branch pattern
      - for issue_comment without branch: findTaskByPRNumber()
      - determineRouteAction() based on event type:
          pull_request_review (approved)    -> merge_check (direct)
          pull_request_review (changes_req) -> existing_task (direct)
          pull_request_review_comment       -> existing_task (direct)
          issue_comment (created)           -> triage_comment (needs triage)
          pull_request (opened/synchronize) -> merge_check (direct)
          push                              -> merge_check (direct)
          workflow_run (completed, failure)  -> existing_task (direct)
          workflow_run (completed, success)  -> merge_check (direct)
```

Direct-route events skip triage entirely and are handled by `handleExistingTaskDirect()`
or `handleMergeCheckDirect()` in `server.ts`. Only `issue_comment` events go through
`processGitHubTriage()` (which calls `triageGitHubComment()` to filter conversational noise).

---

## Message Queue System

**Source**: `src/system/message-queue.ts`

Each agent has a dedicated `MessageQueue` instance -- a simple in-memory async
producer-consumer queue. An earlier iteration used an external message broker
(RabbitMQ/Redis), but this proved overkill for the system's needs and was
replaced with the current straightforward in-process implementation.

### Core interface

```typescript
interface QueuedMessage {
  content: string;
  timestamp: string;
  from?: string;       // source agent name (for inter-agent messages)
}

class MessageQueue {
  addMessage(content, from?)       // enqueue; resolves pending waiter immediately if one exists
  prependMessage(content, from?)   // push to front (for message replay on retry)
  nextMessage(): Promise<QueuedMessage>  // blocks until a message is available
  hasMessages(): boolean
  pendingCount(): number
  stop()                           // rejects all pending resolvers, clears queue
  reset()                          // re-enables a stopped queue for reuse
  isStopped(): boolean
}
```

### Async producer-consumer

When an agent calls `nextMessage()` and the queue is empty, the call blocks on a
`Promise` stored in `pendingResolvers[]`. When a producer calls `addMessage()`, it
either resolves the first pending resolver (immediate delivery) or buffers the message.

### Message replay with RecoverableInputGenerator

For SDK retry resilience, `createRecoverableInputGenerator()` wraps a queue into a
generator that tracks consumed messages. On retry, calling `reset()` prepends all
consumed messages back to the front of the queue in their original order.

```typescript
interface RecoverableInputGenerator {
  reset(): void;                                    // return consumed messages to queue
  generator(): AsyncGenerator<SDKUserMessageInput>;  // yields formatted SDK input
}
```

Messages are formatted as SDK `user` messages, with the `from` field prepended to
content: `[From pm-agent]: <message>`.

### Queue lifecycle

- Queues are created for all known agents when a task is built (`buildRuntime()`).
- `queue.stop()` is called during `stopTask()` / `completeTask()`, causing agent
  generators to exit gracefully.
- `queue.reset()` is not currently called at the system level (used internally
  by `RecoverableInputGenerator`).

---

## Agent Session Management

### Spawning

`ensureAgentSpawned()` in `task-runtime.ts` is the single entry point for starting agents.
It is idempotent: if `runtime.spawned` already contains the agent, it returns immediately.

```
ensureAgentSpawned(runtime, agentName)
  --> create tool callbacks
  --> check for existing session ID (for SDK resume)
  --> classify agent type:
      - repo agent   -> spawnRepoAgent()
      - pm-agent     -> spawnPMAgent()
      - plugin agent -> spawnPluginAgent()
  --> register handle in runtime.handles
  --> add to runtime.spawned
  --> attach crash handler: handle.running.then(() => updateAgentState(inactive))
```

### Resuming

If `runtime.sessions` already contains a `session_id` for the agent, that ID is passed
to the spawn function so the Claude Agent SDK resumes the existing conversation instead
of starting fresh.

### Interrupting

Agents are interrupted by stopping their queues. When `queue.stop()` is called, the
`nextMessage()` promise rejects, causing the agent's async generator to exit. The
`handle.running` promise then resolves, triggering the crash handler which calls
`updateAgentState(runtime, agentName, false)`.

### State tracking

`updateAgentState()` updates the in-memory session, triggers a debounced persist, and
(on deactivation) schedules an idle check. During server shutdown, deactivation writes
are skipped so that recovery sees the correct pre-shutdown state.

---

## MCP Tool Implementation

Tools are defined in `src/mcp/tools.ts` and exposed via MCP servers created per agent type.

### PM Agent Tools (via `createPMAgentMcpServer`)

| Tool | Description |
|---|---|
| `send_message_to_agent` | Send a message to another agent (spawns target if needed) |
| `post_to_slack` | Post a message to the task's Slack thread(s) |
| `assign_task_owner` | Assign a repo/plugin agent as task owner |
| `report_completion` | Optionally post to Slack, then complete the task |
| `request_edit_mode` | Post Approve/Deny buttons to Slack, pause task until response |
| `get_agents_status` | Return active/idle status of all spawned agents |
| `push_branch` | Push commits from local worktree to origin (GIT_ASKPASS auth) |
| `create_pull_request` | Create a GitHub PR and store PR number in metadata |
| `get_pr_status` | Get PR state, mergeable status, approval status |
| `get_pr_reviews` | Fetch all reviews and line-level comments on a PR |
| `update_pr_description` | Update the body of a PR |
| `add_pr_comment` | Add a general comment to a PR |
| `add_review_comment` | Add a comment on a specific file line in a PR |
| `resolve_review_thread` | Mark a review comment thread as resolved |
| `request_re_review` | Request reviewers to re-review after changes |
| `trigger_merge_check` | Check all linked PRs and merge any that are ready |

### Repo Agent Tools (via `createRepoAgentMcpServer`)

| Tool | Description |
|---|---|
| `send_message_to_agent` | Send a message to another agent |
| `log_finding` | Write an entry to the shared knowledge log (discovery, decision, completion, blocker) |

### Callback architecture

All tools delegate to callback functions (`PMToolCallbacks` / `RepoAgentToolCallbacks`)
created per agent per task by `createToolCallbacks()` in `task-runtime.ts`. This
decouples tool definitions from runtime state, enabling testing and isolation.

### Research budget (Defense 4)

The `checkResearchBudget`, `incrementResearchCount`, and `onResearchBudgetExceeded`
callbacks are wired into all agents via `BaseToolCallbacks`. When the budget is
exceeded, the system posts Slack interactive buttons (Approve +5 / Deny) and stops
the task. Approval increments `metadata.research_budget_extra` by 5 and reactivates.

### Inter-agent message budget

`send_message_to_agent` increments `budgets.interAgentMessageCount`. When it exceeds
`budgets.interAgentMessageLimit` (default: 100), a warning is posted to Slack but the
message is not blocked (advisory limit).

---

## Agent Idle Detection and Recovery

**Source**: `src/system/task-recovery.ts`

### Agent deactivation trigger

When an agent finishes its turn, the SDK fires a Stop hook. The agent's `onIdle`
callback calls `updateAgentState(runtime, agentName, false)`, which in turn calls
`scheduleIdleCheck(runtime)`.

Additionally, when an agent's background process exits (the `handle.running` promise
resolves), the crash handler calls `updateAgentState(runtime, agentName, false)`.

### scheduleIdleCheck

A 3-second delay is applied before checking, to avoid racing with message delivery
(another agent may be about to send a message that wakes this one).

```typescript
function scheduleIdleCheck(runtime: TaskRuntimeState): void {
  setTimeout(async () => {
    if (!runtime.isActive || getIsShuttingDown()) return;
    const allInactive = checkAllAgentsInactive(runtime);
    if (allInactive) {
      await triggerRecovery(runtime);
    }
  }, 3000);
}
```

`checkAllAgentsInactive()` returns `true` only if `spawned.size > 0` and every
spawned agent's session has `active === false`.

### Progressive recovery

| Attempt | Strategy | Action |
|---|---|---|
| 1-2 | **Reinforcement** | Nudge the lead agent (task owner or PM) by adding a prompt to its queue. If the agent process is dead (`handle.isRunning === false`), skip to attempt 2 immediately. |
| 3+ | **Nuclear** | Clear all sessions in memory, stop the task, reload from disk, and re-spawn agents via `recoverTaskAgents()`. Resets `recoveryAttempts` to 0. |

### Reinforcement nudge

The system checks `handle.isRunning` before nudging. If the agent process is alive,
it adds either `AGENT_PROMPTS.reinforcePM` or `AGENT_PROMPTS.reinforceAgent` to the
agent's queue and marks the agent active. If the process is dead, it sets
`recoveryAttempts = 2` to fast-track to nuclear on the next idle check.

---

## Task Recovery on Server Restart

**Source**: `src/system/task-recovery.ts` -- `recoverActiveTasks()`

Called once during server startup after the HTTP server is ready.

```
recoverActiveTasks()
  --> findTasksByStatus('in_progress')   // grep across sessions/task-*/shared/metadata.json
  --> for each task:
      --> loadTask(task_id)              // build runtime from disk metadata
      --> recoverTaskAgents(runtime)
          --> for each session where active === true:
              sendMessage(runtime, agentName, AGENT_PROMPTS.recovery)
          --> if no agents were active (stale metadata):
              sendMessage(runtime, 'pm-agent', AGENT_PROMPTS.recovery)
```

During graceful shutdown (`stopServer()`), `isShuttingDown` is set to `true`. This
causes `updateAgentState()` to skip deactivation writes, preserving the `active: true`
state in metadata so that recovery on restart correctly re-spawns those agents.

---

## Webhook Routing

**Source**: `src/system/webhook-router.ts`

### Slack routing

```typescript
type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };
```

All Slack messages go to triage unless they are from the bot itself (matched by `bot_id`).

### GitHub routing

```typescript
type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage'; taskId: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string };
```

The router extracts a task ID from the branch name pattern (`feature/task-{id}`) or,
for `issue_comment` events, looks up the task by PR number via `findTaskByPRNumber()`.

**Deterministic routing** (no triage needed):
- `pull_request_review` (approved) -> `merge_check`
- `pull_request_review` (changes_requested / commented) -> `existing_task`
- `pull_request_review_comment` -> `existing_task`
- `pull_request` (opened / synchronize) -> `merge_check`
- `push` -> `merge_check`
- `workflow_run` (completed, success) -> `merge_check`
- `workflow_run` (completed, failure) -> `existing_task`

**Triage-based routing** (needs AI classification):
- `issue_comment` (created) -> `triage` (filters conversational noise)

Events from the system's own GitHub App bot (`GITHUB_APP_SLUG[bot]`) are discarded
to prevent infinite loops.

---

## Task Lifecycle States and Transitions

**Source**: `src/types/task.ts`

```typescript
type TaskStatus = 'in_progress' | 'stopped' | 'completed';
```

### State transitions

```
                    +--> stopped --+
                    |              |
  (create) --> in_progress        +--> in_progress  (loadTask reactivates)
                    |
                    +--> completed
```

| Transition | Trigger | Function |
|---|---|---|
| `-> in_progress` | New task created | `createTask()` |
| `-> in_progress` | Stopped task reactivated | `loadTask()` (sets `metadata.status = 'in_progress'` in `buildRuntime()`) |
| `-> stopped` | User cancels, edit mode request, budget exceeded, wall-clock timeout | `stopTask()` |
| `-> completed` | PM calls `report_completion` | `completeTask()` |

Both `stopTask()` and `completeTask()`:
1. Set `runtime.isActive = false`
2. Clear the wall-clock timeout interval
3. Deactivate all agents in-memory
4. Stop all queues (agents exit gracefully)
5. Flush metadata to disk with the new status
6. Remove the task from `activeTasks`

### Wall-clock timeout

A 60-second interval checks elapsed time against `budgets.taskTimeoutMs` (30 minutes
default). On timeout, a message is posted to Slack and `stopTask()` is called.

---

## Logger System

**Source**: `src/system/logger.ts`

A singleton `Logger` class provides color-coded, semantic methods. Colors are applied
via `picocolors` and respect `NO_COLOR` / non-TTY environments.

### Logger methods

| Method | Prefix color | Purpose |
|---|---|---|
| `system(msg)` | dim `[System]` | System events (task created, agent spawned, recovery) |
| `slack(msg)` | cyan `[Slack]` | Slack integration events |
| `server(msg)` | dim `[Server]` | Server-level events (button clicks, webhook handling) |
| `worktree(msg)` | dim `[worktree-manager]` | Git worktree operations |
| `agent(name, msg)` | agent color | Generic agent log |
| `agentTool(name, tool, input)` | agent color | SDK tool calls (Read, Write, Edit, Grep, Glob, Bash, Skill, Task, WebSearch, WebFetch) |
| `agentMessage(from, to, msg)` | agent colors | Inter-agent messages |
| `agentFinding(name, type, entry)` | agent + yellow type | Knowledge log entries |
| `agentAction(name, action, details)` | agent color | Agent actions (assign owner, request edit mode) |
| `agentToSlack(name, msg)` | agent + cyan `[Slack]` | Agent posting to Slack |
| `error(prefix, msg, err?)` | red | Errors |
| `warn(prefix, msg, err?)` | yellow | Warnings |
| `plain(msg)` | none | Startup messages, undecorated output |
| `debug(prefix, msg, data?)` | dim | Debug/diagnostic output |

### Agent colors

| Agent | Color |
|---|---|
| `pm-agent` | magenta |
| `backend-agent` | green |
| `mobile-agent` | cyan |
| `triage-agent` | yellow |
| Unknown agents | green (default) |

Agent labels include a mode suffix when applicable: `:ro` (read-only) in agent color,
`:rw` (read-write) in red.

### Subagent tracking

`processAgentEventForLogging()` tracks `Task` tool calls by their `tool_use_id` and
labels subsequent events from subagents with a numbered suffix (e.g.,
`backend-agent/researcher#1`). Only SDK tools are logged; MCP tools (prefixed `mcp__`)
are filtered out.

---

## Related Documents

- [Task Persistence](./persistence.md) -- file layout, metadata schema, debounced writes
