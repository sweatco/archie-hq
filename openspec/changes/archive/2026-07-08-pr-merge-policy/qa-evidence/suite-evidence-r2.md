# R2 QA evidence — auto-merge arming

Revision R2 repositioned the explicit merge path as auto-merge *arming* and fixed the CLI approval 400. This records how each affected AC was verified after R2.

## Live e2e session (booted from b541c9a, attested)

Instance booted from the branch tip and torn down clean (`Teardown clean: docker compose ps --all reports no containers for this project`). Both test PRs in `sweatco/archie-hq` closed, **neither merged** (#192 deny, #193 arm).

### Scenario A — `merge-approval-deny` (AC3) — VERIFIED
Full evidence pair: `qa-evidence/merge-approval-deny.json` (+ `.md`). Nonce `E2E-9c4bd221`, task `task-20260707-2111-xuh66c`, PR `sweatco/archie-hq#192`. Edit-mode task opened a real PR; merge requested; `wait_for_task` showed `STATE=approval_requested`, `APPROVAL_TYPE=merge`; denied via `approve(type:"merge", approve:false, github, pr_number)`; denial finding recorded; PR confirmed unmerged (`mergedAt: null`) and closed. Confirms: tool posts a merge approval of type `merge`; deny → no merge, no arm.

### Scenario B — `merge-approval-approve` / arm path (AC4, AC5, AC8) — OBSERVED (formal evidence file not captured)
Task `task-20260707-2118-g64957`, PR `sweatco/archie-hq#193`. Merge requested and approved via `approve(type:"merge", approve:true, github, pr_number)`. Observed live before the QA runner hit an unrelated API crash:
- The PR's `pr_card` showed `ci: passed (4/4)` yet `mergeStateStatus: BLOCKED` — i.e. blocked on a **required review**, not CI. This is exactly the class of the operator's reported case (a PR blocked on human review with checks not gating the merge).
- The `approval:requested` event carried `github` + `pr_number` (the R2 CLI/API identity fix).
- The approve call **succeeded with no 400**, and `approval:resolved {type: merge, approve: true}` was emitted — the merge-approval-400 regression is gone on the API path.
- The PR was **not** merged (arm path, correct: not `clean`). PR #193 remained open (armed) and was closed unmerged during cleanup.

The formal evidence pair for Scenario B was not written because the runner process crashed (server-side API error) after observing the above but before assembling the payload. The behavior it observed is the R2 arm path and is fully covered offline (below); a re-run can produce the file if desired.

## Offline coverage (unit/integration, mutation-checked, adversarially reviewed twice + re-hunt)

Full suite green: **700 tests / 48 files**; `npm run typecheck` + `npm run build` clean.

| AC | Test evidence |
|----|---------------|
| AC1 | `src/connectors/github/__tests__/merge.test.ts` — hold + notify-once across webhook burst; armed PR excluded from the ready notification; marker persistence; marker reset on branch reuse |
| AC3 | live Scenario A above; `src/agents/__tests__/pr-tools.test.ts` — non-auto open PR (incl. not-mergeable/blocked) still prompts + sets slot; closed/merged → no prompt |
| AC4 | `src/tasks/__tests__/merge-approval.test.ts` — approve+clean → merge-now; approve+not-clean → armed (`merge_armed` set, "Auto-merge armed" finding, no error, durable `save(true)`); closed/merged at click → no arm, "nothing to merge" finding |
| AC5 | `merge.test.ts` — armed PR merges only when `mergeableState==='clean'` (no approved floor); armed+blocked → NOT merged; `mergeability.test.ts` truth table (orchestrator auto bucket) |
| AC6 | `pr-tools.test.ts` — auto repo clean → direct merge, no prompt; auto repo non-clean → not-ready message |
| AC7 | `plugin-loader-frontmatter.test.ts` + `registry-auto-merge.test.ts` — default off everywhere |
| AC8 | `src/connectors/__tests__/merge-approval-surfaces.test.ts` — Slack + API converge on the same atomic Task methods with identity; `src/cli/__tests__/api.test.ts` — CLI `sendApproval` sends `github`+`pr_number` for `type:'merge'` (the 400 regression), omits for other types; live: API approve carried identity, no 400 |
| AC9 | deploy-only waiver (operator performs first real merge-on-request post-deploy) |

## Fail-open fix note (bug-hunt R2 Finding 1)
`assignPrNumber` (src/connectors/github/branch-state.ts) resets `merge_armed` + `merge_ready_notified` whenever a branch's `pr_number` changes, so a reused branch cannot inherit a stale arm and auto-merge an unapproved PR. Regression-tested in `merge.test.ts` and re-verified by an independent re-hunt (`verdicts/bug-hunt-r2-round2.md`).
