# Stage 3 — Implement

**Purpose:** execute the plan task by task, then verify the diff with two blind reviewers.

**Inputs:** the plan artifacts (`tasks.md` is the contract). In `pr` mode with skipped stages: the reconstructed brief + the existing diff; write a minimal `tasks.md` for the remaining work first.

## Procedure

Implement `tasks.md` **sequentially**. Per task: make the change, run typecheck and the targeted tests for the touched area, flip the checkbox `- [ ]` → `- [x]`, commit. A crashed or resumed run restarts at the first unchecked task. Follow the repo's own conventions (`CLAUDE.md`, surrounding code style); new behavior gets new tests alongside it.

When all tasks are checked: run the full gate — `npm run typecheck`, `npm run build`, `npm test` — and fix anything red before review.

## Verification loop (2 reviewers, cap: 3 rounds)

Spawn both **concurrently**, fresh-context. Inputs: the plan artifacts and the diff (`git diff <base>...HEAD`) — never the implementer's reasoning or this conversation.

**Spec-compliance reviewer:**

> You check a diff against its plan. Inputs: plan artifacts (brief ACs, design, tasks) and the diff. Verify: every task's change is actually present; every code-level claim implied by the ACs is true in the diff; and — equally important — nothing in the diff goes BEYOND the plan (unrequested refactors, drive-by changes, scope creep are defects; the brief's non-goals are binding). Exception: files under `openspec/changes/<change>/` are Forge run state — ignore them entirely. Verdict: PASS or numbered findings, each blocking/non-blocking, each citing `file:line`.

**Adversarial bug hunter:**

> You hunt for real bugs in a diff. Inputs: the diff, read access to the repo, permission to run typecheck/tests. Look for: logic errors, unhandled error paths, races/lifecycle issues (spawn/stop/resume/recovery interactions are this codebase's classic failure mode), broken invariants in persisted state, and test theater. For each NEW test in the diff, mutation-check it: mentally (or actually) revert the fix it guards and confirm the test would fail; a test that passes either way is a finding. Classify each finding CONFIRMED (you can state the failing input/sequence) or PLAUSIBLE. Verdict: PASS or numbered findings with `file:line`.

Fix blocking findings, re-run the affected reviewer. Track `stage_rounds.implement`. Impasse after round 3 → user.

## Exit criteria

Clean typecheck/build/full suite; both reviewers PASS. Commit verdicts, set `stage: qa`.
