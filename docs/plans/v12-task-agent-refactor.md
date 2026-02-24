# Refactor: Task and Agent entities

## Context

First iteration of the architecture simplification. The goal is to make `Task` and `Agent` clean, self-contained entities before touching connectors, server, or anything else.

Currently the task/agent code is a 1140-line god module (`task-runtime.ts`) that creates tasks, spawns agents, builds 20+ tool callbacks as closures, handles approvals, manages timeouts, and orchestrates everything. Tool definitions live in `mcp/tools.ts`, implementations are closures in `task-runtime.ts`. Three near-identical agent spawners live in separate files. The `activeTasks` map, `TaskRuntimeState` type, and `TaskBudgets` live in yet another file.

**This iteration**: Consolidate into two clean entities — `Task` (class) and `Agent` (class) — while keeping everything else unchanged. No connector changes, no server changes, no file moves beyond task/agent code.

## Design

### Task class (`src/tasks/task.ts`)

Replace `TaskRuntimeState` (plain object) + scattered functions with a `Task` class.

The Task class holds:
- `metadata: TaskMetadata` (mutable, persisted)
- `agents: Map<AgentName, Agent>` (created lazily on first message)
- `team: AgentDef[]` (available agents from registry — loaded fresh on task start)
- `budgets: TaskBudgets` (research + message limits)
- `isActive: boolean`
- `lastActivity: Date`
- `recoveryAttempts: number`
- `timeoutInterval` (wall-clock safety net)

Public methods:
- `sendMessage(message, agentName?)` — default PM. Looks up AgentDef from team, creates Agent if not in map, spawns it if not running, delivers message to its queue.
- `stop()` — iterate agents, deactivate + stop queues, persist, remove from active map
- `complete()` — same as stop but status='completed'
- `getAgentStatus()` — iterate agents, return active/idle state
- `touch()` — update lastActivity timestamp
- `save(flush?)` — debounced persist (syncs agent sessions to metadata before write)

Static factory methods:
- `Task.createFromSlackThread(slackThread)` — generates ID, creates disk structure, returns Task
- `Task.get(taskId)` — reads metadata from disk (or returns cached active task)

Global state:
- `activeTasks: Map<string, Task>` stays as module-level map in `tasks/task.ts`
- Existing accessor functions (`isTaskActive`, `getActiveTaskIds`, etc.) become static methods or module-level exports

### Agent class (`src/agents/agent.ts`)

Each agent owns its own runtime state. Created lazily by Task on first message.

The Agent class holds:
- `def: AgentDef` (immutable — who is this agent)
- `queue: MessageQueue` (its message queue)
- `handle?: AgentHandle` (SDK process handle, set after spawn)
- `session?: AgentSessionState` (session ID + active flag, persisted)

Public interface:
- `sendMessage(message)` — add message to queue
- `isRunning` — getter, checks handle?.isRunning

Session deactivation (setting `session.active = false`) is handled internally — by the crash detection callback in `spawnAgent()` and by `task.stop()`/`task.complete()` which iterate their own agents.

Agent is spawned by the Task (which calls `spawnAgent()` — see below). The Task passes itself to the spawn function so tools can call back into it. After spawn, the Task sets `agent.handle`.

### No ToolContext wrapper — tools receive the Task directly

Tools need the task to do their work. Instead of wrapping Task methods in a ToolContext interface, tools receive the Task instance directly.

The circular import concern (`tasks/task.ts` → `agents/tools.ts` → `tasks/task.ts`) is resolved with `import type`:
- `agents/tools.ts` uses `import type { Task }` — erased at compile time, no runtime cycle
- `agents/tools.ts` declares the Task parameter as that type
- At runtime, the concrete Task instance is passed as an argument — no runtime import needed

### Agent spawning (`agents/spawn.ts`)

