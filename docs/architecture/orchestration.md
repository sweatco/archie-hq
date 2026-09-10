# System Orchestration

How Archie routes messages, manages tasks, spawns the PM, and recovers from failures.

> Source of truth: the code in `src/tasks/`, `src/agents/`, `src/connectors/`, and `src/system/`.
> This document describes only what is implemented, not aspirational features.

---

## System Layer Responsibilities

| Layer | Source | Purpose |
|---|---|---|
| **HTTP Server** | `src/index.ts` | Express app, workdir bootstrap, plugin init, warm base clones, health check, GitHub webhook mount, Slack Bolt mount, recovery, reminder and trigger schedulers |
| **Workdir Bootstrap** | `src/system/workdir.ts` | Resolves `ARCHIE_WORKDIR`, clones plugins from `ARCHIE_PLUGINS`, warm-clones the repos `archie.json` marks, refreshes plugins via an `ls-remote` HEAD check (`refreshPlugins`, orchestrated by `syncPlugins` in `src/system/plugin-sync.ts`) |
| **Slack Events** | `src/connectors/slack/events.ts` | Slack Bolt receiver, event handlers (app_mention/message), interactive button actions, deterministic thread→task routing |
| **GitHub Events** | `src/connectors/github/events.ts` | GitHub webhook dispatch, direct existing-task handler (with `issue_comment` dedup) |
| **GitHub Webhooks** | `src/connectors/github/webhooks.ts` | Signature verification, deterministic routing, event formatting, merge check debouncing |
| **Task** | `src/tasks/task.ts` | Task class: in-memory state, the one agent, tool callbacks, lifecycle (create/stop/complete), approval handlers |
| **Task Persistence** | `src/tasks/persistence.ts` | Disk I/O: metadata, knowledge log, events/usage JSONL, debounced writes, task lookup by thread/branch/PR |
| **Task Recovery** | `src/tasks/recovery.ts` | Startup recovery + idle detection + progressive recovery (reinforcement then nuclear restart) |
| **Task Status** | `src/tasks/status.ts` | Composes the single first-person "Archie is …" line from the PM's tool calls |
| **Event Bus** | `src/system/event-bus.ts` | Typed in-process EventEmitter for system events (task/agent/message/approval/reminder); SSE clients and JSONL persistence subscribe |
| **Reminder Scheduler** | `src/system/reminder-scheduler.ts` | In-memory index of pending reminders backed by metadata; 1-minute interval fires due reminders by reactivating tasks |
| **Trigger Scheduler** | `src/system/trigger-scheduler.ts` | Fires schedule- and channel-message-bound triggers into fresh tasks (see [triggers.md](triggers.md)) |
| **Shutdown** | `src/system/shutdown.ts` | Process-wide `isShuttingDown` flag; tasks suppress deactivation writes during shutdown so recovery sees the correct pre-shutdown state |
| **Message Queue** | `src/agents/message-queue.ts` | The PM's async producer-consumer queue with replay support |
| **MCP Tools** | `src/agents/tools.ts` | In-process MCP tool definitions exposed to the PM |
| **Logger** | `src/system/logger.ts` | Unified, color-coded, semantic logging for all system and agent events |

---

## In-Memory State: Task Class

Every active task is represented by a `Task` instance stored in a global `activeTasks` map in `src/tasks/task.ts`.

```typescript
class Task {
  readonly taskId: string;
  metadata: TaskMetadata;      // persisted to disk (debounced)
  agent?: Agent;               // the task's one agent — the PM, created lazily
  pmDef: AgentDef;             // scanned fresh at task start/reload

  lastActivity: Date;
  isActive: boolean;           // false after stop/complete
  completionIntent: boolean;   // report_completion was called; park at quiescence

  budgets: TaskBudgets;
  taskTimeoutTimer?: ReturnType<typeof setInterval>;  // 60s wall-clock checker
  recoveryAttempts: number;
  nuclearRecoveryCycles: number;  // nuclear restarts this activation; capped at 3
}
```

The `Agent` (`src/agents/agent.ts`) owns its own `MessageQueue`, SDK `handle`, `session`, `sandbox`, in-flight `backgroundTasks` and deferred teardown slot.

