# System Orchestration

How Archie routes messages, manages tasks, spawns agents, and recovers from failures.

> Source of truth: the code in `src/tasks/`, `src/agents/`, `src/connectors/`, and `src/system/`.
> This document describes only what is implemented, not aspirational features.

---

## System Layer Responsibilities

| Layer | Source | Purpose |
|---|---|---|
| **HTTP Server** | `src/index.ts` | Express app, workdir bootstrap, plugin/repo cloning, health check, GitHub webhook mount, Slack Bolt mount, recovery, reminder scheduler |
| **Workdir Bootstrap** | `src/system/workdir.ts` | Resolves `ARCHIE_WORKDIR`, clones plugins from `ARCHIE_PLUGINS`, clones repos declared by plugins, refreshes plugins via an `ls-remote` HEAD check (`refreshPlugins`, orchestrated by `syncPlugins` in `src/system/plugin-sync.ts`) |
| **Slack Events** | `src/connectors/slack/events.ts` | Slack Bolt receiver, event handlers (app_mention/message), interactive button actions, direct routing to PM (triage disabled) |
| **GitHub Events** | `src/connectors/github/events.ts` | GitHub webhook dispatch, direct existing-task handler (with `issue_comment` dedup) |
| **GitHub Webhooks** | `src/connectors/github/webhooks.ts` | Signature verification, deterministic routing, event formatting, merge check debouncing |
| **Task** | `src/tasks/task.ts` | Task class: in-memory state, agent spawning, tool callbacks, lifecycle (create/stop/complete) |
| **Task Persistence** | `src/tasks/persistence.ts` | Disk I/O: metadata, knowledge log, events JSONL, debounced writes, task lookup by thread/PR |
| **Task Recovery** | `src/tasks/recovery.ts` | Startup recovery + idle detection + progressive recovery (reinforcement then nuclear restart) |
| **Task Launch** | `src/tasks/launch.ts` | Launch a new background task from within an existing one |
| **Event Bus** | `src/system/event-bus.ts` | Typed in-process EventEmitter for system events (task/agent/message/approval/reminder); SSE clients and JSONL persistence subscribe |
| **Reminder Scheduler** | `src/system/reminder-scheduler.ts` | In-memory index of pending reminders backed by metadata; 1-minute interval fires due reminders by reactivating tasks |
| **Shutdown** | `src/system/shutdown.ts` | Process-wide `isShuttingDown` flag; tasks suppress deactivation writes during shutdown so recovery sees the correct pre-shutdown state |
| **Message Queue** | `src/agents/message-queue.ts` | Per-agent async producer-consumer queues with replay support |
| **MCP Tools** | `src/agents/tools.ts` | Custom MCP tool definitions exposed to agents via the Claude Agent SDK |
| **Logger** | `src/system/logger.ts` | Unified, color-coded, semantic logging for all system and agent events |

---

## In-Memory State: Task Class

Every active task is represented by a `Task` instance stored in a global `activeTasks` map
within `src/tasks/task.ts`.

```typescript
// src/tasks/task.ts

class Task {
  readonly taskId: string;
  metadata: TaskMetadata;                          // persisted to disk (debounced)

  readonly agentProcesses: Map<AgentName, Agent>;  // lazily-created Agent instances
  team: AgentDef[];                                // scanned defs for this task

  lastActivity: Date;
  isActive: boolean;                               // false after stop/complete

  budgets: TaskBudgets;                            // Defense 4 resource limits
  taskTimeoutTimer?: ReturnType<typeof setInterval>; // 60s wall-clock checker
  recoveryAttempts: number;                        // consecutive idle-recovery count
}
```

Each `Agent` (`src/agents/agent.ts`) owns its own `MessageQueue`, SDK `handle`, `session`
state, and `sandbox` config — the Task does not hold separate maps for those.

Key design choices:
- `metadata` is the in-memory authority while a task is active; disk is a crash-recovery checkpoint.
- `Agent` instances are created **lazily** in `ensureAgentSpawned()` on the first message
  routed to that agent — not eagerly at task creation. Each new `Agent` constructs its
  own `MessageQueue`.
- An agent's `session` is restored from `metadata.agent_sessions[id]` on first spawn and
  synced back into metadata before every disk write (`save()` / `debouncedSave()`).

---

