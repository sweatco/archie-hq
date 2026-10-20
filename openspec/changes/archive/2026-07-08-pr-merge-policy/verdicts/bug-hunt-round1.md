# Bug Hunt — Round 1 (pr-merge-policy)

Scope: `git diff main...HEAD -- ':(exclude)openspec/changes/pr-merge-policy'` on branch `forge/pr-merge-policy`, plus the companion docs diff in archie-plugins `merge-policy-docs`. Verification: full read of the diff and surrounding runtime code (task lifecycle, recovery, webhooks, Slack/API adapters), `npm run typecheck` (clean), full `npm test` (47 files / 680 tests, green), and three targeted mutation checks (all reverted; working tree left as found).

## Verdict: FINDINGS (1 confirmed logic/lifecycle bug, 1 confirmed test-theater gap, 2 plausible minor issues)

---

### Finding 1 — CONFIRMED: `merge_ready_notified` marker is set on a throwaway Task instance when the task is parked; the notify-once invariant (AC1) breaks in the primary production path

**Where:** `src/connectors/github/merge.ts:43-61` (`checkAndMergeLinkedPRs`), `:70-97` (`markNewlyNotifiableReadyPRs`), `:~365` (`notifyPMAboutReadyPRs`) — interacting with `src/tasks/task.ts:238-241` (`Task.get`) and `:1501-1519` (`debouncedSave`).

**Mechanism.** One webhook-triggered check calls `Task.get(taskId)` **three times** (once in `triggerMergeCheck`, once in `markNewlyNotifiableReadyPRs`, once in `notifyPMAboutReadyPRs`). `Task.get` returns the cached instance only for tasks in `activeTasks`; for an inactive task each call loads a **fresh instance from disk**. The canonical ready-notification scenario is exactly an inactive task: the task parked/completed while the PR waits for human review, then the approving-review webhook fires. Sequence:

1. `triggerMergeCheck` → instance **A** (fresh from disk).
2. `markNewlyNotifiableReadyPRs` → instance **B** (fresh). Marker set on B's branch states; `B.debouncedSave()` schedules a full-metadata write at T+500ms.
3. `notifyPMAboutReadyPRs` → instance **C** (fresh, loaded *before* B's write fires — **no marker**). `C.sendMessage(...)` → `activate()` → C becomes the canonical instance in `activeTasks` and the PM starts a turn.
4. C's in-memory metadata lacks the marker, and the now-busy task saves constantly (`updateAgentState`, `ackMessage`, turn bookkeeping all call `debouncedSave` on C). Whichever order B's and C's 500ms writes land in, every subsequent save from the live instance persists metadata **without** `merge_ready_notified`.
5. The next webhook for the same still-ready PR (push, green `workflow_run`, re-approval — or simply the next continuous burst after the 5s debounce window, `src/connectors/github/webhooks.ts:261`) re-runs the check, finds no marker, and **re-notifies the PM / the user thread**.

This directly violates the design's stated semantics ("Once-ness is enforced by a persisted `BranchState.merge_ready_notified` marker … webhook bursts and restarts never re-notify" — design.md Decision 4; docs/architecture/github-integration.md says the same). Secondary damage: instance B's delayed full-metadata write carries stale `status`/`agent_sessions` loaded from disk (e.g. `status: 'stopped'`) and can transiently clobber the freshly activated task's persisted state.

**Failing input:** any non-auto repo PR linked to a task that is not in `activeTasks` at merge-check time, receiving two ready-observing webhooks more than ~5s apart. The user gets the "PR is ready and will be merged on request" nudge at least twice per ready period.

**Why the tests miss it:** `src/connectors/github/__tests__/merge.test.ts` mocks `Task.get` to return the **same** fake object for every call ("holds a ready non-auto PR and notifies exactly once across a webhook burst", "does not re-notify after a task reload"). The single-instance assumption is precisely the thing that's false in production, so the webhook-burst and reload tests are structurally unable to catch this.

**Suggested fix:** resolve the Task once per `checkAndMergeLinkedPRs` run and pass the instance through (`triggerMergeCheck(task)`, `markNewlyNotifiableReadyPRs(task, …)`, `notifyPMAboutReadyPRs(task, …)`) — and either flush (`save(true)`) before the PM-activating `sendMessage`, or perform the marker write on the canonical instance after activation. Note `notifyPMAboutConflicts`/`notifyPMAboutMerge` have the same multi-`Task.get` shape pre-change but mutate nothing, so they were safe; the marker bookkeeping is what makes the pattern lossy.

---

### Finding 2 — CONFIRMED (test theater): the "supersede-during-resolution race" test does not exercise the atomic read-compare-clear gate

**Where:** `src/tasks/__tests__/merge-approval.test.ts:2151` ("supersede-during-resolution: a click for PR#1 after the slot moved to PR#2 merges neither") vs `src/tasks/task.ts:1284-1293` (`handleMergeApproval` gate).

**Mutation check performed:** moved `this.metadata.pending_merge_approval = undefined` from before the GitHub awaits to after them — i.e. destroyed exactly the "synchronous read-compare-clear, no await between the three steps" property the docstring and design.md Decision 7 promise. **All 11 tests in the file still pass** (verified by running `npx vitest run src/tasks/__tests__/merge-approval.test.ts` under the mutation; reverted afterwards). The test only pre-sets a mismatched slot and asserts `'stale'` — it is a plain identity-mismatch test, not a race test; nothing in the suite interleaves a slot rewrite with an in-flight resolution.

**Why it matters:** under the mutated (non-atomic) ordering, two resolutions whose identities both match the slot (approve double-click across Slack + API, or approve racing deny) both pass the compare before either clears — double merge attempt with duplicate findings, or a "merged" completion finding *and* a "denied" decision finding for the same request. The current code is correct, but the invariant the whole adapter design leans on ("Adapters do no verification of their own; this method is the single verification point") is held only by code ordering plus a comment. A test that stubs `getPRStatus` to rewrite/clear the slot mid-await and asserts single-resolution behavior would fail under the mutation.

---

### Finding 3 — PLAUSIBLE: marker never cleared for PRs observed `merged`, so a reused branch's next PR can be silently un-notified

**Where:** `src/connectors/github/merge.ts:176-180` — `notReady` covers `(open && !mergeable) || state === 'closed'` but not `state === 'merged'`.

A branch state whose PR merges (externally, by the orchestrator, or via approval) keeps `merge_ready_notified: true` forever. `findBranchStatesForPR` matches by `state.pr_number === prNumber`; if the same branch later carries a new PR (`create_pull_request` overwrites `pr_number` on the same `BranchState`), the stale marker suppresses the new PR's first ready notification (`states.some((s) => s.merge_ready_notified)` → skipped, and no ready observation ever clears it because the marker-clear also only fires for the *current* pr_number's not-ready states). Low likelihood (branch reuse after a merged PR within one task), silent-miss severity. Clearing the marker for `merged` states too — or clearing it when `pr_number` is overwritten — closes it.

