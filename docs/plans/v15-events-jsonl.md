# Persistent JSONL Event Log + Event-Based CLI Rendering

## Context

System events flow through a volatile in-memory EventEmitter → SSE → CLI. If the CLI disconnects, events are lost. The CLI currently re-fetches the full task detail (metadata + knowledge.log text) on every SSE event — inefficient and lossy.

Goal: persist events to `events.jsonl` per task and have the CLI render directly from structured events instead of knowledge.log. This gives us:
1. CLI rendering from structured events (richer, more reliable)
2. Replay on reconnect (fetch missed events by line offset)
3. Full audit trail per task

## Step 1: Persistence functions in `src/tasks/persistence.ts`

**Path helper:**
```typescript
export function getEventsLogPath(taskId: string): string {
  return join(getSharedPath(taskId), 'events.jsonl');
}
```

**Append function** (fire-and-forget, serialized writes per task):
```typescript
const writeQueues = new Map<string, Promise<void>>();

export async function appendEvent(event: SystemEvent): Promise<void> {
  const prev = writeQueues.get(event.taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const dir = getSharedPath(event.taskId);
      if (!existsSync(dir)) return;
      await appendFile(getEventsLogPath(event.taskId), JSON.stringify(event) + '\n');
    } catch (err) {
      logger.warn('events', `Failed to persist event for ${event.taskId}: ${err}`);
    }
  });
  writeQueues.set(event.taskId, next);
}
```

**Read function** (streaming, offset-based — skips lines without loading full file):
```typescript
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

export async function readEvents(taskId: string, after?: number): Promise<{ events: SystemEvent[]; total: number }> {
  const eventsPath = getEventsLogPath(taskId);
  if (!existsSync(eventsPath)) return { events: [], total: 0 };

  const events: SystemEvent[] = [];
  let lineNum = 0;
  const start = after ?? 0;

  const rl = createInterface({ input: createReadStream(eventsPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (lineNum++ < start) continue;
    try { events.push(JSON.parse(line)); }
    catch { /* skip malformed */ }
  }

  return { events, total: lineNum };
}
```

**Init function** (follows existing `init*()` pattern):
```typescript
export function initEventPersistence(): void {
  onEvent((event: SystemEvent) => { void appendEvent(event); });
}
```

## Step 2: Register at startup in `src/index.ts`

After `initRegistry()`, call `initEventPersistence()`.

## Step 3: Fix missing GitHub event emission in `src/tasks/persistence.ts`

`appendGitHubEvent()` is the only append function that doesn't emit an event. Add:
```typescript
emitEvent('message:github', taskId, { repoKey, message });
```

Add `'message:github'` to the `EventType` union in `src/system/event-bus.ts`.

## Step 3b: Include approval type in `approval:requested` event

Currently `postInteractiveToUser(text, blocks)` emits `{ text }` but not the approval type.
Add an `approvalType` parameter so the event carries `{ text, approvalType }`:

In `src/tasks/task.ts`:
```typescript
async postInteractiveToUser(text: string, blocks: unknown[], approvalType: 'edit_mode' | 'research_budget'): Promise<void> {
  emitEvent('approval:requested', this.taskId, { text, approvalType });
  // ... rest unchanged
}
```

Update callers:
- `src/agents/tools.ts` (request_edit_mode): `task.postInteractiveToUser(..., 'edit_mode')`
- `src/tasks/task.ts` (research budget): `this.postInteractiveToUser(..., 'research_budget')`

The CLI uses `approvalType` from the event to call `POST /api/tasks/:id/approve` with the correct type.

## Step 4: API endpoint in `src/connectors/api/routes.ts`

New endpoint `GET /api/tasks/:id/events?after=<lineNumber>`:
```typescript
router.get('/tasks/:id/events', async (req, res) => {
  const after = req.query.after ? parseInt(req.query.after as string, 10) : undefined;
  const result = await readEvents(req.params.id, after);
  res.json(result); // { events: [...], total: N }
});
```

## Step 5: CLI API client in `src/cli/api.ts`

Add `fetchTaskEvents(taskId, after?)` helper that calls the new endpoint.

## Step 6: CLI renders from events in `src/cli/components/TaskDetail.tsx`

Replace knowledge.log rendering with event-based rendering.

**State changes:**
- Remove: `logLines: string[]`
- Add: `events: SystemEvent[]`, `eventCursor: number`

**On mount:** fetch `GET /api/tasks/:id/events` → store events + set cursor to `total`

**On SSE event:** append the event to the in-memory array, increment cursor

**On reconnect:** fetch `GET /api/tasks/:id/events?after={cursor}` → append missed events, update cursor

