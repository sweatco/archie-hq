# Bug Hunt — Round 2 (pr-merge-policy)

Scope: verify the four fixes to round-1 findings (commits `5c46ac9`, `a866ddb`, `2c5ca07`, `3897c95`), then one fresh pass over the restructured surfaces only (`src/connectors/github/merge.ts`, `src/connectors/api/routes.ts` merge branch, `tools/debug-mcp/archie-client.ts` + `server.ts`). Fresh context. Verification: full read of the four commit diffs and the current files, two live reverted-code/mutation runs, caller greps for the changed contracts, `npm run typecheck` (clean), `npx vitest run` (47 files / 684 tests, green). Working tree left exactly as committed (only the pre-existing untracked round-1 verdict files present).

## Verdict: PASS (all four fixes real and pinned by tests; one narrow non-blocking residual noted)

---

## Fix verification

### Finding 1 (marker lost on parked tasks) — FIXED, empirically verified

`checkAndMergeLinkedPRs` (merge.ts:49-73) now resolves the Task exactly once and threads the instance through `runMergeCheck`, `markNewlyNotifiableReadyPRs` (now sync, pure bookkeeping), and all three notify helpers; the marker is flushed via `await task.save(true)` (merge.ts:69) strictly before the PM-activating `sendMessage`. `save(true)` is a direct `writeFile` (task.ts:1096-1100), and `sendMessage` routes onto the canonical instance under the activation lock (task.ts:292-294), so the flushed instance is the one that activates.

