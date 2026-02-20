# MVP v10 — Agent Recovery & Idle Detection

## Problem

Archie's agent state is entirely in-memory. When the server re-deploys (or crashes), all running tasks lose their PM and repo agent processes. Tasks stay `in_progress` on disk but nothing is driving them forward. Additionally, agents can sometimes go idle without completing their work (SDK `Stop` hook fires but no turn-ending tool was called), leaving the task stuck with no active agents.

## Current State

- Tasks are stored on disk at `sessions/<task-id>/shared/metadata.json`
- `metadata.status` is `'in_progress' | 'stopped' | 'completed'`
- `metadata.agent_sessions` stores `Record<string, string>` (agentName → sessionId) — SDK sessions survive process restarts
- `metadata.participants` lists all agents that were spawned for the task
- `findTasksByStatus('in_progress')` already exists in task-manager.ts
- `initializeTaskRuntime()` + `startTask()` already handle resuming a task with existing session IDs
- `reactivateTask()` in event-handler.ts calls `spawnTaskIfNeeded()` which initializes runtime + spawns PM
- The `spawningTasks` guard in event-handler.ts prevents duplicate concurrent spawns

## Research Findings

### How to detect agent turn completion

**Stop hook** is the proven mechanism (tested and working in `feature/agent-recovery-idle-detection` branch). It fires when the agent finishes its turn.

```typescript
hooks: {
  Stop: [{
    hooks: [async () => {
      await callbacks.onIdle();
      return { continue: true };
    }]
  }],
}
```

Note: `docs/agent-turn-detection.md` incorrectly states that the Notification hook with `idle_prompt` should be used instead. That doc is wrong — the Stop hook fires on turn completion, not just termination.

### How to detect agent crashes

No SDK-level crash signal exists. Crashes throw exceptions in the `for await` loop with errors like "Claude Code process exited with code 1". The existing retry logic in `pm.ts` / `repo-agent.ts` already handles this:
- If resuming a session fails → retry once without session ID
- If fresh session also fails → log error, `handle.isRunning = false`

After the agent's background function exits, `handle.isRunning` goes `false`. This is the only crash signal available.

### Container shutdown behavior

In ALL shutdown scenarios (graceful SIGTERM, forced SIGKILL, crash/OOM):
- `stopServer()` sets `isShuttingDown` and stops the HTTP listener
- `stopServer()` **never calls `stopTask()`** for active tasks
- Tasks stay `in_progress` on disk — but no record of which agents were active vs idle
- Comment in `server.ts:408`: "Active PMs are dropped (recovery on restart is future work)"

**Critical race condition**: During graceful shutdown, `process.exit(0)` is called right after `stopServer()`. In the brief window before exit, the SDK child processes get killed, causing exceptions in the `for await` loop. This triggers crash detection handlers and Stop hooks that could write `active: false` or `status: 'stopped'` to metadata — making the system think agents/tasks finished normally when they were just killed by shutdown.

**Solution**: Centralized shutdown guard in `updateAgentState()` and `updateTaskStatus()` — silently skip any deactivation writes when `isShuttingDown` is true. This way all metadata stays frozen at whatever was last persisted during normal operation, and recovery on restart sees the correct state.

### Key SDK types for hooks

- `StopHookInput`: `{ hook_event_name: 'Stop', stop_hook_active: boolean, session_id, transcript_path, cwd }`
- `SessionStartHookInput`: `{ source: 'startup' | 'resume' | 'clear' | 'compact' }`
- `SessionEndHookInput`: `{ reason: ExitReason }`
- `NotificationHookInput`: `{ notification_type: string }` — includes `idle_prompt`

## Design: 3 Stages

Each stage is self-contained and shippable independently. Each builds on the previous.

---

## Stage 1: Task Recovery on Server Restart

**Goal**: On server boot, find all `in_progress` tasks and re-spawn PM for each.

### How it works

1. After `startServer()` completes, call a new `recoverActiveTasks()` function
2. `recoverActiveTasks()` calls `findTasksByStatus('in_progress')`
3. For each task found, call `reactivateTask(taskId, 'recovery')` which calls `spawnTaskIfNeeded(taskId, 'recovery')`:
   - Checking if task is already active (skip)
   - Checking spawn guard (skip if already spawning)
   - `initializeTaskRuntime()` → loads session IDs from metadata
   - `startTask(taskId, 'recovery')` → spawns PM with existing session, sends `AGENT_PROMPTS.recovery`
   - PM resumes with its full conversation history and reads knowledge.log to continue
