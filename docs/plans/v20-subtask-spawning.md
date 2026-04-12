# Plan: PM Subtask Spawning

## Context

PM currently operates within a single task session. When researching complex bugs or doing deep analysis, a single session may miss angles that parallel sessions would catch. This feature lets PM spawn independent subtasks — each with its own PM + specialist agents, fresh context, own repo clones — then collect findings and synthesize.

**Key design principle**: Simplicity. Subtasks are full tasks with a special channel type that routes `post_to_user` back to the parent PM's message queue instead of Slack.

## How It Works

1. Parent PM calls `spawn_subtask(goal)` → creates a new Task with a **`parent` channel** instead of a Slack channel
2. Subtask's PM thinks it's talking to a user via `post_to_user`, but messages route to parent PM's queue
3. Parent PM can send messages to subtask via `send_message_to_subtask(id, message)` → queued to subtask's PM
4. Subtask is **always read-only** — `request_edit_mode` returns an error
5. Subtasks **cannot spawn further subtasks** — the `spawn_subtask` tool is not available to subtask PMs
6. On startup recovery, subtasks (identified by `parent_task_id` in metadata) are **skipped**
7. When parent task stops/completes, all active subtasks are terminated

## Changes

### 1. Add `parent_task_id` and `subtasks` to TaskMetadata

**File**: [src/types/task.ts](src/types/task.ts)

```typescript
// Add to TaskMetadata:
parent_task_id?: string;           // Set on subtasks — ID of the parent task
subtask_ids?: string[];            // Set on parent — all subtask IDs ever created
subtask_budget_extra?: number;     // Additional +10 per user approval
```

### 2. Add `parent` channel type

**File**: [src/types/task.ts](src/types/task.ts)

```typescript
export type ChannelType = 'slack' | 'github' | 'parent';

export interface ParentChannel extends ChannelBase {
  type: 'parent';
  parent_task_id: string;
}

export type Channel = SlackChannel | GitHubChannel | ParentChannel;
```

### 3. Route subtask `post_to_user` to parent PM

**File**: [src/tasks/task.ts](src/tasks/task.ts) — `postToUser()` method

Current logic: emit event → append to knowledge.log → post to Slack threads.

Add: if default channel is `parent` type, use `deliverMessage()` (see step 3b) to route to parent PM instead of Slack. Otherwise, use existing Slack posting logic.

```typescript
async postToUser(message: string, agentName?: string): Promise<void> {
  const sender = agentName || 'system';
  emitEvent('message', this.taskId, { from: sender, to: 'user', message });
  await appendMessageToUser(this.taskId, sender, message);

  const defaultCh = this.metadata.default_channel 
    ? this.metadata.channels[this.metadata.default_channel] 
    : null;
  if (defaultCh?.type === 'parent') {
    // Route to parent task's PM — same as Slack/CLI: log + event + standard prompt
    await deliverMessage(defaultCh.parent_task_id, message, `subtask:${this.taskId}`);
  } else {
    // Existing Slack posting logic
    const slackRefs = this.getSlackThreadRefs();
    if (slackRefs.length > 0) {
      await Promise.all(slackRefs.map((ref) => removeReaction(ref.channel_id, ref.last_processed_ts, 'eyes')));
      await postToThreads(slackRefs, message);
    }
  }
}
```

### 3b. Add `appendCrossTaskMessage()` persistence helper + `deliverMessage()` routing helper

These follow the exact same pattern as CLI and Slack message delivery:
- **CLI**: `appendCliMessage()` (knowledge log + event) → `task.sendMessage(AGENT_PROMPTS.existingTask)`
- **Slack**: `appendSlackMessage()` per message (knowledge log + event) → `task.sendMessage(AGENT_PROMPTS.existingTask)`

Cross-task messages use the same two-step approach: log the message, then send a standard prompt so PM reads from knowledge log.

**File**: [src/tasks/persistence.ts](src/tasks/persistence.ts)

New function mirroring `appendCliMessage` / `appendSlackMessage`:

