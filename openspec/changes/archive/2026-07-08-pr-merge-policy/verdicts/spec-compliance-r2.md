# Spec-compliance verdict — pr-merge-policy R2

**Verdict: PASS** (one non-blocking finding)

Scope checked: `git diff e20aaae..HEAD` (commits 9313aa4, c3a98a1, e331612, 89d94bf). Plan: `design.md` "## Revision R2" section + `forge.yaml` AC1/AC3/AC4/AC5/AC6/AC8. All 11 changed files are product/test source; no unrelated files touched. `npx vitest run` over the five affected test files: 70/70 pass.

## Requirement-by-requirement (R2 checklist)

**BranchState.merge_armed added** — PASS. `src/types/task.ts:171-179`: optional `merge_armed?: boolean` with a doc comment matching the reframe (armed on approval-of-non-clean, cleared on merged/closed).

**Tool non-auto branch** — PASS.
- Readiness gate removed: the `isMergeReadyPerGithub` refusal that preceded the prompt is deleted (`src/agents/tools.ts:1503-1510`); it now prompts for any open PR and bails only on non-open (`tools.ts:1508`).
- Auto branch gates on `mergeableState === 'clean'` (no blocked tolerance): `src/agents/tools.ts:1476`.
- `isMergeReadyPerGithub` no longer imported in tools.ts: import removed (diff at `tools.ts` top; grep confirms zero references in `tools.ts`).

**handleMergeApproval** — PASS.
- Atomic identity gate unchanged: synchronous read-compare-clear with clear-before-awaits, `src/tasks/task.ts:1299-1312`.
- Clean → merge now: `task.ts:1330-1339`.
- Not-clean → set `merge_armed` on every matching BranchState + "Auto-merge armed … will merge once checks pass" `decision` finding, no error: `task.ts:1340-1360`.
- No `approved` check anywhere; no `isMergeReadyPerGithub` (gates on `status.mergeableState === 'clean'`, `task.ts:1330`); `isMergeReadyPerGithub` import removed from task.ts.
- No orchestrator import / no circular dep: the `repositories → branch_states` arming walk is inlined (`task.ts:1349-1357`) rather than calling `checkAndMergeLinkedPRs`. This diverges from the R2 *Mechanic* bullet's "trigger checkAndMergeLinkedPRs once" wording but exactly matches the parent verification directive ("clean → merge now … no orchestrator import (no circular dep)") and is behaviorally equivalent for AC4/AC5. Correct call.

**Orchestrator** — PASS.
- Armed bucket = `state==='open' && mergeableState==='clean' && findBranchStatesForPR(...).some(s => s.merge_armed)`; no `approved`, no `blocked` tolerance, independent of repo policy: `src/connectors/github/merge.ts:198-203`.
- `toMerge = autoMergeable ∪ armed`, deduped by reference: `merge.ts:207-210`; merge loop iterates `toMerge`: `merge.ts:306`.
- Ready-notification excludes armed: `held = mergeable.filter(!autoMergeable && !armed)`, `merge.ts:215`.
- `merge_armed` cleared on merged/closed only (stays armed while open-but-not-clean): `merge.ts:238-248`.
- Auto/`mergeable` bucket unchanged (`approved && isMergeReadyPerGithub`): `merge.ts:171-176`; `isMergeReadyPerGithub` is now used *only* there (grep-confirmed), matching the design's "Consequences" claim, with its doc comment rewritten to say so (`mergeability.ts:1-15`).

**CLI** — PASS.
- `approval:requested` carries `github`/`pr_number` for merge (omitted otherwise): `src/tasks/task.ts:591-598` (new `context` param on `postInteractiveToUser`, threaded from `tools.ts:1544-1550`).
- `sendApproval` sends identity for merge, spread-guarded for others: `src/cli/api.ts:64-83`.
- `TaskDetail` captures `event.data.github`/`pr_number` and forwards via `mergeIdentity(...)`: `src/cli/components/TaskDetail.tsx:80-86, 199-205, 391-395`.
- Type unions widened: `api.ts:66`, `TaskDetail.tsx:131` (and both approval-object literals).

