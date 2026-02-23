> **Status: Partially implemented** — Idle detection via Stop hooks, progressive recovery (reinforcement then fresh context), and recovery counters are implemented. Some state persistence gaps remain. See v10 for the final implementation.

# MVP 5: Agent Recovery & Handoff Resilience

**Status**: Planned
**Goal**: Implement event-driven recovery system that detects when agents become idle without completing tasks, and progressively reinforces or restarts them to self-heal from drift.

## Problem Statement

Agents can become "stuck" - they go idle (waiting for input) without completing the task or handing off properly. This happens when:

- Agent finishes a turn but forgets to report completion or send a message
- Agent misunderstands instructions and stops prematurely
- Agent's context drifts and it loses track of what to do next

**This is different from session failures.** The existing retry logic in `pm.ts` and `repo-agent.ts` handles technical failures when the Claude SDK cannot load/resume a session (corrupted session file, expired session, etc.). That's a technical error recovery, not a behavioral recovery.

MVP5 addresses the behavioral problem: agents that successfully complete turns but stop working when they shouldn't.

---

## Key Design Decisions

### Reuse Existing Concepts

This MVP builds on existing infrastructure, not replacing it:

- **Keep existing session load retry** - `pm.ts` and `repo-agent.ts` retry with fresh session when SDK fails to load a session (technical error recovery - unrelated to this MVP)
- **Keep existing queue system** - Message queues and spawn queue continue to manage agent lifecycle
- **Keep existing completion flow** - `report_completion` tool and `completeTask()` remain unchanged
- **Extend TaskMetadata** - Add recovery-related fields to existing persisted metadata
- **Extend TaskRuntimeState** - Add per-agent timestamps to existing in-memory state
- **Use Claude SDK Notification hook** - Detect idle state via `idle_prompt` notification type

### Event-Driven Recovery (Not Polling)

Recovery is triggered by events, not timers:

1. **Hook fires** when agent enters idle state (`notification_type === 'idle_prompt'`)
2. **Check condition**: Are ALL spawned agents idle AND task not completed?
3. **If yes**: Trigger recovery (reinforcement or fresh context)
4. **No polling**, no timeouts, no background jobs

### Progressive Recovery Strategy

Three levels of recovery, tracked via `failure_counter`:

1. **Reinforcement (counter 1-2)**: Send prompt reminding agent of expectations - proper tool use, reporting completion via `report_completion`, handing off to other agents via `send_message_to_agent`
2. **Fresh Context (counter >= 3)**: Reset session, agent reads full knowledge.log on restart with clean context
3. **Reset counter**: After fresh context, counter resets to 0

### Hard Gate on Completion

PM's `report_completion` tool fails if any repo agent is still actively running. This prevents premature task closure when agents are still working.

---

## Scope

**In Scope:**

- Per-agent `lastActivity` timestamp tracking in `TaskRuntimeState`
- Per-agent `recovery_mode` field in `TaskMetadata` (persisted)
- Per-task `failure_counter` field in `TaskMetadata` (persisted)
- `Notification` hook integration for idle detection
- `onIdle` callback per agent for idle event propagation
- Recovery logic: check all-idle condition, apply reinforcement or fresh context
- Hard gate: `report_completion` fails if repo agents still running
- User escape hatch: status requests trigger recovery naturally

**Out of Scope (Future MVPs):**

- Fallback routing (lighter model extracts intent from failed output)
- Automatic task cancellation after N recovery attempts
- Recovery metrics/dashboard
- Custom recovery prompts per agent type

---

## Architecture Overview

