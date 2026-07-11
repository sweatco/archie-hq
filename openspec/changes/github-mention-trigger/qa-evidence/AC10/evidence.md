# AC10 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/agents/__tests__/readonly-github.test.ts` — run fresh via `npx vitest run src/agents/__tests__/readonly-github.test.ts --reporter=verbose`. File result: 11/11 passed. Raw output: `../raw/readonly-github.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "request_edit_mode declines fast on a GitHub-born task" — explanation text, `postInteractiveToUser` never called, no pause, `edit_allowed` never set | `request_edit_mode on a GitHub-born task (AC10) > declines fast: explanation, no prompt, no pause, edit_allowed never set` | ✓ pass |
| same-shaped case for `request_max_mode` | `request_max_mode on a GitHub-born task (AC10) > declines fast: explanation, no prompt, no pause, edit_allowed never set` | ✓ pass |
| `task.handleEditModeApproval` on GitHub-born → rejected disposition, `edit_allowed` unset, no agent restart | `handleEditModeApproval on a GitHub-born task > rejects: edit_allowed never set, no approver recorded, decision finding appended` | ✓ pass |
| `POST /tasks/:id/approve` route (fake req/res) → 403, no `approval:resolved` | `POST /tasks/:id/approve edit_mode on a GitHub-born task > returns 403, leaves edit_allowed unset, and emits no approval:resolved` | ✓ pass |
| Slack-born control case: unchanged behavior | `request_edit_mode on a Slack-born task > behaves exactly as before: posts the approval prompt and pauses`; `request_max_mode on a Slack-born task > behaves exactly as before: posts the approval prompt and pauses`; `handleEditModeApproval on a GitHub-born task > approves a Slack-born task exactly as before`; `POST /tasks/:id/approve edit_mode on a GitHub-born task > still resolves edit_mode approval for a Slack-born task with ok + approval:resolved` | ✓ pass (all 4) |

Bonus cases beyond the plan: three `buildGitHubBornContextLine` cases — all ✓ pass.

## Vitest output excerpt (from `../raw/readonly-github.txt`, run at 04:08:52)

```
 ✓ src/agents/__tests__/readonly-github.test.ts > request_edit_mode on a GitHub-born task (AC10) > declines fast: explanation, no prompt, no pause, edit_allowed never set 6ms
 ✓ src/agents/__tests__/readonly-github.test.ts > request_max_mode on a GitHub-born task (AC10) > declines fast: explanation, no prompt, no pause, edit_allowed never set 1ms
 ✓ src/agents/__tests__/readonly-github.test.ts > request_edit_mode on a Slack-born task > behaves exactly as before: posts the approval prompt and pauses 2ms
 ✓ src/agents/__tests__/readonly-github.test.ts > request_max_mode on a Slack-born task > behaves exactly as before: posts the approval prompt and pauses 3ms
 ✓ src/agents/__tests__/readonly-github.test.ts > handleEditModeApproval on a GitHub-born task > rejects: edit_allowed never set, no approver recorded, decision finding appended 0ms
 ✓ src/agents/__tests__/readonly-github.test.ts > handleEditModeApproval on a GitHub-born task > approves a Slack-born task exactly as before 1ms
 ✓ src/agents/__tests__/readonly-github.test.ts > POST /tasks/:id/approve edit_mode on a GitHub-born task > returns 403, leaves edit_allowed unset, and emits no approval:resolved 2ms
 ✓ src/agents/__tests__/readonly-github.test.ts > POST /tasks/:id/approve edit_mode on a GitHub-born task > still resolves edit_mode approval for a Slack-born task with ok + approval:resolved 1ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, 11/11.
- Cycle 2 addendum (@ `05fcf1a`): fresh re-run at the current commit; identical case set, 11/11, excerpt refreshed to the current raw log.