4. Log each recovery attempt and result

### Recovery prompt

The existing `AGENT_PROMPTS.existingTask` says "New input received" — wrong for recovery (there's no new input). Add a dedicated prompt:

```typescript
// In pm.ts — rename PM_PROMPTS → AGENT_PROMPTS, add recovery:
export const AGENT_PROMPTS = {
  newTask: 'New task created, assign owner',
  existingTask: 'New input received. Check knowledge.log for the update.',
  recovery: 'Task was interrupted. Check knowledge.log for current state and continue where you left off.',
};
```

Extend `SpawnReason` and `startTask()`:

```typescript
// In task-runtime.ts:
export type SpawnReason = 'new_task' | 'existing_task' | 'recovery';

// In startTask():
const prompt = reason === 'new_task'
  ? AGENT_PROMPTS.newTask
  : reason === 'recovery'
    ? AGENT_PROMPTS.recovery
    : AGENT_PROMPTS.existingTask;
```

Extend `reactivateTask()` to accept a reason:

```typescript
// In event-handler.ts:
export async function reactivateTask(taskId: string, reason: SpawnReason = 'existing_task'): Promise<void> {
  await spawnTaskIfNeeded(taskId, reason);
}
```

### Optimize `findTasksByStatus()` — use grep instead of loop

Current implementation loops over every session directory, reads each `metadata.json`, parses JSON, then checks status. Replace with `grep -l` to find matching files in one pass:

```typescript
export async function findTasksByStatus(
  status: 'in_progress' | 'stopped' | 'completed'
): Promise<TaskMetadata[]> {
  await ensureSessionsDir();

  const { execSync } = await import('child_process');
  const grepResult = execSync(
    `grep -l '"status": "${status}"' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
    { encoding: 'utf-8' }
  ).trim();

  if (!grepResult) return [];

  const tasks: TaskMetadata[] = [];
  for (const filePath of grepResult.split('\n')) {
    const taskIdMatch = filePath.match(/task-[a-z0-9-]+/i);
    if (!taskIdMatch) continue;

    const metadata = await loadMetadata(taskIdMatch[0]);
    if (metadata) tasks.push(metadata);
  }

  return tasks;
}
```

Only the matching files get loaded and parsed. With hundreds of sessions, this is significantly faster than reading every one.

### Files to modify

| File | Change |
|------|--------|
| `src/system/task-recovery.ts` | **New file** — `recoverActiveTasks()` function |
| `src/system/task-manager.ts` | Rewrite `findTasksByStatus()` to use grep |
| `src/system/task-runtime.ts` | Add `'recovery'` to `SpawnReason`, update `startTask()` prompt selection |
| `src/system/event-handler.ts` | `reactivateTask()` accepts optional `reason` param; update `spawnTaskIfNeeded()` inline type from `'new_task' \| 'existing_task'` to `SpawnReason` |
| `src/agents/pm.ts` | Rename `PM_PROMPTS` → `AGENT_PROMPTS`, add `.recovery` prompt |
| `src/agents/index.ts` | Update re-export `PM_PROMPTS` → `AGENT_PROMPTS` |
| `src/system/task-runtime.ts` | Update import `PM_PROMPTS` → `AGENT_PROMPTS` |
| `src/index.ts` | Call `recoverActiveTasks()` after `startServer()` |

### New file: `src/system/task-recovery.ts`

```typescript
/**
 * Task Recovery
 *
 * Recovers active tasks after server restart.
 * Scans disk for in_progress tasks and re-spawns their agents.
 */

import { findTasksByStatus } from './task-manager.js';
import { reactivateTask } from './event-handler.js';
import { logger } from './logger.js';

/**
 * Recover all in_progress tasks after server restart.
 * Called once during startup, after server is ready to accept webhooks.
 */
export async function recoverActiveTasks(): Promise<void> {
  const activeTasks = await findTasksByStatus('in_progress');

  if (activeTasks.length === 0) {
    logger.system('Recovery: No in_progress tasks found');
    return;
  }

  logger.system(`Recovery: Found ${activeTasks.length} in_progress task(s), re-activating...`);

  for (const task of activeTasks) {
    try {
      await reactivateTask(task.task_id, 'recovery');
      logger.system(`Recovery: Re-activated task ${task.task_id}`);
    } catch (error) {
      logger.error('recovery', `Failed to recover task ${task.task_id}`, error);
    }
  }
}
```

### Change to `src/index.ts`

```typescript
import { recoverActiveTasks } from './system/task-recovery.js';