Key design choices:

- `metadata` is the in-memory authority while a task is active; disk is a crash-recovery checkpoint.
- The `Agent` is created lazily in `ensurePm()` on the first message, not eagerly at task creation.
- Its `session` is restored from `metadata.agent_sessions['pm-agent']` on first spawn and synced back before every disk write.
- Activation is serialized per task by `activationLock`, so concurrent reopen triggers (a GitHub webhook, a Slack reply and startup recovery routinely fire in one tick) resolve to one canonical instance and spawn one subprocess.

---

## Message Routing Flow

### Slack Messages

```
Slack webhook (POST /webhooks/slack)
  --> Slack Bolt event handler (app_mention or message)
    --> routeSlackEvent()          [connectors/slack/events.ts]
        - discard our own bot messages (bot_id, or our bot user id)
    --> handleSlackEvent()         [connectors/slack/events.ts]
        - bail out if author is external/guest in a shared channel
        - add :eyes: reaction (remove from previous message in same thread)
        - fetchSlackThread() — full thread history; redaction applied at render time
        - findTaskByThread(threadId):
            existing task -> Task.get() + append() + sendMessage(AGENT_PROMPTS.inboundActivity(entries))
            no task, and (app_mention OR DM OR rootAuthorWasBot), and the thread
              carries >=1 visible message
              -> Task.create() + append() + sendMessage(AGENT_PROMPTS.inboundNewTask(entries))
            no task, reply in a human-started thread the bot didn't start -> ignore
        - shared-channel ephemeral warnings (per user, per thread)
        - fire-and-forget title generation (Haiku) on first message
```

Thread replies without an @mention are handled via the `message` listener and follow the same pipeline. In channels, messages containing the bot mention are skipped by the `message` handler (`app_mention` handles them); in DMs the `message` handler processes them too, because `app_mention` does not fire for DMs.

### Wakes carry their content

`task.append()` returns the lines it just wrote to `knowledge.log`, and the caller hands **those same strings** to the PM inline through a builder in `src/agents/prompts.ts` (`inboundNewTask`, `inboundActivity`, `githubActivity`, `systemNotice`, `triggered`, `reminder`, `recovery`, `reinforcePM`). The PM is never told to go and read a file. One renderer produces both copies, so the author line, the `msg:<ts>` id, the `[Attachments: …]` suffix and the redaction placeholder are identical in the log and in the PM's stream.

### GitHub Events

```
GitHub webhook (POST /webhooks/github)
  --> signature verification
  --> routeGitHubEvent()           [connectors/github/webhooks.ts]
      - discard our own bot events (GITHUB_APP_SLUG[bot])
      - extract branch name, derive task ID from branch pattern
      - for issue_comment without branch: findTaskByPRNumber()
      - determineRouteAction() based on event type:
          pull_request_review (approved)     -> merge_check
          pull_request_review (changes_req)  -> existing_task
          pull_request_review_comment        -> existing_task
          issue_comment (created)            -> existing_task
          pull_request (opened/synchronize)  -> merge_check
          pull_request (closed)              -> existing_task
          push                               -> merge_check
          workflow_run (completed, failure)  -> existing_task
          workflow_run (completed, success)  -> merge_check
```

All GitHub routes are deterministic. Events are handled by `handleExistingTaskDirect()` in `connectors/github/events.ts` or `handleMergeCheckDirect()` in `connectors/github/webhooks.ts`. `issue_comment` events deduplicate by `last_processed_comment_id` before logging and waking the PM.

---

## Message Queue System

**Source**: `src/agents/message-queue.ts`

The PM has one `MessageQueue` — a simple in-memory async producer-consumer queue. An earlier iteration used an external broker (RabbitMQ/Redis); it proved overkill and was replaced with this in-process implementation.

```typescript
class MessageQueue {
  addMessage(content)              // enqueue; resolves a pending waiter immediately if one exists
  prependMessage(content)          // push to front (message replay on retry)
  nextMessage(): Promise<QueuedMessage>  // blocks until a message is available
  hasMessages(): boolean
  pendingCount(): number
  stop()                           // rejects all pending resolvers, clears queue
  reset()                          // re-enables a stopped queue for reuse
  isStopped(): boolean
}
```

