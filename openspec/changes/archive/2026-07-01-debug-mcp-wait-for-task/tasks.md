## 1. Result model and testable core

- [x] 1.1 Define a `WaitState` union (`completed | stopped | approval_requested | pending | not_found`) and a `WaitResult` type (`task_id`, `state`, `attribution`, `pm_replies`, `cursor?`, `approval_type?`) in `tools/debug-mcp/wait-for-task.ts`
- [x] 1.2 Add tunables: per-call wait cap (~45s, below the MCP client tool-call timeout) and poll interval (~2–3s)
- [x] 1.3 Extract the logic into an exported async function `waitForTask(client, { taskId?, nonce?, timeoutSeconds?, cursor? }, deps?)` that takes an `ArchieClient`-shaped dependency, so it is unit-testable with a fake client; the tool handler is a thin wrapper

## 2. Task correlation

- [x] 2.1 Validate input: require `task_id` or `nonce`; throw a clear validation error if neither is provided
- [x] 2.2 Resolve by id: when `task_id` is given, use it directly (no list scan)
- [x] 2.3 Resolve by nonce: scan the most-recent N tasks (default 25) from `listTasks()`, check each `getTaskDetail().knowledgeLog` for the nonce; retry across polls until found or the cap elapses
- [x] 2.4 Return `state: "not_found"` (structured, non-error) when a nonce never correlates before the cap

## 3. Event polling and state detection

- [x] 3.1 Poll `getEvents(taskId, after=cursor)` on the interval, advancing `cursor = result.total`, processing only newly returned events
- [x] 3.2 Detect state by folding the ordered feed: track the latest lifecycle event (`task:created`/`task:resumed` → running, `task:stopped` → stopped, `task:completed` → completed, so a `task:resumed` cancels a stale stop) and a pending-approval flag (`approval:requested` sets it; `approval:resolved`/`task:resumed`/`task:completed` clear it); precedence is `completed` > unresolved approval > `stopped`
- [x] 3.3 On `approval:requested` (and no terminal), extract `approval_type` (`edit_mode` | `research_budget`) from the event data
- [x] 3.4 Collect `pm_replies` from events where `type === "message"` and `data.from === "pm-agent"`
- [x] 3.5 Set `attribution` to the first line of the task's `knowledgeLog`

## 4. Bounded, resumable loop

- [x] 4.1 Drive correlation + polling off a single deadline `= now + min(timeoutSeconds, CAP)`
- [x] 4.2 On reaching the cap with a resolved task but no terminal/approval state, return `state: "pending"` plus the current `cursor`
- [x] 4.3 Resume: when called with a `cursor` (and `task_id`), skip re-scan and resume `getEvents` from that cursor without reprocessing earlier events

## 5. Register the MCP tool

- [x] 5.1 Register `wait_for_task` via `server.tool(...)` with a zod schema `{ task_id?, nonce?, timeout_seconds?, cursor? }` and a description covering states and resumption
- [x] 5.2 Format the result as compact, greppable text (`TASK=`, `STATE=`, `ATTRIBUTION=`, `PM_REPLY:` lines, `CURSOR=`, `APPROVAL_TYPE=`), mirroring the old `wait-task.sh` output

## 6. Tests

- [x] 6.1 Unit-test state detection against fake event feeds: completed; stopped; approval_requested; approved+completed → `completed` (precedence)
- [x] 6.2 Unit-test nonce correlation: found within the window; `not_found` when absent; resolve-by-id path
- [x] 6.3 Unit-test bounded/resumable behavior: cap reached → `pending` + cursor; resume from cursor processes only new events
- [x] 6.4 Unit-test approval-gate ordering: `approval:requested` + deferred `task:stopped` → `approval_requested`; `task:resumed` cancels a stale stop (no spurious `stopped`); resume after the gate stop reaches `completed`
- [x] 6.5 Wire the tests into the repo's test command (mock the `ArchieClient` dependency; no running server required) — added `tools/**/*.test.ts` to `vitest.config.ts` `include`

## 7. Verification and docs

- [x] 7.1 Update the `tools/debug-mcp` tool list / header comment to include `wait_for_task` — there is no central tool list (no README; the header documents URL resolution), so the tool self-documents via its `server.tool(...)` description
- [x] 7.2 Typecheck the debug-mcp sources clean — the repo's `npm run typecheck` scopes to `src/**` (tools run via `tsx`), so verified with a targeted `tsc --noEmit` over the three `tools/debug-mcp/*.ts` files (exit 0); `vitest run` is 13/13
- [x] 7.3 Live check against a running Archie: `wait_for_task` by task_id/nonce returns `completed` with attribution + the PM reply, and an approval-gated task returns `approval_requested` then `completed` after `approve` — verified end-to-end (`approval_requested → pending → completed`, no spurious `stopped` on resume)