```
Agent Turn Flow (existing):

  PM Agent                      Backend Agent               Mobile Agent
     │                               │                           │
     │  ←── idle_prompt ────         │  ←── idle_prompt ────     │
     │     (waiting input)           │     (waiting input)       │
     ▼                               ▼                           ▼

Idle Detection (new):

  ┌─────────────────────────────────────────────────────────────────┐
  │                    Notification Hook Handler                     │
  │                                                                  │
  │  On idle_prompt for any agent:                                  │
  │    1. Update agent.lastActivity                                 │
  │    2. Mark agent as idle                                        │
  │    3. Check: are ALL spawned agents idle?                       │
  │    4. Check: is task NOT completed?                             │
  │    5. If both true → trigger recovery                           │
  │                                                                  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                     Recovery Logic                               │
  │                                                                  │
  │  1. Increment failure_counter                                   │
  │  2. For each active agent:                                      │
  │     - If failure_counter >= 3: set recovery_mode = fresh_context│
  │     - Else: set recovery_mode = reinforcement                   │
  │  3. Find agent with most recent lastActivity                    │
  │     - If repo agent → set target = task_owner                   │
  │     - If PM → set target = pm-agent                             │
  │  4. If fresh_context: reset failure_counter = 0                 │
  │  5. Wake target agent with appropriate prompt                   │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘

Agent Wake-Up:

  ┌─────────────────────────────────────────────────────────────────┐
  │                     On Agent Spin-Up                             │
  │                                                                  │
  │  1. Check recovery_mode in metadata                             │
  │  2. If recovery_mode = reinforcement:                           │
  │     - Inject reinforcement prompt (existing + reminder)         │
  │     - Clear recovery_mode                                       │
  │  3. If recovery_mode = fresh_context:                           │
  │     - Start with no session ID (fresh context)                  │
  │     - Agent reads knowledge.log naturally                       │
  │     - Clear recovery_mode                                       │
  │  4. Normal flow continues                                       │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Data Model Changes

### TaskMetadata (Persisted)

**File**: `src/types/task.ts`

Extend existing `agent_sessions` to store recovery mode alongside session ID:

```typescript
// New type for per-agent session data
export interface AgentSessionInfo {
  session_id?: string;                        // Existing: session ID for resume
  recovery_mode?: RecoveryMode;               // MVP5: pending recovery mode
}

export type RecoveryMode = 'reinforcement' | 'fresh_context';

export interface TaskMetadata {
  // ... existing fields ...

  // Change from Record<string, string> to Record<string, AgentSessionInfo>
  agent_sessions: Record<string, AgentSessionInfo>;

  // Recovery tracking (MVP5)
  failure_counter: number;                    // Increments on each recovery, resets after fresh_context
}
```

**Note**: This is a breaking change to `agent_sessions` format. Old session data can be dropped (no production users yet).

**File**: `src/types/index.ts`

Re-export new types:

```typescript
export type { AgentSessionInfo, RecoveryMode } from './task.js';
```

### TaskRuntimeState (In-Memory)

**File**: `src/system/active-tasks.ts`

Add per-agent tracking:

```typescript
export interface AgentRuntimeState {
  isActive: boolean;               // True when working, false when idle (idle_prompt received)
  lastActivity: Date;              // Timestamp of last state change (for determining most recent agent)
}

export interface TaskRuntimeState {
  // ... existing fields ...

