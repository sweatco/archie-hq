## Context

The `archie-debug` MCP (`tools/debug-mcp/`) is a stdio server that wraps the Archie REST API via `ArchieClient`. Its current tools are all single-shot: `create_task`, `list_tasks`, `task_status`, `send_message`, `get_log`, `get_events`, `approve`. Verifying an asynchronous task (DM in → task created → PM replies → completes, possibly via an approval gate) has no first-class "wait" — callers busy-poll, either from a bash helper or by having the agent call `get_events` in a loop (no sleep, large payloads accrue in the agent's context, non-deterministic stop).

The pieces to build on already exist:
- `ArchieClient.listTasks()` → `TaskSummary[]`; `getTaskDetail(id)` → `{ metadata, knowledgeLog }`; `getEvents(id, after?)` → `{ events, total }`.
- `getEvents` already exposes an `after` cursor, and `result.total` is the cursor to pass next — an incremental poll model is in place.
- Events are `{ type, taskId, timestamp, agentName?, data }`; PM replies are `type === "message"` with `data.from === "pm-agent"` and text in `data.message`. Terminal/gate signals are `task:completed`, `task:stopped`, `approval:requested`.
- Since PR #134 the server resolves its base URL per-checkout (`ARCHIE_URL` → `$PORT` → `.env` PORT → `:3000`), so a new tool is port-correct per worktree with no extra wiring.

## Goals / Non-Goals

**Goals:**
- One blocking MCP call that correlates a task (by `task_id` or `nonce`) and waits until it reaches `task:completed` / `task:stopped` / `approval:requested`, returning a compact result (`state`, `task_id`, `attribution`, `pm_replies`, `approval_type?`).
- Bounded and resumable: never hang the tool call; return `pending` + a cursor when a cap is hit so the caller resumes with one more call.
- Reuse existing REST endpoints and the existing `after`/`total` cursor; poll incrementally.
- Correct order-aware state precedence: `completed` always wins, an unresolved approval outranks the gate's deferred `task:stopped`, and a `task:resumed` cancels a stale stop.

**Non-Goals:**
- No new Archie server endpoints and no runtime/app behavior change — all logic lives in the MCP process.
- Not auto-approving gates: on `approval_requested` the caller still calls the existing `approve` tool and resumes.
- Not a true event-bus / SSE long-poll in Archie (a possible later refinement, noted below).
- Not changing or removing the existing seven tools.
- Not modifying the `archie-e2e` skill here — dropping its `wait-task.sh` for this tool is a separate follow-up PR.

## Decisions

**1. Poll inside the MCP process (not the agent, not a new server endpoint).**
The MCP server is a Node process that can `await setTimeout` between polls and return only a summary. This keeps the busy-poll off the agent's context and needs no Archie change. *Alternatives:* agent-driven `get_events` looping (rejected — no sleep, context bloat, non-deterministic); a long-poll endpoint in Archie's REST driven by the event bus (rejected for now — core-app change and more risk; still subject to the client timeout in Decision 4).

**2. Derive state by folding the ordered events feed.**
A single `getEvents` feed yields lifecycle signals, the approval gate, and PM replies together. Because the feed replays full history and the edit-mode gate emits `approval:requested` and *then* a deferred `task:stopped` (approval later reactivates with `task:resumed`), fold events in order rather than by unordered presence: track the latest lifecycle state (`task:created`/`task:resumed` → running, `task:stopped` → stopped, `task:completed` → completed) and whether an approval is currently pending (`approval:requested` sets it; `approval:resolved`, `task:resumed`, or `task:completed` clear it). Precedence: `completed` wins; else an unresolved approval → `approval_requested`; else `stopped`. This makes a gate report `approval_requested` (not `stopped`) and keeps a post-approval resume from being misread as `stopped`. Collect `pm_replies` from `type==="message" && data.from==="pm-agent"`. *Alternative:* poll `metadata.status` (rejected — doesn't surface the approval gate or the replies; needs a second source).

**3. Cursor = the events `total`, resumable across calls.**
Poll `getEvents(id, after=cursor)`, advance `cursor = result.total`, process only new events. When returning `pending`, hand the cursor back; the next call passes it as `after`. This reuses the model the `get_events` tool already documents.

**4. Bounded wait cap (~45s) with `pending` + cursor.**
MCP clients impose a per-tool-call timeout, so a single call must always return well within it. Block up to a conservative cap; if unsettled, return `state:"pending"` + cursor. For this use (PM replies in seconds) one call settles it; slow/gated tasks take a second call. *Alternatives:* one unbounded blocking call (rejected — risks the client killing the call); relying on raising `MCP_TIMEOUT` (rejected — env-dependent and fragile).

**5. Nonce correlation scans a bounded most-recent window.**
When only a `nonce` is given, each poll scans the most-recent N tasks (e.g. 25) from `listTasks()` and checks each `knowledgeLog` for the nonce, until found or the cap elapses; if never seen, return `state:"not_found"` (structured, not an error) so the caller can retry. Bounding the window keeps cost predictable when many tasks exist. *Alternative:* require `task_id` only (rejected — correlating an async DM by nonce is the primary use).

**6. Compact, greppable result.**
Return MCP text content with labeled fields (`TASK=`, `STATE=`, `ATTRIBUTION=`, `PM_REPLY:` lines, `CURSOR=`, `APPROVAL_TYPE=`) mirroring the shape `wait-task.sh` printed, so adoption is a drop-in and the output stays easy to assert on.

## Risks / Trade-offs

- **MCP client tool-call timeout varies by client/config** → cap the internal wait conservatively (Decision 4) and keep it resumable; document the cap.
- **`listTasks` scan cost when there are many tasks** → bound to a most-recent window (Decision 5); the nonce path is for fresh test traffic where the task is recent.
- **Polling is relocated, not eliminated** → acceptable: it leaves the agent's context and uses the incremental `after` cursor. A true long-poll remains a future option.
- **State detection depends on event-type strings** → they are the strings the app emits today (`task:created`, `task:resumed`, `task:stopped`, `task:completed`, `approval:requested`, `approval:resolved`); pinned by the spec scenarios and unit tests.
- **Nonce false-positive substring match** → nonces are high-entropy (`E2E-<hex>`); negligible, and the match can be scoped to the attribution/first line if needed.

## Migration Plan

Additive only — a new tool, no migration and no persisted state. Rollout: land in `tools/debug-mcp/`, reconnect the MCP, and `wait_for_task` is available (port-correct per checkout). Follow-up (separate PR): simplify the `archie-e2e` skill to call `wait_for_task` and delete `wait-task.sh`. Rollback: remove the tool registration; nothing else depends on it.

## Open Questions

- Exact wait cap value (45s assumed) — confirm against the MCP client's actual tool-call timeout.
- Should correlation optionally accept a `user`/`channel` filter to disambiguate when several recent tasks could match a nonce-less query? (Default: nonce or id only.)
- Most-recent window size for the nonce scan (25 assumed) — revisit if dev workdirs routinely hold more concurrent recent tasks.
