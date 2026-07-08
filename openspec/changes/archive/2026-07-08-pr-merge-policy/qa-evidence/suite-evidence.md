# Suite evidence: pr-merge-policy (AC1, AC2, AC4–AC8) + AC9 waiver

Black-box QA run, 2026-07-06. Branch `forge/pr-merge-policy` @ `1cf34ce` (clean tree). Each AC below maps to the test file(s) named in `verification-plan.md`; the named cases were confirmed present by running `npx vitest run <file> --reporter=verbose` and matching case names in the output. No implementation source was read.

## AC1 — non-auto hold + exactly-one ready notification — PASS

File: `src/connectors/github/__tests__/merge.test.ts` (suite `checkAndMergeLinkedPRs — non-auto policy (AC1)`)

- `holds a ready non-auto PR and notifies exactly once across a webhook burst, with each Task.get loading a fresh instance` — pass (webhook-burst once-ness)
- `suppresses the ready nudge for a PR whose merge approval is pending` — pass (no double nudge companion)
- `notifies again after the PR goes un-ready and becomes ready once more (marker cleared)` — pass (marker clear/re-notify companion)
- `clears the marker when the PR is observed merged, so a new PR reusing the branch is notified` — pass
- `does not re-notify after a task reload — the marker reaches the persisted metadata` — pass (persistence companion)

Vitest summary (run with `mergeability.test.ts`): `Test Files  2 passed (2)` / `Tests  13 passed (13)`.

## AC2 — autoMerge: true preserves squash-merge — PASS

File: `src/connectors/github/__tests__/merge.test.ts` (suites `— auto policy (AC2)` and `— mixed-policy task`)

- `merges a ready PR in an auto repo as today, with no ready notification` — pass
- `merges the auto PR while the non-auto PR is held with a ready notification` — pass (mixed-policy case from the plan)

Vitest summary: same run as AC1 — `Tests  13 passed (13)`.

## AC4 — approve → merge if mergeable, else report why — PASS

Files: `src/tasks/__tests__/merge-approval.test.ts`, `src/agents/__tests__/pr-tools.test.ts`

- (a) `merges, appends a completion finding, and reactivates the PM when ready (AC4)` — pass
- (b) `does not merge a dirty PR; appends the reason and reactivates the PM (AC4)` — pass; `does not merge a closed PR; appends the reason (AC4)` — pass
- (c) `reports a merge-API failure ({success: false}) as a decision finding (AC4)` — pass; `reports a thrown merge error as a decision finding, slot cleared, PM reactivated (AC4)` — pass
- (d) atomicity/race: `supersede-during-resolution: a click for PR#1 after the slot moved to PR#2 merges neither` — pass; `supersede landing mid-await survives: the slot is cleared before any await, so PR#2 written during resolution is never wiped` — pass; denial mismatch: `handleMergeDenial > mismatched identity leaves the superseding slot untouched` — pass
- Tool-side pre-check companion (pr-tools): `non-auto not-ready: returns the not-ready text without prompting` — pass

Vitest summary (both files together): `Test Files  2 passed (2)` / `Tests  43 passed (43)`.

## AC5 — no Archie-side approval floor — PASS

Files: `src/agents/__tests__/pr-tools.test.ts`, `src/tasks/__tests__/merge-approval.test.ts`, `src/connectors/github/__tests__/mergeability.test.ts`

- (a) `merge_pull_request — policy gating > zero review approvals but clean: approval is requested, not refused (AC5)` — pass
- (b) `handleMergeApproval > merges with zero review approvals when GitHub reports clean — no approved floor (AC5)` — pass
- Truth table (`isMergeReadyPerGithub`): `clean + mergeable=true → ready`, `clean + mergeable=false → ready (clean alone suffices)`, `blocked + mergeable=true → ready (Rulesets quirk tolerance)`, `blocked + mergeable=false → not ready`, `dirty → not ready`, `unstable → not ready` — all pass; no case consults review approvals.

Vitest summaries: `Tests  13 passed (13)` (merge+mergeability run) and `Tests  43 passed (43)` (merge-approval+pr-tools run).

## AC6 — autoMerge repo merges directly, no prompt — PASS

File: `src/agents/__tests__/pr-tools.test.ts`

- `merge_pull_request — policy gating > auto repo: merges directly with no approval request and no pause (AC6)` — pass
- Aligned condition: `merge_pull_request > merges when blocked but mergeable=true (aligned to orchestrator Rulesets tolerance)` — pass

Vitest summary: `Tests  43 passed (43)` (same run as AC4).

## AC7 — default off everywhere with no frontmatter changes — PASS

Files: `src/system/__tests__/plugin-loader-frontmatter.test.ts`, `src/agents/__tests__/registry-auto-merge.test.ts`

Deviation note: the plan names `src/system/__tests__/plugin-loader.test.ts`; the autoMerge frontmatter cases actually live in the sibling `plugin-loader-frontmatter.test.ts` (plugin-loader.test.ts covers only `loadMcpJson`). The registry/policy tests the plan points at under `src/agents/__tests__/` are in `registry-auto-merge.test.ts`. All named behaviors are covered:

