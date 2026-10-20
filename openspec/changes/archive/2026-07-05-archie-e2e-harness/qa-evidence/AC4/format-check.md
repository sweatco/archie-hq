# AC4 format check — evidence files vs the documented format

**Authored by the QA runner** (this file is a judgment record, not harness output; every scenario evidence file it judges *was* produced by the harness writer). 2026-07-04, branch `forge/archie-e2e-harness` @ `1cb2497`.

## 1. Writer-produced files conform to `archie-e2e-evidence/v1`

All five evidence pairs in this qa-evidence tree were written by `npx tsx tools/e2e/evidence.ts --out-dir <AC-dir>` (never hand-authored). A field-by-field mechanical check against the schema table in SKILL.md §3 (schema tag, kebab-case scenario naming the files, non-empty ac_ids, ISO-8601 bounds, environment triple, nonce, task_id, terminal_state enum, non-empty assertions with all-string fields + boolean pass, excerpts arrays, result equal to AND of assertion passes, md companion present):

| File | Result |
|---|---|
| AC1/boot-healthy.json | OK |
| AC1/boot-broken.json | OK |
| AC2/basic-nonce.json | OK |
| AC3/edit-mode-approval.json | OK |
| AC6/teardown-clean.json | OK |

Each `.md` companion renders the documented shape: metadata header, assertion table, fenced knowledge-log and events excerpts, verdict line.

## 2. Sufficiency for an independent reviewer

Judged blind (implementation unread): **AC2's `basic-nonce.md` and AC3's `edit-mode-approval.md` are individually sufficient** to rule pass/fail. Each carries the exact task id, nonce, branch/commit, per-assertion expected-vs-observed strings, and the verbatim event stream (`task:created` → … → `task:completed`, including `approval:requested {approvalType: edit_mode}` / `approval:resolved {approve: true}` in AC3) plus the knowledge-log lines the assertions cite. A reviewer needs nothing outside the file.

## 3. Negative controls (writer rejects bad payloads, writes nothing)

Run against a scratch out-dir; directory confirmed empty after each:

| Input | Output | Exit | Files |
|---|---|---|---|
| Valid shape but `assertions: []` | `evidence payload failed validation:` + `- assertions must be a non-empty array` | 1 | none |
| JSON cut mid-object | `truncated JSON input from stdin: Expected ',' or '}' …` | 1 | none |
| Non-JSON text | `invalid JSON from stdin: Unexpected token 'o', …` | 1 | none |

The error classes match SKILL.md §3's documented strings verbatim.

## 4. Findings (non-blocking)

1. **Schema is task-scenario-shaped.** `nonce`, `task_id`, and `terminal_state` are required, so the AC1 (boot) and AC6 (teardown) evidence — which the verification plan also routes through the writer — must fill them with explicit `"n/a (… lifecycle step — no task)"` placeholders and `terminal_state: "not_found"`. The validator accepts this and the files remain honest and readable, but the schema doesn't natively model non-task lifecycle evidence. Worth a note in SKILL.md or a v2 relaxation.
2. **Filename convention vs plan.** The writer names files `<scenario>.{json,md}` (`basic-nonce.json`), while the verification plan's evidence column says `scenario-basic.{json,md}` / `boot-healthy.{json,md}`. SKILL.md (the operator doc) wins; only the AC2/AC3 names differ from the plan's spelling. Cosmetic.
3. **`APPROVAL_TYPE` line absent** from `wait_for_task` output at approval_requested (see AC3 notes); the edit_mode type is only visible via `get_events`. Doc/output mismatch, minor.

## Verdict: PASS
