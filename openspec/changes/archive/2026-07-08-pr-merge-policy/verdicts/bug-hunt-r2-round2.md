# Bug Hunt — R2 Round 2 (pr-merge-policy): fix verification

Scope: verify the three fixes from bug-hunt-r2.md landed in commits `1f9342b` (F1 branch-reuse reset) and `399f39e` (F2 don't-arm-dead-PR + F3 durable arm), plus one narrow fresh look at the fix surface. Verification: `npm run typecheck` (clean), `npx vitest run` on the two affected files (30 green on HEAD), two reverted mutation runs. Working tree left exactly as committed (only untracked verdict files present).

## Verdict: PASS

All three fixes are real and complete. The fresh look on `assignPrNumber`'s `merge_ready_notified` clear surfaces no regression to AC1 notify-once. No remaining or new findings.

---

## Finding 1 (fail-open, critical) — FIXED, complete

- **(a) Clears both markers before setting pr_number.** `assignPrNumber` (branch-state.ts:25-31) does `if (state.pr_number !== prNumber) { delete state.merge_armed; delete state.merge_ready_notified; }` then `state.pr_number = prNumber`. Both per-PR markers are cleared whenever the number changes.
- **(b) Used at every existing-BranchState assignment site; no bypass.** `grep -rn "\.pr_number\s*=" src | grep -v "=="` (non-test) returns exactly one assignment: `branch-state.ts:30`, inside `assignPrNumber`. `create_pull_request` routes through it (tools.ts:893). The only other write to a branch-state `pr_number` is the legacy migration (task.ts:1673-1677), which builds a **fresh object literal** for a branch that has no entry yet (`!attached.branch_states?.[currentBranch]`) — no prior `merge_armed`/`merge_ready_notified` can exist to inherit (both markers are only ever set after a `pr_number` is assigned, i.e. after a PR exists). No code path sets `<branchState>.pr_number = …` directly, bypassing the reset. The claim holds.
- **(c) Mutation confirmed.** Removing the two `delete` lines inside `assignPrNumber` → merge.test.ts F1 regression test "does NOT auto-merge a new PR that reuses a branch whose previous PR was armed" fails (`expected true to be undefined` at line 361). Reverted cleanly (`git checkout`).

## Finding 2 (arm a closed/merged PR) — FIXED, complete

`handleMergeApproval` now three-ways the status (task.ts:1334-1372): `open && clean` → merge-now; `open` (not clean) → arm (`armed = true`); **else (closed/merged)** → `finding = "Merge approval resolved but PR <ref> is <state> — nothing to merge"`, no arm. Both regression tests assert no arm: the "closed during the approval window" test asserts `armedFlag(task)` `toBeUndefined()` plus the explicit "is closed — nothing to merge" finding, slot cleared, and PM reactivation; the "merged during the approval window" test asserts `armedFlag(task)` `toBeUndefined()` and the "is merged — nothing to merge" finding. Both green.

## Finding 3 (durable arm persistence) — FIXED, complete

Arm path persists via `await this.save(true)` before the `sendMessage` PM reactivation (task.ts:1380-1388); every non-arm outcome keeps `debouncedSave()`. Test "arming persists durably (save(true)) before the PM reactivation" asserts `task.save` called with `true` AND `save.invocationCallOrder < sendMessage.invocationCallOrder`. Mutation confirmed: changing the arm branch to `this.debouncedSave()` → that test fails (`expected "vi.fn()" to be called with [ true ]`, 0 calls; line 181). Reverted cleanly.

---

## Fresh look — clearing `merge_ready_notified` inside `assignPrNumber` does NOT break AC1 notify-once

`assignPrNumber` fires from exactly one runtime site — `create_pull_request` (tools.ts:893; the only non-test caller, grep-verified). The merge orchestrator (`runMergeCheck`, merge.ts) reads branch state and manages `merge_ready_notified` via its own `notReady` bookkeeping (merge.ts:223-232) but **never** calls `assignPrNumber`. So the marker is only ever wiped by `assignPrNumber` at PR-creation time, never on a merge check.

- **Normal notify-once (number just assigned, then becomes ready):** create → `assignPrNumber(state, N)` (undefined→N, clears are no-ops); PR becomes ready → orchestrator notifies once and sets `merge_ready_notified`; subsequent merge checks see the marker and don't re-notify. `assignPrNumber` is not called between those checks, so the marker survives the ready period. Intact.
- **Long-lived PR whose number does NOT change:** `assignPrNumber` is never re-invoked for it (a new PR always mints a fresh GitHub number, and the guard `state.pr_number !== prNumber` would be false regardless), so its marker is never wiped mid-ready-period by this path. Intact.
- **Reset on first assignment (undefined→N):** the guard is true, but `merge_armed`/`merge_ready_notified` are necessarily still undefined at that point (both are only set after a `pr_number` exists), so the two `delete`s are no-ops. No spurious behavior.

The clear on genuine branch reuse (old PR closed unmerged, its close having routed to the task lifecycle rather than a merge check, leaving `merge_ready_notified` stale) is the intended fix — it subsumes round-1 Finding 3 so the reused PR re-notifies once for its own ready period.

---

## Verification log

- `npm run typecheck` — clean.
- `npx vitest run` (merge.test.ts + merge-approval.test.ts) — 30/30 green on HEAD.
- Mutation F1 (remove the clear in `assignPrNumber`) → 1 fail (branch-reuse regression). Reverted.
- Mutation F3 (arm path `save(true)` → `debouncedSave()`) → 1 fail (durable-arm test). Reverted.
- Post-revert re-run — 30/30 green.
- `git status` — tree matches HEAD (only untracked verdict files present).
