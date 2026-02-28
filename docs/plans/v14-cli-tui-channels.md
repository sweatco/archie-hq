# CLI TUI + User Channel Abstraction

## Context

Archie currently only communicates with users via Slack. The goal is to:
1. Add a CLI TUI — can create tasks, observe all tasks (including Slack-originated), send messages to PM
2. Abstract the "user channel" concept: replace `slack_threads` with generic `channels` record so tasks can have Slack, GitHub, or no delivery channel
3. Build an Ink (React) TUI: task list with status, drill into task to see agents + chat, send messages

The CLI is a **separate process** connecting to the running server via HTTP REST + SSE. The server keeps running Slack + GitHub webhooks as before.

**Key insight**: CLI is NOT a channel. Channels are active message delivery targets (Slack threads, GitHub PRs). CLI receives data passively via SSE events and knowledge.log. CLI-originated tasks have `default_channel: null`.

## Step 1: Event Bus

New file `src/system/event-bus.ts` — typed EventEmitter singleton.

```typescript
export type EventType =
  | 'task:created' | 'task:stopped' | 'task:completed'
  | 'agent:active' | 'agent:inactive'
  | 'message:to_user' | 'message:agent' | 'message:finding' | 'message:user_input'
  | 'approval:requested' | 'approval:resolved';

export interface SystemEvent {
  type: EventType;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

export function emitEvent(type, taskId, data?, agentName?): void
```

**Instrument existing code** — add `emitEvent()` calls (one line each) in:
- `src/tasks/task.ts`: `create()`, `stop()`, `complete()`, `updateAgentState()`, `postToUser()`
- `src/tasks/persistence.ts`: `appendSlackMessage()`, `appendAgentFinding()`
- `src/agents/tools.ts`: `post_to_slack`, `send_message_to_agent`, `log_finding`, `request_edit_mode`

## Step 2: API Routes + SSE

New file `src/connectors/api/routes.ts` — mounted on the existing Express app.

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/events/stream` | SSE stream (optional `?taskId=` filter) |
| GET | `/api/tasks` | List tasks (active + recent stopped/completed) |
| GET | `/api/tasks/:id` | Task detail: metadata + knowledge.log + agent status |
| POST | `/api/tasks` | Create task from CLI input |
| POST | `/api/tasks/:id/message` | Send user message to PM |
| POST | `/api/tasks/:id/approve` | Approve/deny edit mode or research budget |

**SSE implementation:** Raw Node.js response with `text/event-stream` headers. Subscribes to `eventBus.on('event', ...)`, writes `data: {json}\n\n` frames. 30s keepalive. Cleanup on `req.close`.

**Mount in `src/index.ts`:** Add `express.json()` middleware scoped to `/api`, then `mountApiRoutes(app)` after health check.

## Step 3: Channel Abstraction

### 3a: Types (`src/types/task.ts`)

**Channels replace `slack_threads`.** A `Record<string, Channel>` keyed by channel ID.

Channels are **active message delivery targets** — places where the system POSTs messages to. CLI is NOT a channel: it receives data passively via SSE events and renders knowledge.log. CLI sends input via REST API.

```typescript
export type ChannelType = 'slack' | 'github';

/** Base channel — all channels have type */
export interface ChannelBase {
  type: ChannelType;
}

/** Slack channel — wraps a specific thread in a Slack channel */
export interface SlackChannel extends ChannelBase {
  type: 'slack';
  thread_id: string;
  channel_id: string;
  channel_name: string;
  last_processed_ts: string;
}

/** GitHub channel — a PR conversation */
export interface GitHubChannel extends ChannelBase {
  type: 'github';
  repo: string;
  pr_number: number;
}