A single `spawnAgent(agent: Agent, task: Task)` function replaces the three separate spawners (`pm.ts`, `repo-agent.ts`, `plugin-agent.ts`). Branches on `agent.def.track` for:
- Model selection (opus/sonnet/custom)
- CWD (sharedPath / repoPath or worktree / agentWorkspace)
- Prompt composition (pm-agent.md / agent-core.md + repo-agent.md / agent-core.md + plugin-agent.md)
- Tool set (PM tools + GitHub tools / base tools / base tools + Skill)
- Edit mode handling (repo track only: worktree setup, startFreshSession flag)
- Skills setup (PM: symlinks at task creation / plugin: symlinks at spawn)

The session recovery pattern (try with session → reset → retry → give up) is written once.

Sets `agent.handle` on success. Attaches crash detection: `handle.running.then(() => agent.deactivate())`.

### Co-located tools (`agents/tools.ts`)

Move tool definitions from `mcp/tools.ts` and implementations from `task-runtime.ts` into `agents/tools.ts`. Each tool is a function that takes `Task` (via `import type`) and returns an SDK tool.

```
createToolsForAgent(agent: Agent, task: Task): McpServer
```

The `z.enum` schemas for agent IDs and repo keys are built from `task.team`.

GitHub types (`PRStatus`, `PRReview`, etc.) move to `github/client.ts`.

### Unified registry (`agents/registry.ts`)

Replace `plugin-loader.ts` + `repo-configs.ts` + `plugin-configs.ts` + `peer-list.ts` with `agents/registry.ts`. One `AgentDef` type, one scan function, one validation step.

`AgentDef` captures all three tracks:
- Common: `id`, `key`, `role`, `expertise`, `model`, `track`, `pluginName`, `agentPrompt`
- Repo track: `repo: { githubRepo, baseBranch, defaultPath }`
- Plugin track: `pluginPath`, `skillsPath`
- PM: `pmConfig: { teamList, teamExpertise }`, `pmSkills`

Scanned fresh at startup (validate + fail-fast) and on every task start/restart.

## Implementation Steps

### Step 1: Add `AgentDef` type to `types/agent.ts`

Add `AgentDef` interface. Keep existing types unchanged.

### Step 2: Create `agents/registry.ts`

- Port scanning logic from `plugin-loader.ts`, config building from `repo-configs.ts` + `plugin-configs.ts`, peer list from `peer-list.ts`
- Export: `initRegistry()`, `scanAgentDefs(): AgentDef[]`, `getAgentIds()`, `getRepoAgentIds()`, `getAgentDef(id)`, `getAgentDefByGithubRepo(repo)`
- Old modules (`plugin-loader.ts`, `repo-configs.ts`, `plugin-configs.ts`, `peer-list.ts`) become thin re-export shims that delegate to registry. This avoids breaking every other import in the codebase during this iteration.

### Step 3: Create `agents/tools.ts`

- Port tool creation functions from `mcp/tools.ts` — each one now takes `Task` (import type) instead of callbacks
- Port tool implementations from `task-runtime.ts` closures — the logic moves into each tool function
- GitHub types move to `github/client.ts`
- Export: `createToolsForAgent(agent: Agent, task: Task)` returns MCP server
- Old `mcp/tools.ts` becomes a thin shim re-exporting from `agents/tools.ts`

### Step 4: Create `agents/agent.ts` — the Agent class

- Agent class owns: def, queue, handle, session
- `sendMessage(message)` — adds to queue
- `isRunning` getter
- Created by Task, spawned by `spawnAgent()` from spawn.ts

### Step 5: Create `agents/spawn.ts` — unified spawner

- Single `spawnAgent(agent, task)` function
- Branches on `agent.def.track`
- Creates tools via `createToolsForAgent(agent, task)`
- Runs SDK query loop, sets agent.handle
- Session recovery pattern written once
- Old spawner files (`pm.ts`, `repo-agent.ts`, `plugin-agent.ts`) become thin shims

### Step 6: Create `tasks/task.ts` — the Task class

- Task class owns: metadata, agents map, team, budgets, isActive, timeouts
- Port from `task-runtime.ts`: createTask → `Task.createFromSlackThread()`, loadTask → `Task.get()`, sendMessage, stop, complete, approval handlers
- Port from `active-tasks.ts`: activeTasks map, accessor functions
- `sendMessage(msg, agentName?)` looks up def from team, creates Agent lazily, calls `spawnAgent()` if needed, then `agent.sendMessage(msg)`
- `stop()`/`complete()` iterates agents, deactivates, stops queues
- `save()` syncs agent sessions to metadata before writing