  // Per-agent tracking (MVP5)
  agentState: Map<AgentName, AgentRuntimeState>;
}
```

**File**: `src/system/task-runtime.ts`

Initialize `agentState` map in `initializeTaskRuntime`:

```typescript
export async function initializeTaskRuntime(taskId: string): Promise<TaskRuntimeState> {
  // ... existing code ...

  const runtime: TaskRuntimeState = {
    // ... existing fields ...

    // MVP5: Per-agent state tracking
    agentState: new Map(),
  };

  // ...
}
```

### Recovery Prompts

**File**: `src/system/recovery.ts`

Define reinforcement prompts per agent type. These remind agents of their core workflow and available tools when they go idle without completing work.

```typescript
export const RECOVERY_PROMPTS = {
  /**
   * PM Agent reinforcement - focuses on turn-ending tools and delegation
   */
  pm: `RECOVERY: You went idle without completing the task.

Your turn must end with one of:
- send_message_to_agent: Delegate work to a repo agent (turn ends naturally, wait for response)
- report_completion: Task done or waiting for user input
- request_edit_mode: Need user approval for code changes

Read knowledge.log to see where you left off, then take action.`,

  /**
   * Repo Agent reinforcement - focuses on reporting back
   */
  repo: `RECOVERY: You went idle without reporting completion.

Your turn must end with:
- send_message_to_agent: Report findings to pm-agent (if Task Owner) or to requesting agent (if Participant)

Read knowledge.log to see what was requested, complete your work, then report back.`,
};
```

**Usage**: Recovery logic selects prompt based on agent type:
- `agentName === 'pm-agent'` → use `RECOVERY_PROMPTS.pm`
- Otherwise → use `RECOVERY_PROMPTS.repo`

---

## Architecture Changes

### 1. Hook Integration (Notification + UserPromptSubmit)

**Files**: `src/agents/pm.ts`, `src/agents/repo-agent.ts`

Add hooks for both idle detection and activity logging:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../system/logger.js';

// In buildQueryOptions or equivalent
const buildQueryOptions = (sessionId?: string) => ({
  // ... existing options ...
  hooks: {
    // Detect when agent becomes idle (waiting for input)
    Notification: [{
      hooks: [async (input) => {
        if (input.notification_type === 'idle_prompt') {
          logger.info(agentName, `Hook:Notification idle_prompt - agent now idle`);
          await onIdle();
        } else {
          logger.debug(agentName, `Hook:Notification type=${input.notification_type}`);
        }
        return { continue: true };
      }]
    }],

    // Log when agent receives new input (for debugging)
    UserPromptSubmit: [{
      hooks: [async (input) => {
        const promptPreview = input.prompt?.substring(0, 100) || '(empty)';
        logger.info(agentName, `Hook:UserPromptSubmit - received input: "${promptPreview}..."`);
        return { continue: true };
      }]
    }]
  }
});
```

**Note**:
- `Notification` with `idle_prompt` triggers state change (`isActive = false`)
- `UserPromptSubmit` is for logging only - state is managed in `ensureAgentSpawned` and `notifyNewInput`
- Both hooks provide visibility into agent lifecycle for debugging recovery issues

### 2. Idle Callback Chain

**File**: `src/mcp/tools.ts`

Add `onIdle` to the base callback interface (used by both PM and repo agents):

```typescript
// Base callbacks shared by all agents
export interface BaseToolCallbacks {
  onSendMessage: (target: AgentName, message: string) => Promise<string>;
  onLogFinding: (entry: string, type: FindingType) => Promise<void>;

  // MVP5: Called when agent enters idle state (from Notification hook)
  onIdle: () => Promise<void>;
}

// PM-specific callbacks extend base
export interface PMToolCallbacks extends BaseToolCallbacks {
  // ... existing PM-specific callbacks ...
}

// Repo agent callbacks also extend base
export interface RepoAgentToolCallbacks extends BaseToolCallbacks {
  // ... existing repo agent callbacks ...
}
```

**File**: `src/system/task-runtime.ts`

Update `createToolCallbacks` to include `onIdle`:

```typescript
function createToolCallbacks(
  runtime: TaskRuntimeState,
  agentName: AgentName
): PMToolCallbacks {  // Or RepoAgentToolCallbacks depending on agent
  return {
    // ... existing callbacks ...

    onIdle: async () => {
      // Mark agent as inactive and update timestamp
      const agentState = runtime.agentState.get(agentName);
      if (agentState) {
        agentState.isActive = false;
        agentState.lastActivity = new Date();
      }

      // Check if recovery needed
      await checkAndTriggerRecovery(runtime);
    },
  };
}
```

### 3. Recovery Detection Logic

**New file**: `src/system/recovery.ts`