// In main(), after startServer():
await startServer(config);
await recoverActiveTasks();
```

### What this gives us

- Zero-downtime deploys: tasks auto-resume after restart
- PM resumes its SDK session (full conversation history preserved)
- PM reads knowledge.log and picks up where it left off
- If PM's session expired or is invalid, existing retry logic starts a fresh session automatically
- No schema changes needed — uses existing metadata fields

### Limitations (addressed in Stage 2)

- Only PM is re-spawned. Repo agents that were actively working are lost.
- PM will re-delegate to repo agents as needed (reads knowledge.log, sees incomplete work)
- This is actually a reasonable first step — PM is the orchestrator and can recover the full state

---

## Stage 2: Per-Agent State Tracking & Full Agent Recovery

**Goal**: Track whether each agent is active (boolean) in metadata so we can re-spawn all agents on restart, not just PM.

### Schema change: `agent_sessions`

Replace the flat `Record<string, string>` with a richer per-agent state:

```typescript
// New type in src/types/task.ts
export interface AgentSessionState {
  session_id?: string;       // undefined = no session yet or cleared (fresh start)
  active: boolean;          // true = doing work, false = finished turn / crashed
  last_activity?: string;   // ISO timestamp
}

// In TaskMetadata — replace existing field (union handles legacy string values on disk):
agent_sessions: Record<string, AgentSessionState | string>;
```

### Graceful read helper

If `agent_sessions` contains a legacy string value (e.g. from old metadata on disk), gracefully convert it:

```typescript
// In src/system/agent-state.ts
export function getAgentSession(
  metadata: TaskMetadata,
  agentName: string
): AgentSessionState | undefined {
  const entry = metadata.agent_sessions[agentName];
  if (!entry) return undefined;
  if (typeof entry === 'string') {
    return { session_id: entry, active: false };
  }
  return entry;
}
```

Use this everywhere agent sessions are read (e.g. `initializeTaskRuntime()`, `recoverActiveTasks()`). The type for `agent_sessions` becomes `Record<string, AgentSessionState | string>` to reflect reality, but all reads go through the helper.

### Shutdown guard

Export `isShuttingDown` from `server.ts` via a getter:

```typescript
// In server.ts:
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}
```

### DRY: Single method for all agent state updates

One method handles both in-memory state update and metadata persistence. The shutdown guard lives here — callers never need to worry about it:

```typescript
// In src/system/agent-state.ts (new file)

import { loadMetadata, saveMetadata } from './task-manager.js';
import type { TaskRuntimeState } from './active-tasks.js';
import { getIsShuttingDown } from './server.js';
import { logger } from './logger.js';

/**
 * Update an agent's active state — single source of truth for all state transitions.
 * Updates both in-memory runtime state and persisted metadata.
 *
 * During shutdown, deactivation writes are silently skipped so recovery
 * sees the correct pre-shutdown state.
 *
 * Persistence is fire-and-forget to avoid blocking agent processing.
 */
export function updateAgentState(
  runtime: TaskRuntimeState,
  agentName: string,
  active: boolean,
  sessionId?: string   // provided on initial store (onSessionId callback)
): void {
  // During shutdown, skip deactivation — preserve state for recovery
  if (!active && getIsShuttingDown()) return;

  // 1. Update in-memory runtime
  const session = runtime.sessions.get(agentName);
  if (session) {
    if (sessionId) session.session_id = sessionId;
    session.active = active;
    session.last_activity = new Date().toISOString();
  } else if (sessionId) {
    // Initial store — create the entry
    runtime.sessions.set(agentName, {
      session_id: sessionId,
      active,
      last_activity: new Date().toISOString(),
    });
  }

  // 2. Persist to metadata (fire-and-forget — don't block agent)
  persistAgentActivity(runtime.taskId, agentName, active, sessionId).catch((err) =>
    logger.error('agent-state', `Failed to persist state for ${agentName}`, err)
  );
}

