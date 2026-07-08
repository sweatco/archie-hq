## MODIFIED Requirements

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
