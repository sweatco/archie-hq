## MODIFIED Requirements

### Requirement: Handle the edit-mode approval gate

When a scenario's task reaches `approval_requested`, the harness SHALL resolve the gate through the API path (the MCP `approve` tool over `POST /api/tasks/:id/approve`) with the decision the scenario's recipe prescribes — approve by default, deny where the recipe exercises a denial path — and continue waiting, observing the task proceed to the recipe's expected state.

#### Scenario: Edit-mode gate approved and task completes

- **WHEN** `wait_for_task` reports `approval_requested` with type `edit_mode` and the harness calls `approve(task_id, edit_mode, true)`
- **THEN** continued waiting observes the task reach `completed`, with the approval and resume visible in the events

#### Scenario: Recipe-prescribed denial resolves the gate

- **WHEN** `wait_for_task` reports `approval_requested` and the recipe prescribes denial (e.g. `merge-approval-deny` calls `approve(task_id, merge, false)` with the pending PR's `github`/`pr_number`, as the merge type requires)
- **THEN** continued waiting observes the task reach the recipe's expected terminal state, with the denial visible in the events and the denied action never executed