async function persistAgentActivity(
  taskId: string,
  agentName: string,
  active: boolean,
  sessionId?: string
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) return;

  const existing = getAgentSession(metadata, agentName);
  metadata.agent_sessions[agentName] = {
    session_id: sessionId ?? existing?.session_id ?? '',
    active,
    last_activity: new Date().toISOString(),
  };

  await saveMetadata(taskId, metadata);
}
```

### In-memory state tracking

Change the existing `sessions` map in `TaskRuntimeState` to use the same `AgentSessionState` type as metadata — no extra map needed:

```typescript
// In active-tasks.ts — change existing field:
sessions: Map<AgentName, AgentSessionState>;  // was Map<AgentName, string>
```

### Where `updateAgentState()` is called

All state transitions go through the single method:

| Transition | Where | Call |
|-----------|-------|------|
| initial | `onSessionId` callback | `updateAgentState(runtime, agentName, true, sessionId)` |
| → `true` | Message delivered to agent's queue | `updateAgentState(runtime, agentName, true)` |
| → `false` | Stop hook fires | `updateAgentState(runtime, agentName, false)` |
| → `false` | `handle.running` resolves (crash) | `updateAgentState(runtime, agentName, false)` |
| → `false` | `stopTask()` / `completeTask()` | `updateAgentState(runtime, agentName, false)` for each |

All `→ false` transitions are protected by the shutdown guard. No caller needs to check `isShuttingDown`.

### Wiring the Stop hook

Add `onIdle` callback to `BaseToolCallbacks` in `src/mcp/tools.ts`:

```typescript
export interface BaseToolCallbacks {
  // ... existing callbacks ...
  onIdle: () => Promise<void>;
}
```

Wire into agent spawn functions (`pm.ts`, `repo-agent.ts`, `plugin-agent.ts`):

```typescript
hooks: {
  Stop: [{
    hooks: [async () => {
      await callbacks.onIdle();
      return { continue: true };
    }]
  }],
},
```

Implement in `createToolCallbacks()`:

```typescript
onIdle: async () => {
  updateAgentState(runtime, agentName, false);
},
```

### Detecting agent crashes

After spawning, monitor `handle.running`:

```typescript
// In ensureAgentSpawned(), after spawning:
handle.running.then(() => {
  // Agent's background function exited (clean exit or crash after retry)
  // Shutdown guard inside updateAgentState will skip if shutting down
  updateAgentState(runtime, agentName, false);
});
```

### Enhanced recovery — re-spawn all active agents

In Stage 2, we re-spawn every agent that was `active: true` when interrupted — not just PM. Each agent resumes its SDK session (full conversation history) and gets a simple "continue" message. No need for PM to re-delegate.

Handle recovery inside `startTask()` — only spawn agents that were actually active:

```typescript
export async function startTask(taskId: string, reason: SpawnReason = 'new_task'): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) throw new Error(`TaskRuntime for ${taskId} not initialized`);

  if (reason === 'recovery') {
    // Re-spawn only agents that were active when interrupted
    let spawned = 0;
    for (const [agentName, session] of runtime.sessions) {
      if (!session.active) continue;

      const queue = runtime.queues.get(agentName);
      if (!queue) throw new Error(`${agentName} queue not initialized`);
      queue.addMessage(AGENT_PROMPTS.recovery);
      await ensureAgentSpawned(runtime, agentName as AgentName);
      spawned++;
    }

    // Fallback: if no agents were active (stale metadata), spawn PM below
    if (spawned > 0) return;
  }

  // Spawn PM: new_task, existing_task, or recovery fallback
  const pmQueue = runtime.queues.get('pm-agent');
  if (!pmQueue) throw new Error('PM queue not initialized');

  const prompt = reason === 'new_task'
    ? AGENT_PROMPTS.newTask
    : reason === 'recovery'
      ? AGENT_PROMPTS.recovery
      : AGENT_PROMPTS.existingTask;
  pmQueue.addMessage(prompt);
  await ensureAgentSpawned(runtime, 'pm-agent');
}
```

Only active agents get re-spawned. If PM was idle (waiting for a repo agent to report back), it stays idle — the repo agent resumes and will message PM when done. Fallback to PM if no agents were marked active (stale metadata edge case).

### Files to create

| File | Purpose |
|------|---------|
| `src/system/agent-state.ts` | `updateAgentState()` — single DRY method with shutdown guard |

### Files to modify

| File | Change |
|------|--------|
| `src/types/task.ts` | Add `AgentSessionState` type. Change `agent_sessions` type |
| `src/system/active-tasks.ts` | Change `sessions` type from `Map<AgentName, string>` to `Map<AgentName, AgentSessionState>` |
| `src/system/task-manager.ts` | Delete `storeAgentSession()` — replaced by `updateAgentState()` |
| `src/system/server.ts` | Export `getIsShuttingDown()` getter |
| `src/mcp/tools.ts` | Add `onIdle` callback to `BaseToolCallbacks` |
| `src/system/task-runtime.ts` | Add recovery branch to `startTask()`. Wire `onIdle` in `createToolCallbacks()`. Replace `onSessionId` → `updateAgentState(runtime, agentName, true, sessionId)`. Call `updateAgentState(false)` in `stopTask()`, `completeTask()`. Add `handle.running.then()` crash detection. Update `initializeTaskRuntime()` to load sessions via `getAgentSession()` helper (returns `AgentSessionState` from legacy strings or objects) |
| `src/agents/pm.ts` | Add Stop hook: `callbacks.onIdle()` |
| `src/agents/repo-agent.ts` | Add Stop hook: `callbacks.onIdle()` |
| `src/agents/plugin-agent.ts` | Add Stop hook: `callbacks.onIdle()` |

### What this gives us

- Simple boolean state: agent is either doing work or not
- Shutdown guard centralized in `updateAgentState()` and `updateTaskStatus()` — no caller needs to know about shutdown
- All deactivation writes silently skipped during shutdown → metadata stays frozen for recovery
- Crash detection via `handle.running.then()` — also protected by shutdown guard

---

## Stage 3: All-Agents-Idle Detection & Progressive Recovery

**Goal**: Detect when all agents go idle (task active but no agent is doing work) and automatically recover.

This is the scenario where the SDK `Stop` hook fires for all agents without any of them calling a turn-ending tool (send_message, report_completion). The task is stuck: `isActive=true` but no agent is processing.

### How it works

1. **Idle detection trigger**

When an agent goes inactive (Stop hook fires → `updateAgentState(runtime, agent, false)`), check if ALL spawned agents are now inactive:

```typescript
// In agent-state.ts, extend updateAgentState() from Stage 2 with idle check:
export function updateAgentState(
  runtime: TaskRuntimeState,
  agentName: string,
  active: boolean,
  sessionId?: string   // same signature as Stage 2
): void {
  if (!active && getIsShuttingDown()) return;

  const session = runtime.sessions.get(agentName);
  if (session) {
    if (sessionId) session.session_id = sessionId;
    session.active = active;
    session.last_activity = new Date().toISOString();
  } else if (sessionId) {
    runtime.sessions.set(agentName, {
      session_id: sessionId, active, last_activity: new Date().toISOString(),
    });
  }

  persistAgentActivity(runtime.taskId, agentName, active, sessionId).catch(/* ... */);

  // NEW in Stage 3: after deactivation, check if all agents are inactive
  if (!active) {
    scheduleIdleCheck(runtime);
  }
}