```typescript
import type { TaskRuntimeState } from './active-tasks.js';
import type { AgentName, RecoveryMode, TaskMetadata } from '../types/index.js';
import { loadMetadata, saveMetadata } from './task-manager.js';
import { stopTask } from './task-runtime.js';
import { getSpawnQueue } from './queues.js';
import { logger } from './logger.js';

/**
 * Check if all spawned agents are idle and task is incomplete
 * If so, trigger recovery
 */
export async function checkAndTriggerRecovery(
  runtime: TaskRuntimeState
): Promise<void> {
  // Skip if task already completed/stopped
  if (!runtime.isActive) {
    return;
  }

  // Check if all spawned agents are idle
  const allIdle = areAllSpawnedAgentsInactive(runtime);
  if (!allIdle) {
    return;
  }

  // All agents idle but task not complete - trigger recovery
  logger.system(`All agents idle for task ${runtime.taskId}, triggering recovery`);
  await triggerRecovery(runtime);
}

/**
 * Check if all spawned agents are currently idle
 */
function areAllSpawnedAgentsInactive(runtime: TaskRuntimeState): boolean {
  // Must have at least one spawned agent
  if (runtime.spawned.size === 0) {
    return false;
  }

  for (const agentName of runtime.spawned) {
    const state = runtime.agentState.get(agentName);
    if (!state || state.isActive) {
      return false;
    }
  }

  return true;
}

/**
 * Determine which "lead" agent to wake for recovery.
 *
 * Logic:
 * - Find agent with most recent activity
 * - If it's PM → wake PM (PM is the lead)
 * - If it's a repo agent → wake task_owner (the assigned lead for this task)
 *
 * This ensures we always ping the responsible "lead" agent who can
 * assess the situation and delegate if needed.
 */
function determineRecoveryTarget(
  runtime: TaskRuntimeState,
  metadata: TaskMetadata
): AgentName {
  // Find most recently active agent
  let mostRecent: AgentName = 'pm-agent';
  let mostRecentTime = new Date(0);

  for (const agentName of runtime.spawned) {
    const state = runtime.agentState.get(agentName);
    if (state && state.lastActivity > mostRecentTime) {
      mostRecentTime = state.lastActivity;
      mostRecent = agentName;
    }
  }

  // If most recent was PM, target PM
  // If most recent was a repo agent, target the task owner (lead agent)
  if (mostRecent === 'pm-agent') {
    return 'pm-agent';
  } else {
    return metadata.task_owner || 'pm-agent';
  }
}

/**
 * Trigger recovery for a stuck task
 */
async function triggerRecovery(runtime: TaskRuntimeState): Promise<void> {
  // Load fresh metadata
  const metadata = await loadMetadata(runtime.taskId);
  if (!metadata) {
    return;
  }

  // Initialize recovery fields if not present (migration)
  if (metadata.failure_counter === undefined) {
    metadata.failure_counter = 0;
  }

  // Increment failure counter
  metadata.failure_counter++;

  // Determine recovery mode for each active agent
  const recoveryMode: RecoveryMode =
    metadata.failure_counter >= 3 ? 'fresh_context' : 'reinforcement';

  for (const agentName of runtime.spawned) {
    // Only set recovery_mode for agents that have session data (were actually spawned)
    const agentSession = metadata.agent_sessions[agentName];
    if (agentSession) {
      agentSession.recovery_mode = recoveryMode;
    }
  }

  // Reset counter after fresh_context
  if (recoveryMode === 'fresh_context') {
    metadata.failure_counter = 0;
  }

  // Persist metadata
  await saveMetadata(runtime.taskId, metadata);

  // Determine target agent and select appropriate prompt
  const target = determineRecoveryTarget(runtime, metadata);
  const prompt = target === 'pm-agent'
    ? RECOVERY_PROMPTS.pm
    : RECOVERY_PROMPTS.repo;

  logger.system(
    `Recovery: mode=${recoveryMode}, target=${target}, counter=${metadata.failure_counter}`
  );

  // For fresh_context, we need to stop and re-spawn via spawn queue
  if (recoveryMode === 'fresh_context') {
    await stopTask(runtime.taskId);
    // Spawn queue will pick up and restart with fresh context
    await getSpawnQueue().add(
      { taskId: runtime.taskId, reason: 'existing_task' },
      { groupId: runtime.taskId }
    );
  } else {
    // For reinforcement, just add prompt to target's queue
    const targetQueue = runtime.queues.get(target);
    if (targetQueue) {
      // Mark target as active before sending message
      const targetState = runtime.agentState.get(target);
      if (targetState) {
        targetState.isActive = true;
        targetState.lastActivity = new Date();
      }
      targetQueue.addMessage(prompt);
    }
  }
}
```