When `nextMessage()` is called on an empty queue the call blocks on a promise in `pendingResolvers[]`; `addMessage()` either resolves the first waiter or buffers. There is no sender prefix — every message is addressed to the PM, so `[From …]` framing is gone.

### Message replay with RecoverableInputGenerator

`createRecoverableInputGenerator()` wraps the queue into a generator that tracks consumed messages. On a session retry, `reset()` prepends them back to the front in their original order.

### Queue lifecycle

The `Agent` constructs its queue in its constructor. `queue.stop()` is called from `task.stop()` / `task.complete()`, so the generator exits gracefully; a mid-turn agent is additionally hard-aborted through `handle.abort()`.

---

## Agent Session Management

### Spawning

`task.ensurePm()` is the single entry point. It is idempotent — `Agent.spawn()` short-circuits when the agent is already running.

```
task.sendMessage(msg)
  --> activationLock: resolve the canonical Task instance
  --> activate() if not active (status=in_progress, wall-clock timer)
  --> ensurePm()
      --> restart the agent if it booted read-only and edit mode was since approved
      --> new Agent(pmDef) if none, then agent.spawn(task)
          --> short-circuit if already running
          --> hydrate agent.session from metadata.agent_sessions
          --> spawnAgent(agent, task)  [src/agents/spawn.ts]
              --> task.updateAgentState(true) early — prevents false idle detection
              --> workspace, prompt + context block, plugins, MCP servers, sandbox, hooks
              --> start SDK query() with the session-recovery retry loop
              --> assert every plugin directory we passed appears in the init message
              --> Stop hook -> reconcile background tasks -> task.updateAgentState(false)
  --> queue.addMessage(msg); updateAgentState(true) synchronously at enqueue
```

### Resuming

If `agent.session.session_id` is set (from a previous spawn or hydrated from metadata), it is passed as `resume`. On failure the loop in `spawn.ts` clears the bad session from both the agent and metadata, resets the generator and retries fresh exactly once.

### State tracking

`task.updateAgentState()` updates the session, emits `agent:active` / `agent:inactive`, drives the Slack status indicator, triggers a debounced persist, and on deactivation schedules an idle check. It also clears a stale `completionIntent` on a genuine inactive→active edge. During shutdown, deactivation returns early so metadata keeps `active: true` and restart recovery re-spawns.

---

## Idle Detection and Recovery

**Source**: `src/tasks/recovery.ts`

`scheduleIdleCheck(task)` waits 3 s (to avoid racing a webhook that is about to wake the agent) and then applies `idleDecision`:

| Result | When |
|---|---|
| `wait` | task not active; a deferred teardown is pending; the agent has not spawned; its turn is active; or it has an in-flight background task |
| `complete` | quiescent and `report_completion` set `completionIntent` → `task.complete()` |
| `recover` | quiescent with nobody parked — the agent dropped the ball |

Progressive recovery:

| Attempt | Strategy |
|---|---|
| 1–2 | **Reinforcement** — enqueue `AGENT_PROMPTS.reinforcePM` on the live agent and mark it active. If the process is dead, re-spawn instead of nudging a corpse. |
| 3+ | **Nuclear** — reset the counter, `task.stop()`, reload from disk via `Task.get()`, re-send `AGENT_PROMPTS.recovery`. The reloaded spawn resumes the persisted SDK session rather than clearing it. |
| 3+, past 3 nuclears | **Pause** — a nuclear cycle re-activates the task, so a PM that keeps going idle without reporting would loop stop→resume until the wall-clock cap. `MAX_NUCLEAR_RECOVERY_CYCLES` (3, counted per activation on `Task.nuclearRecoveryCycles`) caps it: log at warn, post one notice to the user, `task.stop()`. The user's next message resumes the task normally. |

`reinforcePM` names the three legitimate ways a turn ends: a background worker running (spawned with the `Agent` tool), `report_completion`, or `request_edit_mode`.

---

## Task Recovery on Server Restart

**Source**: `src/tasks/recovery.ts` — `recoverActiveTasks()`

Called once during startup from `src/index.ts`, before the HTTP server starts listening and before the reminder and trigger schedulers, so an inbound event cannot reach a task before its agent is respawned.