export type Channel = SlackChannel | GitHubChannel;
```

Replace `slack_threads` in `TaskMetadata`:
```typescript
export interface TaskMetadata {
  // ... existing fields ...
  channels: Record<string, Channel>;   // REPLACES slack_threads — keyed by channel ID
  default_channel: string | null;      // channel ID of the originating channel (null for CLI-originated tasks)
  // Remove: slack_threads: SlackThreadRef[]
}
```

Channel IDs:
- Slack: `slack:${channel_id}:${thread_id}` (unique per thread)
- GitHub: `github:${repo}:${pr_number}`

`default_channel` stores the channel ID (not the type), so it points to the exact thread that initiated the task. For CLI-originated tasks, `default_channel` is `null` — no active delivery target. The event bus + SSE handles CLI delivery automatically.

### 3b: Migration strategy (slack_threads → channels)

**On load** (Task constructor): If metadata has `slack_threads` but no `channels`, migrate and drop it:
```typescript
if (metadata.slack_threads?.length && !metadata.channels) {
  metadata.channels = {};
  for (const ref of metadata.slack_threads) {
    const id = `slack:${ref.channel_id}:${ref.thread_id}`;
    metadata.channels[id] = {
      type: 'slack', thread_id: ref.thread_id, channel_id: ref.channel_id,
      channel_name: '', last_processed_ts: ref.last_processed_ts,
    };
    metadata.default_channel ??= id;
  }
  delete metadata.slack_threads; // drop legacy field
}
```

**On save**: Only write `channels`. Never write `slack_threads`. New tasks never have it.

**`findTaskByThread` grep** in persistence.ts: Already greps for `"thread_id": "${threadId}"` — this still matches inside the `channels` object since `thread_id` is a field on `SlackChannel`. No grep change needed.

**`SlackThreadRef` type**: Stays as param type for `postToThreads()` in client.ts. Channel dispatcher constructs it on the fly from `SlackChannel` when posting.

**`slack_threads` on TaskMetadata**: Becomes `slack_threads?: SlackThreadRef[]` (optional). Only present on old tasks loaded from disk, removed after first save. All runtime code reads `channels` only.

### 3c: Channel Dispatcher (`src/tasks/channels.ts` — new file)

```typescript
export async function postToUser(taskId, metadata, message): Promise<void>
// 1. Always emit event (so CLI sees it via SSE regardless of channel)
//    emitEvent('message:to_user', taskId, { message })
// 2. If default_channel is set, look up metadata.channels[metadata.default_channel]
//    and dispatch based on channel.type:
//      'slack' → postToThreads([{ thread_id, channel_id, last_processed_ts }], message)
//      'github' → skip for now (not a primary communication channel)
// 3. If default_channel is null (CLI-originated) — event emission above is sufficient

export async function broadcastToAllChannels(taskId, metadata, message): Promise<void>
// Emit event + post to ALL channels in metadata.channels

export async function postInteractiveToUser(taskId, metadata, text, blocks, approvalType): Promise<void>
// Same dispatch logic. Always emits approval:requested event (for CLI).
// If default_channel is Slack, also sends Slack interactive message with buttons.
```

### 3d: Refactor Task methods

In `src/tasks/task.ts`:
- `postToSlack(message)` → rename to `postToUser(message)` — calls channel dispatcher
- `postInteractiveToSlack(text, blocks)` → rename to `postInteractiveToUser(text, blocks)`
- Update all internal callers (~6 in task.ts: timeout, budget warnings, approval flow)
- `append(thread: SlackThread)` → still works, creates/updates a Slack channel entry in `metadata.channels`

In `src/agents/tools.ts`:
- `createPostToSlackTool` → calls `task.postToUser(message)` instead of `task.postToSlack(message)`
- `createRequestEditModeTool` → calls `task.postInteractiveToUser(...)`
- `createReportCompletionTool` → calls `task.postToUser(message)`

### 3e: Wire channel population

In `src/connectors/slack/events.ts` `handleSlackEvent`:
- `new_task`: `task.append(thread)` already runs — `append()` will create the Slack channel entry + set `default_channel`
- `existing_task` + new thread: `append()` adds a new channel entry, `default_channel` stays as the original

In `src/connectors/api/routes.ts` — POST `/api/tasks`:
```typescript
// CLI-originated task: no active delivery channel
task.metadata.channels = {};
task.metadata.default_channel = null;
```

POST `/api/tasks/:id/message` — when a CLI user sends a message to a task:
```typescript
// Append to knowledge.log so PM sees it
await appendCliMessage(taskId, userName, message);
// Emit event so other CLI observers see the new message
emitEvent('message:user_input', taskId, { message, source: 'cli' });
// Resume/wake PM agent with the new message
await task.sendMessage(AGENT_PROMPTS.existingTask);
```

### 3f: Knowledge log for CLI messages

Add to `src/tasks/persistence.ts`:
```typescript
export async function appendCliMessage(taskId, userName, message): Promise<void>
// Format: [timestamp] [cli:userName] [@userName] message
```

### 3g: PM prompt update

In `prompts/pm-agent.md`, section "Communication Channel Philosophy":
- Change "**Slack** is where your requester lives" → "**The originating channel** is where your requester lives (Slack, CLI, or other). Your `post_to_slack` tool automatically routes to the correct channel."
- Keep tool name `post_to_slack` for now (rename is a separate PR)

## Step 4: CLI TUI (Ink)

### 4a: Dependencies

```
npm install ink@5 react@18 ink-text-input@6 ink-spinner@5
npm install -D @types/react@18
```

Add `"jsx": "react-jsx"` to `tsconfig.json` compilerOptions (harmless for non-JSX files).

Add to package.json scripts:
```json
"cli": "tsx src/cli/index.tsx"
```

### 4b: File structure

```
src/cli/
  index.tsx              — entry point, parse args, render <App />
  api.ts                 — HTTP client (fetch) + SSE connection (manual frame parser)
  App.tsx                — top-level: routing between TaskList and TaskDetail views
  components/
    TaskList.tsx         — arrow-key navigable list, status icons, Enter to drill in
    TaskDetail.tsx       — agents bar at top, knowledge.log in main area, input at bottom
    MessageInput.tsx     — text input with Tab to focus, Enter to send
    ApprovalPrompt.tsx   — [y/n] prompt when approval:requested SSE arrives
    StatusBar.tsx        — connection status, keybindings hint