### 4. routeToSpawnOrNotify (No Changes Needed)

**File**: `src/workers/triage-worker.ts`

The existing `routeToSpawnOrNotify` function does not need changes for recovery. Recovery handles its own flow:
- **Reinforcement**: Adds prompt directly to target agent's queue (no routing needed)
- **Fresh context**: Calls `stopTask()` then queues spawn directly

The existing function continues to work for normal message routing (Slack messages, GitHub events).

### 5. Agent Spawn Updates

**Files**: `src/agents/pm.ts`, `src/agents/repo-agent.ts`

When spawning an agent, check `recovery_mode` and apply it:

```typescript
export async function spawnPMAgent(
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: AgentCallbacks,  // Updated type
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
  agentName: string = 'pm-agent'
): Promise<AgentHandle> {
  // Check for fresh_context recovery mode (stored in agent_sessions)
  const agentSession = metadata.agent_sessions[agentName];
  const recoveryMode = agentSession?.recovery_mode;
  let sessionId = existingSessionId;

  if (recoveryMode === 'fresh_context') {
    // Force fresh session - clear both runtime and persisted session
    sessionId = undefined;
    if (agentSession) {
      delete agentSession.session_id;  // Clear stale session from metadata
    }
    logger.system(`${agentName} starting with fresh context (recovery)`);
  }

  // Clear recovery_mode after applying
  if (recoveryMode && agentSession) {
    delete agentSession.recovery_mode;
    // Note: metadata is saved by caller after spawn
  }

  // Add hooks for idle detection and logging
  const buildQueryOptions = (sid?: string) => ({
    // ... existing options ...
    hooks: {
      Notification: [{
        hooks: [async (input) => {
          if (input.notification_type === 'idle_prompt') {
            logger.info(agentName, `Hook:Notification idle_prompt - agent now idle`);
            await callbacks.onIdle();
          } else {
            logger.debug(agentName, `Hook:Notification type=${input.notification_type}`);
          }
          return { continue: true };
        }]
      }],
      UserPromptSubmit: [{
        hooks: [async (input) => {
          const promptPreview = input.prompt?.substring(0, 100) || '(empty)';
          logger.info(agentName, `Hook:UserPromptSubmit - received input: "${promptPreview}..."`);
          return { continue: true };
        }]
      }]
    }
  });

  // ... rest of spawn logic ...
}
```

### 5. Hard Gate on Completion

**File**: `src/system/task-runtime.ts`

Update `onReportCompletion` to check for active repo agents (using `isActive`, not `isRunning`):

```typescript
onReportCompletion: async (): Promise<void> => {
  // Hard gate: fail if any repo agent is still actively working
  // Note: Use isActive (from agentState) not handle.isRunning
  // An idle agent has isRunning=true but isActive=false
  for (const agentName of runtime.spawned) {
    if (agentName === 'pm-agent') continue;

    const state = runtime.agentState.get(agentName);
    if (state?.isActive) {
      throw new Error(
        `Cannot complete task: ${agentName} is still working. ` +
        `Wait for all repo agents to finish or ask them to report completion.`
      );
    }
  }

  // ... existing completion logic ...
}
```

### 6. Agent State Management

**File**: `src/system/task-runtime.ts`