---

### Finding 4 — PLAUSIBLE: API route discards the resolution disposition — a stale merge resolution returns `{ok: true}` and emits `approval:resolved`

**Where:** `src/connectors/api/routes.ts:280-292`.

`handleMergeApproval`/`handleMergeDenial` return `'resolved' | 'stale'` precisely so adapters can relay staleness (design.md: "a stale disposition returned so the calling adapter can update the prompt"); the Slack handlers use it, the API route ignores it: a mismatched/empty-slot resolution still gets `200 {ok: true}` **and** an `approval:resolved` event. Consequences: the debug MCP's `approve` tool reports "Approved merge for task …" for a no-op (an identity typo in an e2e run looks like success), and event-stream consumers (`wait_for_task`) see the merge gate as resolved while the pending slot — possibly for a different PR — is still armed. Suggest returning the disposition in the response body (e.g. `{ok: true, disposition}`) or a 409 on `'stale'`, and gating the `approval:resolved` emit on `'resolved'`.

---

## Checked and cleared

- **Registry policy lookup** (`src/agents/registry.ts:171-186`): zero-declaring-agent → false; AND semantics across agents and across duplicate entries; dynamic agents excluded from the registry so they neither confer nor consult auto-merge; mixed-flag warn. Casing is consistent because both merge paths source `github` from the same agent-def strings that feed the registry. Mutation of the caller-level vs task-level quiescence predicate in `tools.ts` (checked `agent.pendingTeardown` only) **is** caught by the `concurrent agent` test — that test is genuine.
- **Atomicity as shipped**: verified by reading `task.ts:1284-1293` and `:1345-1356` — no await between slot read, compare, and clear, in both handlers.
- **Restart/recovery**: the merge pause ends in `task.stop()` → `status: 'stopped'`, so `recoverActiveTasks` (in_progress only) never blind-recovers a task parked on merge approval — same contract as edit mode. A crash before the parked teardown runs leaves `in_progress` + slot; recovery re-wakes the repo agent and the supersede path (slot set, nobody parked) re-prompts with the same identity — old and new prompts both resolve correctly. `idleDecision` returns `'wait'` while the teardown is parked (recovery.ts:100), matching the tool's suppression predicate.
- **Persisted-state compat**: both new fields optional; pre-change metadata loads with them absent (correct default); JSON round-trip covered by real-file tests in `persistence.test.ts`.
- **Slack post failure during the approval request** (`tools.ts` merge tool): `postInteractiveToUser` throws → slot never set, no pause, no teardown — the task is not stuck and the agent can retry. Identical exposure to the existing edit-mode tool (only the research-budget path `.catch`es), with the minor cosmetic caveat that the "Merge approval requested for …" decision finding and the `approval:requested` event land before the failed post.
- **GitHub API throws in new paths**: tool path propagates to the tool result (agent-visible, retryable); `handleMergeApproval` wraps status/merge in try/catch and converts to a decision finding + PM reactivation (AC4); orchestrator path unchanged.
- **Debounced merge check during approval resolution**: worst case is one cosmetic duplicate ("ready" nudge for a PR that just merged) because the check fetched status pre-merge; the orchestrator can never merge a non-auto PR, and the marker/slot state converges.
- **API 400 test**: mutation "accept identity but ignore it" is caught by the AC8 convergence assertions (exact `expected` equality), and dropping the validation without dropping the branch routes garbage into the handlers, failing the no-call assertion.
- **Companion docs (archie-plugins `merge-policy-docs`)**: accurate — AND semantics, default-off, ready-notify-once PM guidance, and the CI-green path rewrite all match the implementation.

## Test/verification log

- `npm run typecheck` — clean.
- `npm test` — 47 files, 680 tests, all green on the unmodified branch.
- Mutation 1 (task.ts: slot clear moved after GitHub awaits) → `merge-approval.test.ts` **all green** → Finding 2. Reverted.
- Mutation 2 (merge.ts: `debouncedSave` removed from `markNewlyNotifiableReadyPRs`) → reload test fails → that specific mutation is covered. Reverted.
- Mutation 3 (tools.ts: quiescence predicate reduced to caller-level) → `pr-tools.test.ts` `concurrent agent` test fails → covered. Reverted.
- `git status` after all checks: working tree clean (no diff vs HEAD).