function scheduleIdleCheck(runtime: TaskRuntimeState): void {
  // Small delay to avoid racing with message delivery
  // (another agent may be about to send a message that wakes this one)
  setTimeout(async () => {
    if (!runtime.isActive || getIsShuttingDown()) return;

    const allInactive = checkAllAgentsInactive(runtime);
    if (allInactive) {
      await triggerRecovery(runtime);
    }
  }, 3000);
}
```

2. **Check all agents inactive**

```typescript
function checkAllAgentsInactive(runtime: TaskRuntimeState): boolean {
  if (runtime.spawned.size === 0) return false;

  for (const agentName of runtime.spawned) {
    const session = runtime.sessions.get(agentName);
    if (session?.active) return false;
  }
  return true;
}
```

3. **Progressive recovery**

```typescript
// Add to TaskMetadata:
failure_counter?: number;  // Tracks consecutive recovery attempts

async function triggerRecovery(runtime: TaskRuntimeState): Promise<void> {
  const metadata = await loadMetadata(runtime.taskId);
  if (!metadata) return;

  metadata.failure_counter = (metadata.failure_counter ?? 0) + 1;
  await saveMetadata(runtime.taskId, metadata);

  logger.warn('recovery', `All agents inactive for task ${runtime.taskId} (attempt ${metadata.failure_counter})`);

  if (metadata.failure_counter >= 3) {
    // Nuclear option: clear all session IDs → fresh context on respawn
    metadata.failure_counter = 0;
    metadata.agent_sessions = {};
    await saveMetadata(runtime.taskId, metadata);

    // Stop and reactivate with fresh sessions
    await stopTask(runtime.taskId);
    await reactivateTask(runtime.taskId, 'recovery');
  } else {
    // Reinforcement: nudge the lead agent
    const target = metadata.task_owner || 'pm-agent';
    const queue = runtime.queues.get(target);
    if (queue) {
      const prompt = target === 'pm-agent'
        ? AGENT_PROMPTS.reinforcePM
        : AGENT_PROMPTS.reinforceAgent;
      queue.addMessage(prompt);

      // Mark active since we're sending a message
      updateAgentState(runtime, target, true);
    }
  }
}
```

4. **Reinforcement prompts** — add to `AGENT_PROMPTS` in Stage 3:

```typescript
// Add to AGENT_PROMPTS in pm.ts:
  reinforcePM: `RECOVERY: You went idle without completing the task.

Your turn must end with one of:
- send_message_to_agent: Delegate work to a specialist agent
- report_completion: Task done or waiting for user input
- request_edit_mode: Need user approval for code changes

Read knowledge.log to see where you left off, then take action.`,

  reinforceAgent: `RECOVERY: You went idle without reporting back.

Your turn must end with:
- send_message_to_agent: Report your findings to the requesting agent

Read knowledge.log to see what was requested, complete your work, then report back.`,
```

### Files to modify

| File | Change |
|------|--------|
| `src/types/task.ts` | Add `failure_counter?: number` to `TaskMetadata` |
| `src/agents/pm.ts` | Add `reinforcePM`, `reinforceAgent` to `AGENT_PROMPTS` |
| `src/system/agent-state.ts` | Add `scheduleIdleCheck()`, `checkAllAgentsInactive()`, `triggerRecovery()` |

### What this gives us

- Automatic detection when all agents go inactive
- Progressive recovery: gentle nudge first (x2), then fresh context restart
- 3-second delay prevents false positives from message delivery races
- Shutdown guard in `scheduleIdleCheck` prevents recovery triggering during shutdown
- `failure_counter` persisted — survives within a session but resets on fresh context

---

## Agent State Lifecycle Summary

```
                    spawn
                      │
                      ▼
            ┌── active (true) ◄── message delivered
            │       │
            │  Stop hook fires
            │       │
            │       ▼
            │  inactive (false) ──► all-inactive check ──► recovery
            │       │
            │  message delivered
            │       │
            │       ▼
            │  active (true)  (loop back)
            │
            │  crash / handle.running resolves
            │       │
            │       ▼
            └► inactive (false)
