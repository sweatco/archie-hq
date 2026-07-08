# Bug Hunt — R2 (pr-merge-policy, auto-merge arming)

Scope: `git diff e20aaae..HEAD` — commits 9313aa4 (armed bucket in orchestrator), c3a98a1 (tool prompts for any open PR), e331612 (task arming), 89d94bf (CLI PR identity). Expected behavior: design.md "## Revision R2". Fresh context: full read of the diff plus the surrounding runtime (webhook routing, Task lifecycle/persistence, `create_pull_request`, the round-1/round-2 verdicts). Verification: `npm run typecheck` (clean), `npx vitest run` on the four touched test files (63 green), five reverted mutation runs. Working tree left exactly as committed.

## Verdict: FINDINGS — 2 CONFIRMED, 1 PLAUSIBLE (all in the arming lifecycle); dedup / atomic gate / CLI identity / clean-only gates all verified correct

---

### Finding 1 — CONFIRMED: a stale `merge_armed` survives branch reuse and auto-merges a PR the user never approved

**Where:** `src/connectors/github/merge.ts:234-248` (the only clearer of `merge_armed`) + `src/connectors/github/webhooks.ts:382-384` (routing) + `src/agents/tools.ts:890-891` (`create_pull_request` overwrites `pr_number` on the same BranchState).

**Mechanism.** `merge_armed` is cleared in exactly one place — the `leftOpen` loop inside `runMergeCheck`, which fires only when a **merge-check-routed** webhook observes the PR `merged`/`closed`. But a `pull_request` `closed` (merged or unmerged) event routes to `existing_task`, **not** `merge_check` (`determineRouteAction`, webhooks.ts:383: `if (action === 'closed') return 'existing_task'`). So the close event itself never clears the arm. `create_pull_request` (tools.ts:890-891) then reuses the same BranchState object for the branch and overwrites only `pr_number`, leaving `merge_armed` intact. `findBranchStatesForPR` matches purely on `state.pr_number === prNumber`, so the new PR inherits the stale arm and the armed bucket (`state==='open' && mergeableState==='clean' && merge_armed`, with no `approved` floor by AC5) merges it automatically.

**Confirmed failing sequence** (all steps code-verified; branch is *not* deleted on a non-merge close, so it survives for reuse):
1. Repo agent opens PR#1 on branch `B = <prefix>/<taskId>`.
2. PR#1 is open-but-not-clean; user approves the merge request → `handleMergeApproval` arms it (`branch_states[B].merge_armed = true`, `pr_number=1`). No merge.
3. PR#1 is closed without merging (user closes it, or the agent calls `close_pull_request` to redo the work — verified it does not clear the marker either). The `pull_request closed` webhook routes to `existing_task`; **`merge_armed` is not cleared**.
4. Agent opens PR#2 from the same branch `B` → `create_pull_request` sets `branch_states[B].pr_number = 2`; `merge_armed` is still `true`.
5. PR#2 reaches `mergeableState==='clean'`; any merge-check webhook (workflow_run success / push / a review approval) runs `runMergeCheck` → PR#2 is `open + clean + merge_armed` → the orchestrator merges PR#2 **with no user approval for PR#2**.

This is the dangerous analog of round-1 Finding 3 (stale `merge_ready_notified` on branch reuse): same structure, but the failure mode flips from a *missed notification* (fail-safe) to an *unsupervised merge* (fail-open) — the exact property the whole change exists to prevent. The clear-on-merged/closed loop was written to prevent this (its comment says so, merge.ts:234-236) but is defeated by the routing: the most direct signal (the close/merge webhook) does not trigger the check that clears. Likelihood is low (requires within-task branch reuse after arming), severity is high (violates the default-off/human-gated invariant). Suggested fix: clear `merge_armed` (and `merge_ready_notified`) in `create_pull_request` when `pr_number` is overwritten, and/or route `pull_request closed` through a merge check so the clear fires on the authoritative close signal.

---

### Finding 2 — CONFIRMED (minor, and widens Finding 1): `handleMergeApproval` arms even when the PR is already closed/merged, emitting a misleading "will merge once checks pass" finding

**Where:** `src/tasks/task.ts:1340-1359` — the `else` branch that sets `merge_armed = true` is unconditional; it covers every non-`(open && clean)` status including `state==='closed'` and `state==='merged'`.

**Mechanism.** The tool bails on non-open PRs at *request* time (tools.ts:1508), but a PR can be closed during the approval window (between the prompt and the click). On approval, `getPRStatus` returns `state==='closed'`, the `if (open && clean)` fails, and the `else` arms the (dead) PR and appends `Auto-merge armed for <pr> — will merge once checks pass` (a `decision` finding the PM relays to the user). Consequences: (a) the user is told a closed PR is "armed, will merge once checks pass" — it never will (AC4 says the user should learn the *real* outcome); (b) it seeds a stale `merge_armed` on the branch state, directly feeding Finding 1. The existing test "does not merge a closed PR; arms it (harmlessly…)" (merge-approval.test.ts) actually *encodes* this behavior and calls it harmless, relying on the close-clear that Finding 1 shows does not fire from the close event. Suggested fix: arm only when `status.state === 'open'`; for closed/merged, record an accurate "not merged (PR is <state>)" finding and do not arm.

---

### Finding 3 — PLAUSIBLE (low, = accepted R2-1 class): arming persists via `debouncedSave()` only; the narrow cross-instance race drops the arm silently, and no test guards persistence