```

### 4c: Key components

**App.tsx**: Two views — `list` and `detail`. SSE connection in useEffect, reconnects on view change. `q` to quit, `Esc` to go back.

**TaskList.tsx**: Fetches `/api/tasks` on mount. Shows each task: status icon (`[*]` in_progress, `[+]` completed, `[-]` stopped), task_id, owner, participants. Arrow keys + Enter. `n` to create new task (prompts for message).

**TaskDetail.tsx**: Fetches `/api/tasks/:id` on mount. Top section: agent cards with active/idle indicator. Main section: knowledge.log lines (last 30, re-fetched on SSE events). Bottom: `<MessageInput>` that POSTs to `/api/tasks/:id/message`. When `approval:requested` SSE event arrives, shows `<ApprovalPrompt>`.

**api.ts**: SSE via `fetch()` + ReadableStream (Node 18+ native). Manual `data: ` frame parsing. Auto-reconnect on disconnect (3s delay).

## Step 5: Build + Verify

1. `npm run typecheck` — all steps compile
2. `npm run build` — produces dist/
3. Start server: `npm run dev`
4. In another terminal: `npm run cli` — should connect, show task list
5. Create task from CLI: `n` → type message → verify PM agent spawns
6. Create task from Slack: verify CLI shows it in list, can drill in
7. Agent posts to user: verify message appears in CLI via SSE for CLI-originated task (no Slack post), and in both Slack + CLI SSE for Slack-originated task
8. Approval flow: request edit mode → CLI shows [y/n] via SSE approval:requested event, approve via POST → task resumes

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/system/event-bus.ts` | NEW | Typed EventEmitter + `emitEvent()` helper |
| `src/connectors/api/routes.ts` | NEW | REST + SSE endpoints for CLI |
| `src/tasks/channels.ts` | NEW | Channel dispatcher: `postToUser()`, `broadcastToAllChannels()`, `postInteractiveToUser()` |
| `src/cli/index.tsx` | NEW | CLI entry point |
| `src/cli/api.ts` | NEW | HTTP + SSE client |
| `src/cli/App.tsx` | NEW | Main Ink app component |
| `src/cli/components/*.tsx` | NEW | TaskList, TaskDetail, MessageInput, ApprovalPrompt, StatusBar |
| `src/types/task.ts` | EDIT | Add Channel types (Slack, GitHub — no CLI); replace `slack_threads` with `channels: Record<string, Channel>` + `default_channel: string \| null` |
| `src/tasks/task.ts` | EDIT | Rename `postToSlack` → `postToUser`; rewrite `append()` for channels record; add emitEvent calls |
| `src/tasks/persistence.ts` | EDIT | Add `appendCliMessage()`; update `findTaskByThread` grep; add emitEvent calls |
| `src/agents/tools.ts` | EDIT | Use `task.postToUser()`; add emitEvent calls |
| `src/agents/spawn.ts` | EDIT | Update context string to read from `metadata.channels` instead of `slack_threads` |
| `src/index.ts` | EDIT | Mount API routes |
| `src/connectors/slack/events.ts` | EDIT | Channel population handled by `task.append()` now; update cancel_task to use channels |
| `prompts/pm-agent.md` | EDIT | Channel-agnostic wording |
| `package.json` | EDIT | Add ink, react deps; add cli script |
| `tsconfig.json` | EDIT | Add jsx: react-jsx |

## Deployment & Access

The API listens on localhost only — never exposed publicly. CLI connects via:

- **Local Docker dev**: `docker exec -it archie-hq npm run cli` or expose port on localhost only (`127.0.0.1:3000:3000` in docker-compose)
- **Production**: SSH tunnel — `ssh -L 3000:localhost:3000 your-server`, then run CLI locally against `localhost:3000`
- **Production (alternative)**: SSH into server, exec into container, run CLI there

## What Doesn't Change

- `src/agents/agent.ts` — untouched
- `src/connectors/github/*` — untouched (GitHub channel wiring is future work)
- `src/tasks/recovery.ts` — untouched
- `src/connectors/slack/client.ts` — untouched (`postToThreads` still takes `SlackThreadRef[]`, channel dispatcher bridges)
- Tool name `post_to_slack` — stays for now (rename is future work)