- Frontmatter parsing: `parses autoMerge: true on a plural repos entry`, `defaults autoMerge to false when absent`, `fails safe to false on a string "true"`, `fails safe to false on a numeric 1`, `migrates autoMerge from the legacy singular repo shape`, `legacy singular shape without autoMerge defaults to false` — all pass
- Registry copy default: `scanAgentDefs — RepoEntry.autoMerge resolution > defaults to false when the plugin entry omits autoMerge`, `carries autoMerge: true through the registry copy` — pass
- `isAutoMergeRepo`: `is false for a repo no registered agent declares`, `is true when the single declaring agent sets autoMerge: true`, `is false when the single declaring agent leaves autoMerge off`, `is true when two declaring agents both set true`, `is false with a warn when two declaring agents disagree`, `is false when one agent declares the repo twice with mixed entries` — pass (not-unanimous → false)
- Dynamic agents: `synthesizeDynamicAgentDef — autoMerge > is always false for PM-spawned dynamic agents` — pass

Environmental corroboration from the live run: no agent frontmatter in the booted workdir sets `autoMerge`, and the live scenario's `merge_pull_request` on `sweatco/archie-plugins` (Archie's own plugins repo) gated instead of merging.

Vitest summary (frontmatter file, run with wait-for-task.test.ts): `Test Files  2 passed (2)` / `Tests  20 passed (20)`. Registry file (run with plugin-loader.test.ts and surfaces test): `Test Files  3 passed (3)` / `Tests  21 passed (21)`.

## AC8 — Slack buttons and API route resolve identically — PASS

File: `src/connectors/__tests__/merge-approval-surfaces.test.ts`

Deviation note: the plan names `src/connectors/slack/__tests__/merge-approval-actions.test.ts` "(or co-located events test)"; the actual file is the co-located `src/connectors/__tests__/merge-approval-surfaces.test.ts`, which covers both surfaces in one suite (`merge approval — Slack button and API route resolve identically (AC8)`):

- `approve: both surfaces call the same handleMergeApproval with the same parsed identity` — pass
- `deny: both surfaces call the same handleMergeDenial with the same parsed identity` — pass
- `mismatched button value: stale disposition, no merge, message updated with the stale notice` — pass (Slack stale companion)
- `API stale merge resolution: 409 {ok:false, stale:true} and no approval:resolved event` — pass
- `API resolved merge approval emits approval:resolved and returns ok` — pass
- `external approver still resolves the approval with identity omitted` — pass
- `API merge request without github/pr_number is a 400 with no resolution call` — pass (400 companion)

Vitest summary: `Test Files  3 passed (3)` / `Tests  21 passed (21)` (run with plugin-loader and registry files).

Live corroboration of the API half: the AC3 e2e run resolved a real merge denial through `POST /tasks/:id/approve` with `{type: "merge", approve: false, github, pr_number}` (see `merge-approval-deny.json`).

## AC9 — deploy-only — BLOCKED-by-design (waiver)

Not verifiable pre-merge per the brief ("live Slack rendering, prod GitHub App permissions, and real webhook timing are unverifiable pre-merge"). Waived to the named post-merge step, quoted from `verification-plan.md`:

> Named post-merge step (operator: Egor). After deploy, in a real non-auto repo: let a task open a PR, ask the PM to merge it, click **Approve** on the real Slack merge-approval message, and confirm the PR actually merges and the thread is notified. Two additional observations while there: (1) the thread received **exactly one** "PR ready — ask me to merge" post for the PR's ready period (AC1's user-visible half — pre-merge tests prove only the engine-side finding/`sendMessage` once-ness); (2) the PM's relay matches the updated engineering-team skill (offers merge-on-request, promises no auto-merge). Confirms live Slack rendering, prod GitHub App permissions, and real webhook timing — unverifiable pre-merge per the brief.

Evidence location per plan: "Post-merge checklist item recorded on the PR (comment with the task id, Slack permalink, and merged-PR link); AC marked verified in `forge.yaml` afterwards".

## Cross-cutting gates

- `npm run typecheck` — clean (exit 0, no diagnostics)
- `npm test` — `Test Files  47 passed (47)` / `Tests  684 passed (684)`
- Targeted `tsc --noEmit` over `tools/debug-mcp/*.ts` (strict, node16, `@types/node`) — clean
- `tools/debug-mcp/wait-for-task.test.ts` includes the AC3-backing case `surfaces a merge approval gate with its deferred stop (APPROVAL_TYPE=merge)` — pass (`Tests  20 passed (20)` in its run)

## AC3 pointer

Live-e2e evidence for AC3 is the sibling pair `merge-approval-deny.json` / `merge-approval-deny.md` in this directory (independently produced blind run, 2026-07-06; test PR sweatco/archie-plugins#81 closed unmerged and branch deleted after the run).