```
recoverActiveTasks()
  --> findTasksByStatus('in_progress')   // grep across sessions/task-*/shared/metadata.json
  --> for each task: Task.get(id) then task.sendMessage(AGENT_PROMPTS.recovery)
      // sendMessage activates the task and lazily creates + spawns the PM,
      // whose spawn rehydrates its session id from metadata.agent_sessions
```

`agent_sessions` is still the on-disk record of what was live at shutdown, but a task runs exactly one agent, so there is nothing to iterate over: the recovery prompt always goes to the PM.

---

## Webhook Routing

### Slack routing

`routeSlackEvent()` filters out the bot's own messages (matched by `bot_id`, or by our own bot user id). Everything else is handled by `handleSlackEvent()`, which decides between an existing task and a new one purely on the thread lookup and the structural cues above.

### GitHub routing

```typescript
type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string };
```

The router extracts a task ID from the branch name (`archie/task-{id}`, with the legacy `feature/task-{id}` prefix still accepted) or, for `issue_comment`, looks the task up by PR number. Events from the system's own GitHub App bot (`GITHUB_APP_SLUG[bot]`) are discarded to prevent loops.

---

## Task Lifecycle States and Transitions

```typescript
type TaskStatus = 'in_progress' | 'stopped' | 'completed';
```

| Transition | Trigger | Method |
|---|---|---|
| `-> in_progress` | New task created and first message sent | `Task.create()` + `append()` + `sendMessage()` (`activate()` sets the status) |
| `-> in_progress` | Stopped task reactivated | `Task.get()` + `sendMessage()` |
| `-> stopped` | User cancels, edit-mode request, tool-approval park, research budget exceeded | `task.stop()` |
| `-> completed` | PM called `report_completion` and went quiescent, or the wall-clock cap fired | `task.complete()` |

Both `stop()` and `complete()`:

1. (Re)post any changed PR cards so they land under the final message
2. Set `isActive = false` and remove the task from `activeTasks`
3. Clear the wall-clock interval
4. Stop the agent's queue, and hard-abort it if it is mid-turn
5. Remove the task's clones when `edit_allowed !== true`
6. Clear the `:eyes:` acks and the Slack status indicator
7. Flush metadata with the new status

### Deferred teardown

`request_edit_mode`, `request_max_mode`, the research-budget stop and the tool-approval park all run **inside** a tool call, so stopping the queue there would close the input stream under an in-flight hook. Each arms `agent.deferTeardown(...)` instead, and the spawn loop runs it on the SDK `result` event — with a backstop in the loop's `finally` for an agent that crashed before the result arrived. `report_completion` is different: it records `completionIntent` and lets the idle check park the task at quiescence, so a still-running background worker cannot be orphaned by a premature teardown.

### Wall-clock timeout

A 60-second interval checks elapsed time against `budgets.taskTimeoutMs` (60 minutes by default; override with `ARCHIE_TASK_TIMEOUT_MS`, which ignores anything that is not a positive integer so the backstop cannot be switched off by a typo). On expiry it posts a pause message — worded differently depending on whether the agent was mid-turn or simply waiting on a human — and calls `complete()`, so the task reopens cleanly on the next reply.

---

## Logger System

**Source**: `src/system/logger.ts`

A singleton `Logger` provides color-coded, semantic methods (`system`, `slack`, `server`, `worktree`, `agent`, `agentTool`, `agentMessage`, `agentFinding`, `agentAction`, `agentToSlack`, `error`, `warn`, `plain`, `debug`). Colors use `picocolors` and respect `NO_COLOR` / non-TTY environments. `pm-agent` renders magenta; anything else falls back to green. Agent labels carry a mode suffix — `:ro` in agent color, `:rw` in red.

`processAgentEventForLogging()` tracks subagent tool calls by `tool_use_id` and labels subsequent events with a numbered suffix (e.g. `pm-agent/researcher#1`). Only SDK tools are logged; MCP tools (prefixed `mcp__`) are filtered out.

---

## Related Documents

- [Task Persistence](./persistence.md) — file layout, metadata schema, debounced writes
- [Agents](./agents.md) — the PM, its workers, and the session lifecycle