```

Every arrow calls `updateAgentState(runtime, agentName, bool)` — single DRY method.
All `→ false` transitions are no-ops during shutdown.

---

## Shutdown Protection Summary

| What | Guard location | Behavior during shutdown |
|------|---------------|------------------------|
| Agent `active: false` | `updateAgentState()` | Skipped — agent stays `active: true` in metadata |

Guard checks `getIsShuttingDown()` from `server.ts`. No caller needs to know about shutdown.

Task status doesn't need a guard — `stopServer()` never calls `stopTask()`, so `updateTaskStatus()` is not triggered during shutdown.

---

## Implementation Order

1. **Stage 1** (simplest, immediate value): One new file + one line in index.ts. Covers server re-deploy.
2. **Stage 2** (incremental): Schema change, DRY state method, Stop hook wiring, shutdown guards. Covers full agent recovery + crash detection.
3. **Stage 3** (builds on Stage 2): Idle check logic + progressive recovery. Covers stuck-agent scenarios.

Each stage is independently testable and deployable.

## Verification

### Stage 1
1. Start server, create a task via Slack (task goes `in_progress`)
2. Kill server (SIGKILL, not SIGTERM — simulates crash)
3. Restart server
4. Verify PM re-spawns and resumes the task (posts to Slack about continuing)

### Stage 2
1. Start server, create a task, let PM delegate to a repo agent
2. Verify `metadata.json` shows `agent_sessions` with `{ session_id, active: true, last_activity }` for spawned agents
3. Verify Stop hook fires and `active` changes to `false` in metadata
4. Kill server (SIGTERM) while agents are working
5. Restart server — verify `active` is still `true` in metadata (shutdown guard worked)
6. Verify agents re-spawn with correct session IDs (check logs for session resume)
7. Simulate crash (kill SDK subprocess) → verify `active` changes to `false`

### Stage 3
1. Start server, create a task
2. Let PM go idle without calling report_completion (SDK returns without tool use)
3. Wait for idle detection (~3s delay)
4. Verify reinforcement prompt is sent to PM
5. If PM idles 3 times, verify sessions are cleared and fresh context is used
6. Verify `failure_counter` in metadata increments correctly
7. SIGTERM during idle detection → verify no recovery triggered, metadata unchanged