## Message Routing Flow

### Slack Messages

> **Note:** The triage agent (`src/system/triage.ts`) is currently **disabled**.
> Slack messages route directly to the PM agent without intent classification.
> The triage call site in `connectors/slack/events.ts` is preserved as a commented-out
> block for re-enablement.

```
Slack webhook (POST /webhooks/slack)
  --> Slack Bolt event handler (app_mention or message)
    --> routeSlackEvent()          [connectors/slack/events.ts]
        - discard own bot messages (matched by bot_id)
        - everything else -> triage (returned action; triage is the only non-discard route)
    --> handleSlackEvent()         [connectors/slack/events.ts]
        - bail out if author is external/guest in a shared channel
        - add :eyes: reaction (remove from previous message in same thread)
        - fetchSlackThread() — full thread history with redaction
        - findTaskByThread(threadId):
            existing task -> Task.get() + append() new messages + sendMessage(pm-agent, existingTask)
            no task, and (app_mention OR DM) -> Task.create() + append() + sendMessage(pm-agent, newTask)
            no task, plain channel reply -> ignore (bot was never in this thread)
        - shared-channel ephemeral warnings (per user, per thread)
        - fire-and-forget title generation (Haiku) on first message
```

Thread replies without an @mention are handled via the `message` event listener and
follow the same pipeline. In channels, messages containing the bot mention are skipped
by the `message` handler (the `app_mention` handler processes them); in DMs the
`message` handler processes mention-containing events too because `app_mention` does
not fire for DMs.

### GitHub Events

```
GitHub webhook (POST /webhooks/github)
  --> signature verification
  --> routeGitHubEvent()           [connectors/github/webhooks.ts]
      - discard own bot events (GITHUB_APP_SLUG[bot])
      - extract branch name, derive task ID from branch pattern
      - for issue_comment without branch: findTaskByPRNumber()
      - determineRouteAction() based on event type:
          pull_request_review (approved)    -> merge_check (direct)
          pull_request_review (changes_req) -> existing_task (direct)
          pull_request_review_comment       -> existing_task (direct)
          issue_comment (created)           -> existing_task (direct)
          pull_request (opened/synchronize) -> merge_check (direct)
          pull_request (closed)             -> existing_task (direct)
          push                              -> merge_check (direct)
          workflow_run (completed, failure)  -> existing_task (direct)
          workflow_run (completed, success)  -> merge_check (direct)
```

All GitHub routes are deterministic — there is no triage step. Events are handled by
`handleExistingTaskDirect()` in `connectors/github/events.ts` or `handleMergeCheckDirect()`
in `connectors/github/webhooks.ts`. `issue_comment` events go through `handleExistingTaskDirect()`,
which deduplicates by `last_processed_comment_id` before logging and waking the PM.

---

## Message Queue System

**Source**: `src/agents/message-queue.ts`

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

- Each `Agent` constructs its own `MessageQueue` in its constructor; agents are
  created lazily on first message in `Task.ensureAgentSpawned()`, so queues exist
  only for agents the task has actually addressed.
- `queue.stop()` is called for every agent in `task.agentProcesses` during
  `task.stop()` / `task.complete()`, causing the agent's generator to exit gracefully.
- `queue.reset()` is not currently called at the system level (used internally
  by `RecoverableInputGenerator` to replay messages on retry).

---

## Agent Session Management

### Spawning

`task.ensureAgentSpawned()` in `src/tasks/task.ts` is the single entry point for starting agents.
It is idempotent — `Agent.spawn()` short-circuits when `agent.isRunning` is already true.

```
task.ensureAgentSpawned(agentName)
  --> get-or-create the Agent in task.agentProcesses (lazy — first message triggers creation)
  --> agent.spawn(task)  [src/agents/agent.ts]
      --> short-circuit if already running
      --> hydrate agent.session from metadata.agent_sessions if not set
      --> add agentName to metadata.participants
      --> spawnAgent(agent, task)  [src/agents/spawn.ts]
          --> task.updateAgentState(id, true) early — prevents false idle detection
          --> build track-specific config (prompt, cwd, tools, MCP servers, sandbox)
          --> for repo track: set up shared clone (or migrate legacy worktree)
          --> start SDK query() with session-recovery retry loop
          --> install Stop hook -> task.updateAgentState(id, false) on each idle
      --> attach crash handler: handle.running.then(() => task.updateAgentState(id, false))
      --> task.debouncedSave()
```