The multi-instance harness (`mockPersistedTask`, merge.test.ts:84-104) genuinely models production: every `Task.get` returns a fresh instance parsed from a persisted JSON string, only `save` writes back, `debouncedSave` is a lost write. Empirical check: reverted `merge.ts` to pre-fix (`git show 6752366:… > merge.ts`) and ran the suite — **3 tests fail** (webhook-burst notifies twice, reload test finds no persisted marker, plus the Finding-3 merged-marker test). Half-fix mutation (threaded instance kept, `save(true)` → `debouncedSave()`) — **2 tests fail** (the burst test's `save(true)` + call-order assertions pin the synchronous flush specifically). Both reverted cleanly; suite green on HEAD.

### Finding 2 (atomic gate untested) — FIXED, mutation re-performed

Re-ran the round-1 mutation myself: moved `this.metadata.pending_merge_approval = undefined` in `handleMergeApproval` (task.ts:1297) after the GitHub awaits. The new test ("supersede landing mid-await survives", merge-approval.test.ts:228) **fails under the mutation** — the superseding PR#2 slot gets wiped (`expected {…PR#2} received undefined`) — and passes on the real code. 11 other tests unaffected, confirming the new test is the one carrying the invariant. Reverted cleanly. The invariant is also now stated at the clear site (task.ts:1293-1296).

### Finding 3 (merged state never clears the marker) — FIXED

`notReady` is now simply `prStatuses.filter((pr) => !mergeable.includes(pr))` (merge.ts:198) — merged, closed, conflicted, and open-not-ready all drop the marker; `held` PRs are in `mergeable` so their markers survive. Regression test present (merge.test.ts:196-220): ready → marker set; merged → marker cleared; same BranchState re-pointed at PR#43 → notifies again. This test also failed on the pre-fix revert (part of the 3 failures above), so it is live.

### Finding 4 (API stale disposition discarded) — FIXED

routes.ts:280-294: the merge branch captures the disposition; `'stale'` → `409 {ok:false, stale:true, error}` and an early return **before** the shared `emitEvent('approval:resolved')` + `{ok:true}` tail (routes.ts:300-301) — nothing else lives below the return, so no shared handling is skipped. `'resolved'` falls through to the unchanged tail. Tests pin both paths, including the no-`approval:resolved`-on-stale assertion for approve and deny (merge-approval-surfaces.test.ts:213-235) and the resolved-path emit (:237-249). Debug MCP: `archie-client.ts:100-127` parses the 409 stale body into `{stale: true}` data (non-stale 409s and other errors still throw), and `server.ts:190-198` reports `STALE: … nothing was approved or denied` instead of a fake "Approved".

## Fresh pass over the restructured surfaces

- **`triggerMergeCheck` wrapper contract**: identical signature/return (`(taskId) => Promise<MergeCheckResult>`), body is `runMergeCheck(await Task.get(taskId))`. Grep across `src/` and `tools/`: **no external callers** on this branch — nor on `main` (only `checkAndMergeLinkedPRs` in webhooks.ts:281 and docs reference it). Contract trivially preserved.
- **Marker-clear path still on `debouncedSave`** (merge.ts:208-210): safe — when the run also notifies, it is the same instance so the clear rides the `save(true)`/activated-instance saves; when nothing activates, the deferred write lands uncontended; a crash inside the 500ms window is self-healing (the next not-ready observation clears again).
- **`save(true)` from a fresh instance**: `agentProcesses` is empty on a fresh instance, so the session-sync loop is a no-op and disk `agent_sessions` are preserved; only `updated_at` is bumped. No state clobber on the inactive path.
- **routes.ts early return**: skips only the emit + ok-json (intentional); edit_mode/research_budget branches unreached by the 409 and still hit the shared tail; try/catch still wraps everything.
- **archie-client / e2e harness compatibility**: `client.approve` has exactly one caller (server.ts:190). edit_mode / research_budget calls return `{stale:false}` on any 2xx — the route can only 409 on `type === 'merge'` — so the SKILL.md edit-mode flow (`approve(type: "edit_mode", …)`) and the merge-deny recipe (step 7, correct `github`/`pr_number` → `'resolved'` → event emitted, satisfying the step-9 evidence expectations) are unaffected. `wait_for_task` behavior on stale is correct: the slot stays armed, so it keeps reporting `approval_requested` rather than falsely settling.

## Findings

### Finding R2-1 — PLAUSIBLE, non-blocking: cross-trigger races can still drop the marker; worst case one duplicate ready nudge

**Where:** `src/connectors/github/merge.ts:49-73` + `src/connectors/github/webhooks.ts:269-285`.

The fix closes the deterministic single-run loss (round-1 Finding 1) but two narrow cross-trigger windows remain, inherent to lockless file-based state: (a) the webhook debounce is trailing-edge and deletes the timer before running the check, so a webhook landing mid-run schedules a second run 5s later — if the first run's GitHub fetches take >~6s (serial `getPRStatus` per PR, merge.ts:327-338), the second run's `Task.get` loads pre-flush metadata, sees no marker, and notifies again; (b) an independent activation (e.g. a user Slack message) that loads and registers a canonical instance during the first run's awaits means the marker is flushed from a non-canonical instance and the canonical instance's subsequent saves persist metadata without it. Both need tight timing, both converge (markers re-flush on the next check), and the damage is one duplicate "PR is ready" nudge — the cosmetic tail of the original bug, not the deterministic re-notify-every-webhook behavior. Round 1 cleared the same concurrency class for the non-mutating notify paths; fixing this properly means per-task serialization of merge checks or read-modify-write on the canonical instance post-activation. Not worth blocking this change.

## Test/verification log

- Pre-fix revert of merge.ts (6752366) → 3/7 merge.test.ts tests fail (burst, reload, merged-marker). Restored; 7/7 green.
- Half-fix mutation (`save(true)` → `debouncedSave()`) → 2/7 fail (synchronous-flush assertions). Restored; green.
- Finding-2 mutation (slot clear moved after awaits in `handleMergeApproval`) → exactly the new supersede-mid-await test fails (1/12). Restored; 12/12 green.
- `npm run typecheck` — clean.
- `npx vitest run` — 47 files, 684 tests, all green (680 in round 1 + 4 net new: multi-instance burst rewrite, merged-marker clear, supersede-mid-await, API stale/resolved pair).
- `git status` — tree matches HEAD; only the pre-existing untracked round-1 verdict files present.
