# AC3 runner notes — edit-mode-approval scenario via the API path

**Runner:** black-box QA (Forge Stage 4), 2026-07-04. Branch `forge/archie-e2e-harness` @ `1cb2497`. Same booted session as AC2, run serially after it.

## Prerequisite check

SKILL.md requires at least one configured engineering repo in the workdir. Confirmed present: `workdir/repos/{backend,infrastructure,mobile,sweatco}`. Not blocked.

## Recipe execution (SKILL.md `edit-mode-approval`)

1. Nonce `E2E-5b802fcb`; `create_task` with a small, real change request against the configured backend repo → `task-20260704-1900-lp6jsq`. Deviation from the recipe's *example* message only: the change was scoped to the local worktree ("do NOT push, do NOT open a PR") to avoid creating a real PR on a production repo from a QA run. The recipe's requirement — a change request that trips the edit-mode gate — is unchanged, and the gate did trip.
2. `wait_for_task(nonce)` → `TASK=…, STATE=pending, CURSOR=18` (PM delegated to backend-agent).
3. Resume `wait_for_task(task_id, cursor: 18)` → `STATE=approval_requested`; `get_events` shows `approval:requested` at 19:01:49.458Z with `data.approvalType: "edit_mode"`. Notably the gate is real: backend-agent's pre-approval edit attempt failed with "Read-only file system" / "Write denied" (knowledge-log blocker line at 19:01:32).
4. `approve(task_id, type: "edit_mode", approve: true)` via the MCP tool (the POST /api/tasks/:id/approve path) → `Approved edit_mode for task-20260704-1900-lp6jsq`.
5. Resume `wait_for_task(task_id, cursor: 30)` → `STATE=completed`. Events: `approval:resolved {type: edit_mode, approve: true}` (19:02:07.711Z) → `task:resumed` → `task:completed` (19:02:59.493Z). Knowledge log records `[system] [decision] Edit mode approved by user` and backend-agent's completion (line appended, `git status` shows ` M README.md`, no push, no PR).

Scenario wall time: **~2m53s** (19:00:06 → 19:02:59).

## Observations

- The `wait_for_task` output at `approval_requested` did not include an `APPROVAL_TYPE=edit_mode` line as SKILL.md step 4 implies ("On STATE=approval_requested with APPROVAL_TYPE=edit_mode"); the type had to be confirmed from `get_events` (`data.approvalType`). Minor doc/output mismatch — not blocking, since the events path is also documented.
- Cleanup: the scenario's intentional worktree edit lived under `workdir/sessions/task-20260704-1900-lp6jsq/.../sweatcoin-backend/README.md`; restored to its original blob after evidence capture so no test residue remains in the runtime workdir.

## Assertions

Five recorded in the harness-written evidence (`edit-mode-approval.{json,md}`): approval_requested detected with edit_mode type, approve acknowledged via API path with approval:resolved event, task resumed, task completed with the edit confirmed, gate-is-real (read-only before approval). 5/5 PASS.

## Verdict: PASS