### Resuming

If `agent.session.session_id` is set (either from a previous spawn or hydrated from
`metadata.agent_sessions[id]`), that ID is passed as `resume` to the SDK so the
Claude Agent SDK resumes the existing conversation instead of starting fresh. On
failure, the recovery loop in `spawn.ts` clears the bad session and retries fresh
exactly once.

### Interrupting

Agents are interrupted by stopping their queues. When `agent.queue.stop()` is called
(from `task.stop()` / `task.complete()`), the pending `nextMessage()` promise rejects,
the recoverable input generator returns, and the SDK `query()` loop exits. The
`handle.running` promise then resolves, triggering the crash handler which calls
`task.updateAgentState(agentName, false)`.

### State tracking

`task.updateAgentState()` updates `agent.session` via `agent.updateSession()`, emits
either `agent:active` or `agent:inactive` on the event bus, triggers a debounced persist,
and (on deactivation) schedules an idle check. During server shutdown, deactivation
calls return early so the metadata keeps `active: true`, letting recovery on restart
re-spawn those agents.

---

## MCP Tool Implementation

Tools are defined in `src/agents/tools.ts` and exposed via MCP servers created per agent type.

### PM Agent Tools (via `createPMAgentMcpServer`, named `pm-agent-tools`)

| Tool | Description |
|---|---|
| `send_message_to_agent` | Send a message to another agent (spawns target if needed) |
| `post_to_user` | Post a message to the user — default channel, an existing linked thread, a new DM, or a new thread in a channel (`target.channel` / `target.new_dm` / `target.new_thread`). Default is where the task lives; `new_dm`/`new_thread` are reserved for explicit user requests or cases a loaded skill/workflow requires |
| `post_files_to_user` | Upload one or more files as Slack attachments to an already-linked channel; does not open new threads |
| `share_artifact` | Publish an immutable snapshot to `shared/artifacts/` for inter-agent file sharing (deduped by hash) |
| `find_slack_user` / `find_slack_channel` | Look up Slack user/channel metadata (used before opening new DMs/threads) |
| `assign_task_owner` | Assign a repo/plugin agent as task owner |
| `report_completion` | Optionally post a final message via `post_to_user`, then complete the task |
| `request_edit_mode` | Post Approve/Deny buttons to the default channel and stop the task until the user responds |
| `get_agents_status` | Return active/idle status of all spawned agents |
| `mute_channel` | Stop processing a Slack channel/thread until the bot is @mentioned there again. Takes optional `channel` key; defaults to the task's `default_channel`. DM channels cannot be muted |
| `launch_task` | Start a new background task (delegates to `src/tasks/launch.ts`). Reserved for explicit user requests or workflow-driven background work — follow-up work normally stays in the current task to preserve the trace |
| `parse_datetime` / `set_reminder` / `cancel_reminder` | Schedule/cancel reactivation of the task at a future time (via `src/system/reminder-scheduler.ts`) |

Outbound posting flow: PM-style tools (`post_to_user`, `post_files_to_user`,
`postInteractiveToUser`) call directly into the Slack client in
`src/connectors/slack/client.ts` (`postSlackMessage`, `postSlackFiles`,
`postInteractiveToThreads`). There is no intermediate event-bus indirection on the
outbound path — the connector is invoked synchronously and the resulting
`message` / `approval:requested` event is then emitted on the bus for observers
(SSE, JSONL persistence).

### Base Agent Tools (via `createBaseAgentMcpServer`, named `repo-agent-tools`)

Used by both repo agents and plugin agents:

| Tool | Description |
|---|---|
| `send_message_to_agent` | Send a message to another agent |
| `log_finding` | Write an entry to the shared knowledge log (discovery, decision, completion, blocker) |
| `share_artifact` | Publish an immutable file snapshot to `shared/artifacts/` for inter-agent sharing |

### Repo Tools (via `createRepoToolsMcpServer`, named `repo-tools`)

Used by repo agents only. Access controlled by `allowedTools` at spawn time:

