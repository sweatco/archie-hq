# debug-mcp-task-waiting Specification

## Purpose
TBD - created by archiving change debug-mcp-wait-for-task. Update Purpose after archive.
## Requirements
### Requirement: Resolve the target task by id or nonce

The `wait_for_task` tool SHALL accept either an explicit `task_id` or a `nonce`, and SHALL resolve the target task before waiting. When given only a `nonce`, it SHALL locate the task whose knowledge log contains that nonce, retrying while it polls because a task is created asynchronously after an inbound message. It SHALL require at least one of `task_id` or `nonce`.

#### Scenario: Resolve by explicit task id
- **WHEN** `wait_for_task` is called with a `task_id`
- **THEN** it waits on that task without scanning the task list

#### Scenario: Resolve by nonce
- **WHEN** `wait_for_task` is called with a `nonce` and no `task_id`
- **THEN** it scans tasks for one whose knowledge log contains the nonce and waits on the first match

#### Scenario: Neither id nor nonce supplied
- **WHEN** `wait_for_task` is called with neither `task_id` nor `nonce`
- **THEN** it fails fast with a validation error naming the missing input

#### Scenario: Nonce never appears within the call
- **WHEN** no task's knowledge log contains the nonce before the wait cap elapses
- **THEN** it returns `state: "not_found"` as a normal result (not an error) so the caller can retry

### Requirement: Block until a terminal or actionable state

The tool SHALL poll the resolved task's event feed until the task reaches a terminal or actionable state, or until the wait cap is reached. Because the feed replays full history — and approval gates (edit mode, research budget, merge) pause a task by emitting `approval:requested` and then a deferred `task:stopped`, with approval later reactivating via `task:resumed` — the tool SHALL fold events in order rather than by unordered presence. It SHALL track the latest lifecycle event (`task:created`/`task:resumed` → running, `task:stopped` → stopped, `task:completed` → completed) and whether an approval is pending (`approval:requested` sets it; `approval:resolved`, `task:resumed`, or `task:completed` clear it). Precedence SHALL be: `task:completed` wins; else an unresolved approval → `approval_requested`; else `task:stopped` → `stopped`.

#### Scenario: Task completes
- **WHEN** the event feed contains `task:completed`
- **THEN** it returns `state: "completed"`

#### Scenario: Task stopped without completing
- **WHEN** the latest lifecycle event is `task:stopped`, with no pending approval and no later `task:resumed` or `task:completed`
- **THEN** it returns `state: "stopped"`

#### Scenario: Approval gate reached (with its deferred stop)
- **WHEN** the feed contains `approval:requested` and the gate's deferred `task:stopped`, with no `task:completed` and no later `task:resumed`
- **THEN** it returns `state: "approval_requested"` together with the approval `type` (`edit_mode`, `research_budget`, or `merge`), never `stopped`

#### Scenario: Resume cancels a stale stop
- **WHEN** the feed contains `task:stopped` followed by `task:resumed` and no `task:completed`
- **THEN** it does not report `stopped` (the task is running again) and keeps waiting, returning `pending` at the cap

#### Scenario: Approved task that later completed (completed wins)
- **WHEN** the feed contains `approval:requested`, its `task:stopped`, and a later `task:completed`
- **THEN** it returns `state: "completed"`, never `approval_requested` or `stopped`

### Requirement: Bounded, resumable waiting

A single invocation SHALL cap how long it blocks, below typical MCP client tool-call timeouts, so the call always returns. If the task is resolved but has not reached a terminal/actionable state when the cap is reached, the tool SHALL return `state: "pending"` together with an opaque `cursor`. When called again with that `cursor`, it SHALL resume waiting without reprocessing earlier events.

#### Scenario: Wait cap reached before the task settles
- **WHEN** the per-call wait cap elapses with no terminal or approval state observed
- **THEN** it returns `state: "pending"` and a `cursor` for the next call

#### Scenario: Resume from a cursor
- **WHEN** `wait_for_task` is called with a `cursor` returned by a prior call
- **THEN** it resumes polling from that cursor and does not reprocess events before it

### Requirement: Return correlation and round-trip evidence

On resolving a task, the result SHALL include the `task_id`, the `attribution` line (the first knowledge-log line, which carries the `@<U…:Name>` marker), and `pm_replies` (the `pm-agent` messages observed, possibly empty).

#### Scenario: Result payload shape
- **WHEN** a task is resolved in any state
- **THEN** the result includes `task_id`, `state`, `attribution`, and `pm_replies`

### Requirement: Poll incrementally

The tool SHALL poll events using the events endpoint's `after` cursor so that each poll after the first fetches only newly appended events rather than the full history.

#### Scenario: Incremental fetch across polls
- **WHEN** the tool polls one task repeatedly
- **THEN** each request after the first passes the `after` cursor and processes only events appended since the previous poll

### Requirement: Implemented over existing endpoints only

The capability SHALL be implemented entirely within the `archie-debug` MCP process using existing Archie REST endpoints, introducing no new Archie server endpoints and no change to task or runtime behavior.

#### Scenario: Only existing endpoints are used
- **WHEN** `wait_for_task` runs
- **THEN** it calls only existing endpoints (`/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/events?after=`) and the Archie runtime is unchanged