Set `isActive = true` in three places:

```typescript
// 1. When spawning a new agent
async function ensureAgentSpawned(
  runtime: TaskRuntimeState,
  agentName: AgentName
): Promise<void> {
  if (runtime.spawned.has(agentName)) {
    return;
  }

  // Initialize agent state as active
  runtime.agentState.set(agentName, {
    isActive: true,
    lastActivity: new Date(),
  });

  // ... existing spawn logic ...
}

// 2. When waking PM with new Slack input
export async function notifyNewInput(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) return;

  // Mark PM as active (it's about to receive input)
  const pmState = runtime.agentState.get('pm-agent');
  if (pmState) {
    pmState.isActive = true;
    pmState.lastActivity = new Date();
  }

  const pmQueue = runtime.queues.get('pm-agent');
  if (pmQueue) {
    pmQueue.addMessage(PM_PROMPTS.existingTask);
  }
}

// 3. When sending message to any agent (in onSendMessage callback)
onSendMessage: async (target: AgentName, message: string): Promise<string> => {
  // ... existing validation ...

  // Spawn target agent if not already running
  await ensureAgentSpawned(runtime, target);

  // Mark target as active (whether just spawned or waking from idle)
  const targetState = runtime.agentState.get(target);
  if (targetState) {
    targetState.isActive = true;
    targetState.lastActivity = new Date();
  }

  // Add message to target's queue
  targetQueue.addMessage(message, agentName);

  // ...
}
```

Summary:
- `isActive = true` → on spawn (new agent), `notifyNewInput()` (PM from Slack), or `onSendMessage()` (any agent receiving inter-agent message)
- `isActive = false` → on `idle_prompt` hook

**Refactoring note**: This state management is spread across multiple places. Consider consolidating into a single `markAgentActive(runtime, agentName)` helper in a future cleanup pass.

### 8. User Escape Hatch

The user can always send a status request message. This goes through triage → spawn queue → PM wakes up → reads knowledge.log → system recovers naturally.

No code changes needed - this already works via the existing flow.

---

## File Changes Summary

**New files:**

- `src/system/recovery.ts` - Recovery detection, trigger logic, and `RECOVERY_PROMPTS`

**Modified files:**

- `src/types/task.ts` - Add `AgentSessionInfo` type, `RecoveryMode` type, `failure_counter` field, change `agent_sessions` type
- `src/system/task-manager.ts` - Update `storeAgentSession()` to use new `AgentSessionInfo` format
- `src/system/active-tasks.ts` - Add `AgentRuntimeState` (with `isActive` and `lastActivity`), `agentState` map to `TaskRuntimeState`
- `src/system/task-runtime.ts` - Add `onIdle` callback, hard gate on completion (using `isActive`), initialize agent state on spawn
- `src/agents/pm.ts` - Add `Notification` and `UserPromptSubmit` hooks, check `recovery_mode`, clear `session_id` on fresh context
- `src/agents/repo-agent.ts` - Add `Notification` and `UserPromptSubmit` hooks, check `recovery_mode`, clear `session_id` on fresh context
- `src/mcp/tools.ts` - Add `onIdle` to `BaseToolCallbacks` interface (shared by PM and repo agents)

---

## Testing Checklist

**Idle Detection:**

- [ ] `Notification` hook fires on `idle_prompt`
- [ ] `onIdle` callback sets `agentState.isActive = false`
- [ ] Agent spawn sets `agentState.isActive = true`

**Recovery Trigger:**

- [ ] Recovery NOT triggered when any agent still working
- [ ] Recovery NOT triggered when task completed
- [ ] Recovery triggered when ALL spawned agents idle AND task active
- [ ] `failure_counter` increments on recovery

**Recovery Mode:**

- [ ] `reinforcement` mode when `failure_counter < 3`
- [ ] `fresh_context` mode when `failure_counter >= 3`
- [ ] `failure_counter` resets to 0 after `fresh_context`
- [ ] `recovery_mode` persisted in metadata.json
- [ ] `recovery_mode` cleared after agent spawn