| Tool | Availability | Description |
|---|---|---|
| `fetch` | Always | Fetch latest refs from origin |
| `switch_branch` | Always | Switch branches with auto-stash/pop |
| `list_prs` | Always | List PRs with optional filters |
| `get_pr` | Always | Get full PR details including diff |
| `get_pr_status` | Always | Get PR state, mergeable status, approval status |
| `get_pr_reviews` | Always | Fetch all reviews and line-level comments on a PR |
| `get_pr_comments` | Always | Fetch general (issue-style) comments on a PR |
| `get_review_threads` | Always | Fetch review-comment threads with resolution state |
| `push_branch` | Edit mode | Push commits from the local shared clone to origin |
| `create_pull_request` | Edit mode | Create a GitHub PR and store PR number in branch state |
| `update_pr` | Edit mode | Update the title and/or description of a PR |
| `add_pr_comment` | Edit mode | Add a general comment to a PR |
| `add_review_comment` | Edit mode | Add a comment on a specific file line in a PR |
| `reply_to_review_comment` | Edit mode | Reply inline to an existing review-comment thread |
| `resolve_review_thread` | Edit mode | Mark a review comment thread as resolved |
| `request_re_review` | Edit mode | Request reviewers to re-review after changes |
| `merge_pull_request` | Edit mode | Merge a PR (checks mergeability first) |
| `close_pull_request` | Edit mode | Close a PR without merging |
| `create_branch` | Edit mode | Create a new branch (auto-named) and switch to it |
| `list_branches` | Edit mode | List branches in the current task |

### Tool architecture

Tools are defined as self-contained functions in `src/agents/tools.ts`. Each tool receives
the `Agent` and `Task` instances directly, importing external systems (GitHub, Slack,
persistence) as needed. The MCP servers are created per agent per task at spawn time.

### Research budget (Defense 4)

The `checkResearchBudget`, `incrementResearchCount`, and `onResearchBudgetExceeded`
callbacks are wired into the `research-tools` MCP server (created in `spawn.ts` via
`createResearchMcpServer({ ... })` for every track — PM, repo, plugin). When the
budget is exceeded, `task.onResearchBudgetExceeded()` posts Slack interactive
buttons (Approve +5 / Deny) and stops the task. Approval increments
`metadata.research_budget_extra` by 5 and reactivates the task.

### Inter-agent message budget

`send_message_to_agent` increments `budgets.interAgentMessageCount`. When it exceeds
`budgets.interAgentMessageLimit` (default: 100), a warning is posted to Slack but the
message is not blocked (advisory limit).

---

## Agent Idle Detection and Recovery

**Source**: `src/tasks/recovery.ts`

### Agent deactivation trigger

When an agent finishes its turn, the SDK fires the Stop hook installed in
`spawn.ts`, which calls `task.updateAgentState(agentName, false)`. That in turn
calls `scheduleIdleCheck(task)` whenever `active` flips to `false`.

Additionally, when an agent's background process exits (the `handle.running` promise
resolves), the crash handler wired in `Agent.spawn()` (`src/agents/agent.ts`) calls
`task.updateAgentState(agentName, false)`.

### scheduleIdleCheck

A 3-second delay is applied before checking, to avoid racing with message delivery
(another agent may be about to send a message that wakes this one).

```typescript
function scheduleIdleCheck(task: Task): void {
  setTimeout(async () => {
    if (!task.isActive || getIsShuttingDown()) return;
    const allInactive = checkAllAgentsInactive(task);
    if (allInactive) {
      await triggerRecovery(task);
    }
  }, 3000);
}
```

`checkAllAgentsInactive()` returns `true` only if `task.agentProcesses.size > 0`
and every spawned agent's `session.active === false`.

### Progressive recovery

| Attempt | Strategy | Action |
|---|---|---|
| 1-2 | **Reinforcement** | Nudge the lead agent (task owner or PM) by adding a prompt to its queue. If the agent process is dead (`agent.isRunning === false`), bump `recoveryAttempts` to 2 so the next idle check goes nuclear. |
| 3+ | **Nuclear** | Reset `recoveryAttempts` to 0, call `task.stop()`, reload the task from disk via `Task.get()`, and re-spawn agents via `recoverTaskAgents()`. |

### Reinforcement nudge