### Step 7: Wire up — update `task-runtime.ts` to delegate to Task class

Rather than updating every import in the codebase, make `task-runtime.ts` a thin facade:
- `createTask()` → `Task.createFromSlackThread()`
- `loadTask()` → `Task.get()`
- `sendMessage(runtime, agent, msg)` → `task.sendMessage(msg, agent)`
- `stopTask(taskId)` → `task.stop()`
- `completeTask(taskId)` → `task.complete()`
- Approval handlers delegate to task methods

This keeps `server.ts`, `event-handler.ts`, `webhook-router.ts`, `task-recovery.ts`, `merge-orchestrator.ts` working without changes.

### Step 8: Update `index.ts` startup

Replace:
```
initPlugins() → initRepoConfigs() → initPluginAgentConfigs()
```
With:
```
initPlugins() → initRegistry()
```

### Step 9: Update `task-recovery.ts`

Update to use Task class methods instead of importing `loadTask`/`sendMessage`/`stopTask` from `task-runtime.ts`.

### Step 10: Clean up shims

Once everything typechecks and works:
- Delete old `pm.ts`, `repo-agent.ts`, `plugin-agent.ts`
- Delete old `repo-configs.ts`, `plugin-configs.ts`, `peer-list.ts`
- Delete old `mcp/tools.ts`
- Delete old `active-tasks.ts`
- Update imports throughout codebase to point to new locations

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/types/agent.ts` | EDIT | Add `AgentDef` |
| `src/agents/registry.ts` | NEW | Unified plugin scan + config + validation |
| `src/agents/tools.ts` | NEW | Co-located tool definitions + implementations |
| `src/agents/agent.ts` | NEW | Agent class — owns queue, handle, session |
| `src/agents/spawn.ts` | NEW | Single `spawnAgent(agent, task)` |
| `src/tasks/task.ts` | NEW | Task class — owns agents map, metadata, lifecycle |
| `src/system/task-runtime.ts` | EDIT | Becomes thin facade delegating to Task |
| `src/system/active-tasks.ts` | EDIT | Re-exports from tasks/task.ts |
| `src/system/task-persistence.ts` | EDIT | May absorb into Task or keep as utility |
| `src/mcp/tools.ts` | EDIT | Becomes re-export shim |
| `src/agents/pm.ts` | EDIT | Becomes re-export shim |
| `src/agents/repo-agent.ts` | EDIT | Becomes re-export shim |
| `src/agents/plugin-agent.ts` | EDIT | Becomes re-export shim |
| `src/agents/repo-configs.ts` | EDIT | Becomes re-export shim |
| `src/agents/plugin-configs.ts` | EDIT | Becomes re-export shim |
| `src/agents/peer-list.ts` | EDIT | Becomes re-export shim |
| `src/system/task-recovery.ts` | EDIT | Use Task class |
| `src/index.ts` | EDIT | Use initRegistry() |
| `src/github/client.ts` | EDIT | Receives GitHub types from mcp/tools.ts |

## What's NOT in scope

- No connector changes (server.ts, event-handler.ts, webhook-router.ts stay as-is)
- No file restructuring beyond tasks/ and agents/ directories
- No `tasks/persistence.ts` merge yet (task-manager.ts + task-persistence.ts stay separate for now, Task class just calls their functions)
- No documentation updates (we'll do that when the full restructure is done)

## Verification

1. `npm run typecheck` — no type errors
2. `npm run build` — compiles cleanly
3. Start with `npm run dev` — server boots, plugins load, agents register
4. Trigger a task via Slack → PM spawns, assigns task owner, repo agent spawns, tools work
5. Edit mode flow: PM requests → buttons appear → approve → task restarts with edit mode
6. Task completion: PM calls report_completion → task cleans up
7. Recovery: kill process → restart → tasks recover from disk