**Event → display line formatting** (a `formatEvent` function):
```typescript
function formatEvent(event: SystemEvent): string | null {
  switch (event.type) {
    case 'message:user_input':
      // data: { source, user?, message }
      const prefix = event.data.user ? `@${event.data.user}` : '[cli]';
      return `${prefix} ${event.data.message}`;
    case 'message:finding':
      // data: { finding, type? } + agentName
      return `[${event.agentName}] ${event.data.finding}`;
    case 'message:to_user':
      // data: { message } + agentName
      return `[${event.agentName || 'system'}] ${event.data.message}`;
    case 'message:github':
      // data: { repoKey, message }
      return `[github:${event.data.repoKey}] ${event.data.message}`;
    case 'task:created':
    case 'task:stopped':
    case 'task:completed':
      return `--- ${event.type.replace('task:', '')} ---`;
    case 'agent:active':
    case 'agent:inactive':
      return null; // don't render as log lines — shown in agents bar
    case 'approval:requested':
      // Pending: shows action hint; resolved: shows result
      return null; // handled by interactive rendering below
    case 'approval:resolved':
      return `${event.data.approve ? '✅' : '❌'} Approval ${event.data.approve ? 'granted' : 'denied'}: ${event.data.type}`;
    default:
      return null;
  }
}
```

**Interactive approval lines:** `approval:requested` events that have no matching `approval:resolved`
are rendered as focusable interactive lines instead of plain text:

```
⏳ Edit mode request: need to modify API  [y] approve / [n] deny
```

When focused (highlighted), pressing `y` approves and `n` denies.

**Tab focus cycle:** Tab cycles between: message input → pending approval lines (in order) → back to input.
The focused element is highlighted (bold/inverse). `y/n` only acts on the currently focused approval.
After resolution, the line becomes plain text (`✅ Approved` / `❌ Denied`) and drops out of the Tab cycle.

**Deriving pending approvals from events:**
```typescript
const pendingApprovals = events
  .filter(e => e.type === 'approval:requested')
  .filter(req => !events.some(e =>
    e.type === 'approval:resolved' && e.timestamp > req.timestamp
  ));
```

This works for both JSONL replay (attach to task mid-approval) and live SSE events.

**Key benefit:** No more polling `/api/tasks/:id` for the full knowledge.log on every event. The CLI just appends new events to its local array. Approvals are inline — no separate overlay component.

## Step 7: Simplify `src/cli/App.tsx`

- Remove `refreshTrigger` mechanism — TaskDetail manages its own events now
- SSE `onEvent` passes the event directly to TaskDetail (via callback prop or state)
- `onConnect` triggers TaskDetail to fetch missed events

## Step 8: Remove knowledge.log dependency from API

The `GET /api/tasks/:id` endpoint can stop returning `knowledgeLog`. The CLI no longer needs it. Keep knowledge.log writing on the server for backward compat (Slack messages, PM agent reads it), but CLI doesn't fetch it.

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/tasks/persistence.ts` | EDIT | +45: `getEventsLogPath`, `appendEvent`, `readEvents`, `initEventPersistence`; add `emitEvent` to `appendGitHubEvent` |
| `src/system/event-bus.ts` | EDIT | +1: add `'message:github'` to EventType |
| `src/index.ts` | EDIT | +2: import + call `initEventPersistence()` |
| `src/connectors/api/routes.ts` | EDIT | +15: new `GET /tasks/:id/events` endpoint |
| `src/cli/api.ts` | EDIT | +10: `fetchTaskEvents()` |
| `src/cli/components/TaskDetail.tsx` | EDIT | Rewrite to render from events array instead of knowledge.log lines; inline approval handling |
| `src/cli/components/ApprovalPrompt.tsx` | DELETE | Replaced by inline interactive approval lines in the event log |
| `src/cli/App.tsx` | EDIT | Pass SSE events to TaskDetail, remove refreshTrigger polling |
| `src/tasks/task.ts` | EDIT | Add `approvalType` param to `postInteractiveToUser()` |
| `src/agents/tools.ts` | EDIT | Pass `'edit_mode'` to `postInteractiveToUser()` |

## What Doesn't Change

- `event-bus.ts` — minimal change (one new event type)
- `knowledge.log` — still written server-side (PM agent reads it), just not fetched by CLI
- `metadata.json` — unchanged
- SSE endpoint — unchanged (live push continues)
- `task.ts` — no changes

## Verification

1. `npm run typecheck` + `npm run build`
2. Start server, create task → verify `events.jsonl` appears
3. `curl localhost:3000/api/tasks/{id}/events` → `{ events: [...], total: N }`
4. `curl localhost:3000/api/tasks/{id}/events?after=5` → events from line 5 onward
5. Open CLI → task detail shows events rendered as lines
6. Send Slack message → appears in CLI via SSE (no full re-fetch)
7. Disconnect/reconnect CLI → missed events replayed correctly