**Agent Wake-Up:**

- [ ] Most recently active agent is identified correctly
- [ ] Repo agent → wake task owner (not the repo agent)
- [ ] PM agent → wake PM
- [ ] Reinforcement prompt sent for reinforcement mode
- [ ] Fresh context prompt sent for fresh_context mode
- [ ] No session ID when fresh_context mode

**Hard Gate:**

- [ ] `report_completion` fails if any repo agent has `isActive = true`
- [ ] Error message indicates which agent is still working
- [ ] `report_completion` succeeds when all repo agents have `isActive = false`

**User Escape Hatch:**

- [ ] User status message triggers PM wake-up via spawn queue
- [ ] PM reads knowledge.log and responds to user

**Persistence:**

- [ ] `failure_counter` persists across pod restarts
- [ ] `recovery_mode` persists across pod restarts
- [ ] Existing tasks without recovery fields get defaults (migration)

**Initialization:**

- [ ] `agentState` map created in `initializeTaskRuntime`
- [ ] Agent state created when agent spawns via `ensureAgentSpawned`

**Concurrency:**

- [ ] Multiple rapid idle events don't cause duplicate recovery prompts
- [ ] Recovery during simultaneous task completion doesn't cause errors

---

## Edge Cases

### Multiple Rapid Idle Events

If multiple agents become idle simultaneously, `checkAndTriggerRecovery` may be called multiple times. The function is idempotent - it checks `areAllSpawnedAgentsInactive()` which will return false after the first recovery wakes an agent.

### Agent Spawned During Recovery

If a new agent is spawned while recovery is happening, it will have `isActive = true` initially. This prevents false-positive "all inactive" detection until the new agent also becomes inactive.

### Task Completed During Recovery

If `completeTask()` is called while recovery check is in progress, `runtime.isActive` becomes false and recovery aborts.

### Existing Session Load Retry vs MVP5 Recovery

The existing retry in `pm.ts`/`repo-agent.ts` handles a different problem:

| Existing Session Load Retry | MVP5 Recovery |
|----------------------------|---------------|
| **Trigger**: SDK throws error loading session | **Trigger**: Agent goes idle (no error) |
| **Problem**: Technical - session file corrupted/expired | **Problem**: Behavioral - agent stopped working |
| **Scope**: Single spawn attempt | **Scope**: Ongoing task lifecycle |
| **Action**: Retry once with fresh session | **Action**: Progressive reinforcement then fresh context |

These are complementary. If session load fails → existing retry handles it. If agent loads fine but stops working → MVP5 handles it.

---

## Implementation Order

1. **Types first**: Add `RecoveryMode`, `failure_counter`, `recovery_mode` to `TaskMetadata`
2. **Runtime state**: Add `AgentRuntimeState` and `agentState` map
3. **Recovery logic**: Create `src/system/recovery.ts` with detection and trigger
4. **Callbacks**: Add `onIdle` to callbacks, integrate activity tracking
5. **Hooks**: Add `Notification` hook to `pm.ts` and `repo-agent.ts`
6. **Hard gate**: Update `onReportCompletion` with running agent check
7. **Integration**: Wire up `onIdle` → `checkAndTriggerRecovery`
8. **Testing**: Manual testing with stuck scenarios

---

## Dependencies

**No new npm packages required.**

Uses existing Claude Agent SDK hooks capability (`@anthropic-ai/claude-agent-sdk`).

---

## Future Enhancements (Post-MVP 5)

- **Fallback routing**: Lighter model extracts intent from failed agent output
- **Recovery metrics**: Track recovery frequency, success rate
- **Custom prompts**: Different reinforcement prompts per agent type/situation
- **Escalation**: After N recoveries, escalate to user or cancel task
- **Recovery dashboard**: UI to see stuck tasks and manually intervene