The system reads `agent.isRunning` (which delegates to `handle.isRunning`) before
nudging. If the SDK process is alive, it adds either `AGENT_PROMPTS.reinforcePM` or
`AGENT_PROMPTS.reinforceAgent` to `agent.queue` and calls `agent.updateSession(true)`
followed by `task.save()` so the active state is persisted. If the process is dead,
it sets `task.recoveryAttempts = 2` to fast-track to nuclear on the next idle check.

---

## Task Recovery on Server Restart

**Source**: `src/tasks/recovery.ts` -- `recoverActiveTasks()`

Called once during server startup from `src/index.ts`, after the HTTP server is ready
and before `initReminderScheduler()`.

```
recoverActiveTasks()
  --> findTasksByStatus('in_progress')      // grep across sessions/task-*/shared/metadata.json
  --> for each task:
      --> Task.get(task_id)                 // build Task from disk metadata
      --> recoverTaskAgents(task)
          --> for each entry in metadata.agent_sessions where active === true:
              task.sendMessage(AGENT_PROMPTS.recovery, agentName)
              // sendMessage activates the task and lazily creates+spawns the Agent
          --> if no agents were active (stale metadata):
              task.sendMessage(AGENT_PROMPTS.recovery, 'pm-agent')
```

During graceful shutdown, `setShuttingDown(true)` flips the `isShuttingDown` flag in
`src/system/shutdown.ts`. `task.updateAgentState()` then short-circuits when called
with `active = false`, leaving `active: true` in metadata so that the next startup's
recovery correctly re-spawns those agents. The Slack `app_mention`/`message` handlers
also check this flag and skip processing during shutdown.

---

## Webhook Routing

### Slack routing

**Source**: `src/connectors/slack/events.ts` (inline `routeSlackEvent()`)

```typescript
type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };
```

The router only filters out the bot's own messages (matched by `bot_id`). Everything
else returns `{ action: 'triage' }`, but the AI triage step is currently **disabled**
— `handleSlackEvent()` routes the message directly to the PM agent based on whether
a task already exists for the Slack thread (see "Slack Messages" above). The
`'triage'` label is retained as a placeholder for when classification is re-enabled.

### GitHub routing

**Source**: `src/connectors/github/webhooks.ts`

```typescript
type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string };
```

The router extracts a task ID from the branch name pattern (`archie/task-{id}`, with
the legacy `feature/task-{id}` prefix still accepted) or, for `issue_comment` events,
looks up the task by PR number via `findTaskByPRNumber()`.

**Deterministic routing** (no triage step exists for GitHub):
- `pull_request_review` (approved) -> `merge_check`
- `pull_request_review` (changes_requested / commented) -> `existing_task`
- `pull_request_review_comment` -> `existing_task`
- `pull_request` (opened / synchronize) -> `merge_check`
- `pull_request` (closed) -> `existing_task`
- `push` -> `merge_check`
- `workflow_run` (completed, success) -> `merge_check`
- `workflow_run` (completed, failure) -> `existing_task`
- `issue_comment` (created) -> `existing_task` (deduped by `last_processed_comment_id`)

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

| Transition | Trigger | Method |
|---|---|---|
| `-> in_progress` | New task created and first message sent | `Task.create()` + `task.append(thread)` + `task.sendMessage(...)` (`activate()` sets `metadata.status = 'in_progress'`) |
| `-> in_progress` | Stopped task reactivated | `Task.get()` followed by `task.sendMessage(...)` — `activate()` flips status back to `in_progress` |
| `-> stopped` | User cancels, edit mode request, research-budget exceeded, wall-clock timeout | `task.stop()` |
| `-> completed` | PM calls `report_completion` | `task.complete()` |

Both `task.stop()` and `task.complete()`:
1. Set `task.isActive = false` and remove the task from the `activeTasks` map
2. Clear the wall-clock timeout interval
3. Stop every agent's queue (`agent.queue.stop()`) — pending generators reject and the SDK loops exit; the crash handler then emits `agent:inactive`
4. Clean up shared clones for non-edit-mode tasks
5. Remove the `:eyes:` reaction from the last processed Slack message in each linked channel
6. Flush metadata to disk with the new `status`

### Wall-clock timeout

A 60-second interval (`taskTimeoutTimer`) checks elapsed time against
`budgets.taskTimeoutMs` (30 minutes default). On timeout, a message is posted via
`postToUser()` and `task.stop()` is called.

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