```typescript
/**
 * Append a cross-task message to the knowledge log.
 * Used for subtask↔parent communication in both directions.
 * Same pattern as appendCliMessage/appendSlackMessage — logs + emits event.
 */
export async function appendCrossTaskMessage(
  taskId: string,
  source: string,
  message: string,
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source,
    message,
  };
  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, { from: source, to: 'pm-agent', message });
}
```

Knowledge log entries:
- **Subtask→parent**: `[2025-...] [subtask:task-20250411-1234-abc123] Findings from subtask...` — parent PM sees which subtask reported
- **Parent→subtask**: `[2025-...] [user] Message from parent...` — subtask PM sees this as a normal user message (preserves the illusion that it's serving a regular user)

**File**: [src/tasks/task.ts](src/tasks/task.ts)

Module-level function (has direct access to `activeTasks` and `Task` — no circular import needed):

```typescript
/**
 * Deliver a message to any task's agent. Follows the same pattern as
 * Slack (appendSlackMessage + sendMessage) and CLI (appendCliMessage + sendMessage):
 * 1. Log message to target task's knowledge log + emit event
 * 2. Load/reactivate task + send standard prompt to agent (agent reads knowledge log)
 */
export async function deliverMessage(
  taskId: string,
  message: string,
  source: string,
): Promise<void> {
  // 1. Log to target task's knowledge log + emit event
  await appendCrossTaskMessage(taskId, source, message);

  // 2. Load/reactivate task and send standard prompt to PM (same as Slack/CLI)
  const task = activeTasks.get(taskId) ?? await Task.get(taskId);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
```

Usage:
- **Subtask→parent** (`postToUser`): `deliverMessage(parentTaskId, message, `subtask:${this.taskId}`)` — parent PM sees subtask source
- **Parent→subtask** (`send_message_to_subtask`): `deliverMessage(subtaskId, message, 'user')` — subtask PM sees it as a user message
- **Initial subtask spawn** (`spawn_subtask`): `appendCrossTaskMessage` + `sendMessage(AGENT_PROMPTS.newTask)` (see step 5)

All paths: append to knowledge log → emit event → load/reactivate task → standard prompt to PM. Identical to how Slack and CLI work.

### 4. Block `request_edit_mode` and research budget extension for subtasks

**File**: [src/agents/tools.ts](src/agents/tools.ts) — `createRequestEditModeTool`

Add early return at top of handler:

```typescript
if (task.metadata.parent_task_id) {
  return err('This tool is not available in the current task context.');
}
```

**File**: [src/tasks/task.ts](src/tasks/task.ts) — `onResearchBudgetExceeded()`

For subtasks, don't post approval buttons or stop the task. Instead, just let the research tool return an error so the agent naturally reports back to the parent:

```typescript
async onResearchBudgetExceeded(): Promise<void> {
  // Subtasks: no approval flow, research tool will return error, agent reports back naturally
  if (this.metadata.parent_task_id) return;
  
  // ... existing approval button flow for normal tasks ...
}
```

The research MCP tool already checks `checkResearchBudget()` before executing — when it returns `{allowed: false}`, the tool returns an error message. The subtask PM will naturally report this limitation back via `post_to_user`, which routes to the parent PM. Subtasks keep the default research limit of 5.

### 5. Create subtask tools (PM-only, parent tasks only)

**File**: [src/agents/tools.ts](src/agents/tools.ts)

Four new tools, only added to the PM MCP server when `task.metadata.parent_task_id` is undefined:

#### `spawn_subtask(goal)`
- Check subtask budget (10 base + extras, prompt user via Slack if exceeded)
- Call `Task.create()`
- Set subtask's `metadata.parent_task_id = task.taskId`
- Set subtask's channel: `{ type: 'parent', parent_task_id: task.taskId }` as default channel
- Append to parent's `metadata.subtask_ids[]`, call `task.debouncedSave()` on parent
- Call `subtask.debouncedSave()` to persist parent_task_id and channel
- `appendCrossTaskMessage(subtaskId, 'user', goal)` — log goal to subtask knowledge log (looks like a user message)
- `subtask.sendMessage(AGENT_PROMPTS.newTask, 'pm-agent')` — start subtask PM (reads knowledge log)
- Return subtask ID + note: "You will be notified when the subtask reports back. No need to poll — continue with other work."

#### `send_message_to_subtask(subtask_id, message)`
- Validate subtask_id is in `task.metadata.subtask_ids`
- `deliverMessage(subtaskId, message, 'user')` — logs to subtask knowledge log as user message + events, sends standard prompt to subtask PM
- Return confirmation + note: "Message delivered. You will be notified when the subtask responds."

#### `get_subtasks_status()`
- Iterate `task.metadata.subtask_ids`
- For each: check if active, get status, get agent statuses
- Return formatted list

#### `cancel_subtask(subtask_id)`
- Look up subtask, call `subtask.stop()`
- Return confirmation

### 6. Subtask budget with Slack approval

**File**: [src/tasks/task.ts](src/tasks/task.ts)

Add methods mirroring research budget pattern:

```typescript
checkSubtaskBudget(): { allowed: boolean; used: number; limit: number }
onSubtaskBudgetExceeded(): Promise<void>  // posts approval buttons, stops task
handleSubtaskBudgetApproval(): void       // extends limit by 10, resumes PM
handleSubtaskBudgetDenial(): void         // logs denial, resumes PM
```

Budget: 10 base + `subtask_budget_extra` (incremented by 10 per approval).
Count: `metadata.subtask_ids.length`.

### 7. Wire approval buttons for subtask budget

**File**: [src/connectors/slack/events.ts](src/connectors/slack/events.ts)

Add action handlers for `approve_subtask_budget` and `deny_subtask_budget`, same pattern as research budget.

**File**: [src/connectors/api/routes.ts](src/connectors/api/routes.ts) — `POST /tasks/:id/approve`

Add `subtask_budget` case alongside existing `edit_mode` and `research_budget`:

```typescript
} else if (type === 'subtask_budget') {
  if (approve) {
    await task.handleSubtaskBudgetApproval();
  } else {
    await task.handleSubtaskBudgetDenial();
  }
}
```

### 8. Subtask-aware wall-clock timeout message

**File**: [src/tasks/task.ts](src/tasks/task.ts) — `startTaskTimeout()`

The timeout handler calls `this.postToUser(...)` which for subtasks routes to the parent PM. Adjust the message so the parent PM understands what happened:

```typescript
const timeoutMessage = this.metadata.parent_task_id
  ? `Subtask timed out after ${Math.round(elapsed / 60_000)} minutes without completing. Partial findings (if any) are in the knowledge log.`
  : `⏱️ Task timed out after ${Math.round(elapsed / 60_000)} minutes. Stopping task.`;
await this.postToUser(timeoutMessage);
```

### 9. Terminate subtasks when parent stops

**File**: [src/tasks/task.ts](src/tasks/task.ts) — `stop()` and `complete()` methods

Before existing cleanup, add:

```typescript
// Stop all active subtasks
if (this.metadata.subtask_ids?.length) {
  for (const subtaskId of this.metadata.subtask_ids) {
    const subtask = activeTasks.get(subtaskId);
    if (subtask?.isActive) {
      await subtask.stop();
    }
  }
}
```

### 10. Skip subtasks during startup recovery

**File**: [src/tasks/recovery.ts](src/tasks/recovery.ts) — `recoverActiveTasks()`

Add filter:

```typescript
// Skip subtasks — they cannot run independently
if (taskMeta.parent_task_id) {
  logger.system(`Recovery: Skipping subtask ${taskMeta.task_id} (parent: ${taskMeta.parent_task_id})`);
  continue;
}
```

### 11. Register subtask tools conditionally in PM MCP server

**File**: [src/agents/tools.ts](src/agents/tools.ts) — `createPMAgentMcpServer()`

```typescript
export function createPMAgentMcpServer(agent: Agent, task: Task) {
  const tools = [
    createSendMessageTool(agent, task),
    createPostToUserTool(agent, task),
    createAssignTaskOwnerTool(agent, task),
    createReportCompletionTool(agent, task),
    createRequestEditModeTool(agent, task),
    createGetAgentsStatusTool(agent, task),
    createMuteThreadTool(agent, task),
  ];

  // Subtask tools only for parent tasks (not subtasks themselves)
  if (!task.metadata.parent_task_id) {
    tools.push(
      createSpawnSubtaskTool(agent, task),
      createSendMessageToSubtaskTool(agent, task),
      createGetSubtasksStatusTool(agent, task),
      createCancelSubtaskTool(agent, task),
    );
  }

  return createSdkMcpServer({
    name: 'pm-agent-tools',
    version: '1.0.0',
    tools,
  });
}
```

### 12. Render parent channel in CLI task list and move `#` prefix to API

**File**: [src/connectors/api/routes.ts](src/connectors/api/routes.ts) — `GET /api/tasks`

Currently extracts `channel_name` only from Slack channels (lines 91-95). Add handling for all channel types and move the `#` prefix here (instead of CLI adding it):

```typescript
let channel_name: string | null = null;
if (metadata.default_channel && metadata.channels[metadata.default_channel]) {
  const ch = metadata.channels[metadata.default_channel];
  if (ch.type === 'slack') {
    channel_name = ch.channel_name.startsWith('DM with') ? ch.channel_name : `#${ch.channel_name}`;
  } else if (ch.type === 'parent') {
    channel_name = `subtask of ${ch.parent_task_id}`;
  }
}
```

**File**: [src/cli/components/TaskList.tsx](src/cli/components/TaskList.tsx) — channel display (lines 161-163)

Remove the `#` prefix logic from CLI — API now returns display-ready channel names:

```typescript
const channel = task.channel_name || 'cli';
```

### 13. Add brief subtask guidance to PM prompt

**File**: [prompts/pm-agent.md](prompts/pm-agent.md)

Add a short section (keep it minimal — detailed patterns will come via skills later):

```markdown
## Subtasks

You can spawn independent subtasks to investigate in parallel. Each subtask gets its own agents and fresh context. Use this carefully — only when parallel investigation genuinely helps (e.g., exploring multiple hypotheses for a bug, researching different angles of a complex question). Subtasks report findings back to you automatically. Do not poll — continue with other work while subtasks run.
```

## Files to Modify

1. [src/types/task.ts](src/types/task.ts) — Add `ParentChannel`, extend `TaskMetadata`
2. [src/tasks/persistence.ts](src/tasks/persistence.ts) — Add `appendCrossTaskMessage()` (knowledge log + event for cross-task messages)
3. [src/tasks/task.ts](src/tasks/task.ts) — Add `deliverMessage()`, route `postToUser` to parent, subtask budget methods, subtask-aware timeout, terminate subtasks on stop/complete, skip research budget approval for subtasks
4. [src/agents/tools.ts](src/agents/tools.ts) — 4 new subtask tools, block edit mode for subtasks, conditional PM tool registration
5. [src/tasks/recovery.ts](src/tasks/recovery.ts) — Skip subtasks in startup recovery
6. [src/connectors/slack/events.ts](src/connectors/slack/events.ts) — Subtask budget approval buttons
7. [src/connectors/api/routes.ts](src/connectors/api/routes.ts) — Render parent channel in task list, add `subtask_budget` approval type, move `#` prefix from CLI
8. [src/cli/components/TaskList.tsx](src/cli/components/TaskList.tsx) — Simplify channel display (API now returns display-ready names)
9. [prompts/pm-agent.md](prompts/pm-agent.md) — Brief subtask tool guidance

## Verification

1. **Typecheck**: `npm run typecheck` — ensure no type errors
2. **Manual test**: Create a task via Slack, have PM spawn a subtask, verify:
   - Subtask PM receives the goal message
   - Subtask's `post_to_user` delivers to parent PM's queue
   - Parent PM can send messages to subtask
   - `get_subtasks_status` shows correct state
   - `request_edit_mode` in subtask returns error
   - Subtask cannot spawn further subtasks (tool not available)
   - Parent completion terminates subtasks
   - Server restart skips subtask recovery
   - Budget of 10 enforced, approval extends by 10