## AC-level truth

- **AC1** (armed excluded from notify) — PASS. `merge.ts:215` + test "excludes an armed PR from the ready notification even when clean+approved (AC1)".
- **AC3** (prompt for any open PR incl. non-mergeable; deny → no merge/arm) — PASS. Prompt path `tools.ts:1503-1566`; test "non-auto blocked PR: still prompts + sets the slot, no refusal". Deny (`handleMergeDenial`, `task.ts:1380-1398`) makes no GitHub call and sets no marker.
- **AC4** (clean→merge-now; else arm; no error) — PASS. `task.ts:1330-1360`; tests "arms a not-clean PR …" and "arms a dirty PR too …". See finding 1 for the closed-PR sub-case.
- **AC5** (armed merges when clean, no approved floor; blocked armed NOT merged) — PASS. `merge.ts:198-203`; tests "merges an armed non-auto PR reported clean, with no approved floor (AC5)" and "does NOT merge an armed PR that is blocked+mergeable".
- **AC6** (auto clean→direct; non-clean→not-ready) — PASS. `tools.ts:1469-1481`; test flipped to "does not merge a blocked+mergeable PR in an auto repo — clean-only gate (AC6)".
- **AC8** (all three surfaces carry identity, resolve through same atomic methods) — PASS. Slack `parseMergeButtonValue` → `handleMergeApproval(approver, expected)` (`events.ts:365-421`); API 400-guards `github`+`pr_number` → `handleMergeApproval(cleanApprover, mergeExpected)` (`routes.ts:242-283`); CLI regression fixed per above. New `src/cli/__tests__/api.test.ts` pins the CLI body contract.

## Scope / non-goals

No scope creep. All changes are the R2 reframe (arm-instead-of-gate) plus the orthogonal CLI-identity defect fix that R2 explicitly folds in. Non-goals intact: no `autoMerge: true` set for any repo, no approval counting / merge-method override / channel permissions, no webhook/debounce changes. R1-scoped surfaces (Slack handlers, API route, debug MCP, docs) are not re-touched — correct, they are not R2 requirements.

## Findings

### 1. [NON-BLOCKING] Closed-PR-at-approval is armed with a misleading "will merge once checks pass" finding — `src/tasks/task.ts:1340-1360`

`handleMergeApproval` branches only on `state === 'open' && mergeableState === 'clean'`. A PR that was open at request time but closed/merged during the park (narrow race — the request-time gate at `tools.ts:1508` bails on non-open, so this is the only entry) falls into the `else` and is (a) marked `merge_armed = true` on its BranchState and (b) reported to the PM as `Auto-merge armed for <ref> — will merge once checks pass`.

Judgment — **acceptable, not a defect, but worth a one-line hardening:**
- *Per AC4:* literally compliant — AC4 is a strict binary ("if clean … it merges immediately … otherwise the PR is armed"), and closed is "otherwise". The implementer flagged this; the test "does not merge a closed PR; arms it (harmlessly …)" documents it deliberately.
- *Dangling marker:* self-healing and harmless. The orchestrator's armed bucket requires `state === 'open'` (`merge.ts:200`), so a closed PR can never be merged by the stale arm; and the leftOpen loop (`merge.ts:238-248`) deletes `merge_armed` on the next merge check that observes the closed/merged state. No wrong merge is reachable.
- *Misleads the user:* yes, mildly — the PM would relay "I'll merge it once checks pass" for a PR that is closed and will not merge. Pre-R2 reported `state=closed` explicitly; R2 loses that clarity in this one race window.

Recommendation (optional, non-blocking): gate the merge-now/arm split on `state === 'open'` and keep an explicit closed/merged decision finding for the non-open case, restoring pre-R2 clarity without affecting AC4's clean/arm behavior. Left as-is is defensible given the harmlessness and the narrowness of the window.