**Where:** `src/tasks/task.ts:1368` (`this.debouncedSave()` after arming) + `src/tasks/__tests__/merge-approval.test.ts` (single mocked instance, no-op `debouncedSave`).

**Analysis.** Unlike the round-1 marker bug, arming is **not** subject to the deterministic lost-write race. `handleMergeApproval` runs on the single instance the adapter loaded via `Task.get`; it arms in-memory and then `sendMessage` resolves `activeTasks.get(taskId) ?? this` — in the common parked-task case `this` has no active entry, so `this` becomes canonical (`activate()`), the arming lives on the canonical instance, and the eventual `task.stop()` → `save(true)` flushes it durably. A later webhook's `Task.get` returns that same canonical instance. So the common path is durable. The only residual loss is the R2-1 lockless window: if an independent trigger registers a *different* canonical instance between the adapter's `Task.get` and the `sendMessage`, the arm lands on a non-canonical instance and the 500 ms `debouncedSave` races it away. Same tiny probability as the accepted R2-1 duplicate-nudge, but the failure mode is worse: the armed PR **never auto-merges** and the user was told it would. 

**Test-coverage gap (flagged per the mandate):** the arming tests assert only the *in-memory* `merge_armed` flag against a fake task whose `debouncedSave` is a no-op mock; none assert durable persistence or `save(true)`. **Mutation E** (removed the arming `this.debouncedSave()` entirely) → all 15 merge-approval tests still pass. So a persistence regression (or the durability race) is invisible to the suite. This is a coverage gap, not itself a shipped bug, given the stop-flush makes the common path durable.

---

## Checked and cleared

- **`toMerge` dedup is real reference-equality (no double-merge).** `autoMergeable = mergeable.filter(...)`, `mergeable = prStatuses.filter(...)`, and `armed = prStatuses.filter(...)` all hold the *same* object references from `prStatuses`; `toMerge.includes(pr)` (SameValueZero) therefore dedupes a PR that is both auto and armed to a single merge. An armed PR in an auto repo that is clean+approved appears once. (merge.ts:188,198,207-210)
- **Armed bucket `clean`-only is safe and pinned.** GitHub `mergeableState==='clean'` means all required reviews + checks satisfied, no conflicts (a pending required review reports `blocked`, not `clean`), so no `approved` floor is needed. **Mutation A** (armed filter → `isMergeReadyPerGithub`, i.e. tolerate `blocked+mergeable`) → the "does NOT merge an armed PR that is blocked+mergeable" test fails. Genuine.
- **Armed PRs excluded from ready-notification without breaking AC1 for non-armed PRs.** `held = mergeable.filter(pr => !autoMergeable.includes(pr) && !armed.includes(pr))` uses reference equality on the shared array; `result.ready = held`, and `merge_ready_notified` bookkeeping runs only over `held`. Armed PRs never enter the notify path; non-armed held PRs are unaffected. Pinned by the "excludes an armed PR from the ready notification even when clean+approved (AC1)" test.
- **`merge_armed` cleared on both merged and closed (when a merge check runs).** **Mutation C** (disabled the `leftOpen` clear loop) → both "clears merge_armed when observed merged/closed" tests fail. The clear is genuine — its limitation (never firing from the close/merge webhook) is Finding 1, not a missing clear.
- **Atomic identity gate intact.** `handleMergeApproval` reads the slot, compares to `expected`, and clears it (task.ts:1299-1312) with no `await` between the three steps; the GitHub fetch/merge/arm all happen after the clear. Unchanged by R2; round-2's supersede-mid-await test still guards it.
- **CLI identity plumbing correct.** `mergeIdentity` (TaskDetail.tsx) returns `{github, pr_number}` only for `approvalType==='merge'` with both fields present, `undefined` for edit_mode/research_budget → the spread omits them → no 400, no wrong body. `postInteractiveToUser` emits `github`/`pr_number` only for merge (task.ts:588-599). **Mutation B** (dropped the identity spread in `sendApproval`) → both merge-body tests fail. `emitEvent`-identity and `sendApproval` tests are genuine. Widened unions typecheck clean.
- **API route contract matches the CLI payload.** `type==='merge'` requires `github`+`pr_number` (routes.ts:242-247, 400 otherwise) and threads `mergeExpected` into the Task method; stale → 409 with no `approval:resolved`. Consistent with the CLI now sending them.
- **Request-time slot durability.** The tool sets the slot, `debouncedSave()`, then `deferTeardown(() => task.stop())`; the turn-end stop → `save(true)` flushes the slot before the task parks, so a later click/webhook sees it. (tools.ts:1552-1565)

## Test/verification log

- `npm run typecheck` — clean.
- `npx vitest run` (4 touched files) — 63/63 green on HEAD.
- Mutation A (merge.ts armed filter → `isMergeReadyPerGithub`) → 1 fail (blocked+mergeable armed test). Reverted.
- Mutation B (cli/api.ts drop identity spread) → 2 fails (merge body/denial tests). Reverted.
- Mutation C (merge.ts disable `leftOpen` clear) → 2 fails (clears-on-merged/closed tests). Reverted.
- Mutation D (task.ts arming loop no-op) → 3 fails (all three arm tests). Reverted.
- Mutation E (task.ts remove arming `debouncedSave()`) → 0 fails / 15 green → Finding 3 coverage gap. Reverted.
- `git status` after all checks: tree matches HEAD (only pre-existing untracked verdict files present).
