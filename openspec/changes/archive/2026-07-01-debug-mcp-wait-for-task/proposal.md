## Why

The `archie-debug` MCP exposes only single-shot reads (`list_tasks`, `get_events`, `task_status`). Verifying an asynchronous task — waiting until it completes, is stopped, or hits an approval gate — therefore forces callers to busy-poll: a bash helper hammering the REST API, or the agent calling `get_events` in a loop (no sleep primitive, large payloads flood its context, non-deterministic stop condition). There is no first-class "wait until this task reaches a state" primitive. Now that the debug MCP resolves its port per-checkout (PR #134), the MCP is the natural home for that waiting — letting one call replace the throwaway polling.

## What Changes

- Add a new `wait_for_task` tool to the `archie-debug` MCP that blocks **server-side** (inside the MCP process) until a task reaches a terminal/actionable state — `task:completed`, `task:stopped`, or `approval:requested` — or a timeout, then returns a compact result.
- Locate the target task by `task_id`, or by a `nonce` substring in its knowledge log (with retry, since a task appears asynchronously after a Slack DM).
- Return: resolved `state`, the attribution line (first knowledge-log line, carrying the `@<U…:Name>` marker), any `pm-agent` replies, the task id, and the approval `type` (`edit_mode` | `research_budget`) when gated.
- **Bounded, resumable** waiting: the tool caps its internal wait below typical MCP client tool-call timeouts and, if not yet settled, returns `state: "pending"` plus an event cursor so the caller resumes with one more call instead of busy-looping.
- Poll incrementally via the existing `/api/tasks/:id/events?after=<cursor>` endpoint (no full-history refetch each tick).
- Order-aware state folding: because the events feed replays full history, the tool folds it in order rather than by unordered presence — `task:completed` always wins, an unresolved `approval:requested` outranks the edit-mode gate's own deferred `task:stopped` (so a gate reports `approval_requested`, not `stopped`), and a later `task:resumed` cancels a stale `task:stopped` (so a resume after approval is not misread as stopped).

## Capabilities

### New Capabilities
- `debug-mcp-task-waiting`: server-side, bounded, resumable waiting in the `archie-debug` MCP — correlate a task by id or nonce and block until it reaches a terminal/actionable state, returning state + attribution + replies + approval type.

### Modified Capabilities
<!-- None. No existing spec covers the debug MCP, and its other seven tools are unchanged. -->

## Impact

- **Code**: `tools/debug-mcp/server.ts` (register the `wait_for_task` tool + correlation/poll loop), `tools/debug-mcp/archie-client.ts` (reuse `getEvents(after)`; add small helpers only if needed). Dev tooling only.
- **APIs**: consumes existing Archie REST endpoints (`/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/events?after=`). **No new Archie endpoints and no runtime/app behavior change** — the timed polling happens inside the MCP process.
- **Consumers**: the `archie-e2e` skill can later drop its `wait-task.sh` helper and call `wait_for_task` directly (separate follow-up PR — out of scope here).
- **Dependencies**: none new (existing `fetch`-based client; the MCP process performs the bounded polling and `setTimeout` waits).
