# Spec-compliance verdict — pr-merge-policy, round 1

**Verdict: PASS** (2 non-blocking observations, no blocking findings)

Reviewed with fresh context against `openspec/changes/pr-merge-policy/` (brief.md, design.md, tasks.md, specs/*) and the two diffs: archie-hq `main...forge/pr-merge-policy` (excluding `openspec/changes/pr-merge-policy/` run state) and archie-plugins `main...merge-policy-docs`.

## 1. Task-by-task presence check (33/33 present)

**Section 1 — frontmatter flag and type threading (AC7)**
- 1.1 ✅ `PluginRepoEntry.autoMerge?: boolean` (`src/system/plugin-loader.ts:98-104`), populated strict-boolean (`entry.autoMerge === true`) in the plural map (`plugin-loader.ts:301`) and legacy-singular migration (`plugin-loader.ts:323`).
- 1.2 ✅ `RepoEntry.autoMerge: boolean` (`src/types/agent.ts:89-94`); registry copy `autoMerge: r.autoMerge === true` (`src/agents/registry.ts:85`); `synthesizeDynamicAgentDef` hardcodes `autoMerge: false` (`registry.ts:222`).
- 1.3 ✅ New `src/system/__tests__/plugin-loader-frontmatter.test.ts` (plural true, absent→false, `"true"`→false, `1`→false, legacy-singular migration, legacy absent→false) + `src/agents/__tests__/registry-auto-merge.test.ts` (registry default false, true carried through, dynamic agents always false).

**Section 2 — policy lookup and shared mergeability helper**
- 2.1 ✅ `isAutoMergeRepo(github)` beside `findAgentDefsContainingRepo` (`registry.ts:196-208`): empty defs → false, AND over all matching entries of all declaring agents, one `logger.warn` on mixed flags.
- 2.2 ✅ `registry-auto-merge.test.ts:562-615`: undeclared→false, single true→true, single off→false, true+true→true (no warn), true+false→false+warn, one agent with mixed duplicate entries→false.
- 2.3 ✅ `src/connectors/github/mergeability.ts` with `import type { PRStatus }`; `mergeability.test.ts` covers clean±mergeable, blocked±mergeable, dirty, unstable.
- 2.4 ✅ Orchestrator condition switched to the helper (`merge.ts:150-158`); tool readiness uses it in both branches (`tools.ts:1475,1516`); `pr-tools.test.ts` gains the flipped `blocked + mergeable=true → merges` case. Gate verified live: `npm run typecheck`, `npm run build`, `npm test` all green (47 files, 680 tests).

**Section 3 — merge approval type and pending state (AC4/AC5)**
- 3.1 ✅ `postInteractiveToUser` union widened to `'edit_mode' | 'research_budget' | 'merge'` (`src/tasks/task.ts:586`).
- 3.2 ✅ `TaskMetadata.pending_merge_approval` with the four fields, beside `edit_approved_by` (`src/types/task.ts:296-307`); round-trip persistence tests added to `src/tasks/__tests__/persistence.test.ts:188-242`.
- 3.3 ✅ `Task.handleMergeApproval(approver, expected)` (`task.ts:1280-1338`): synchronous read-compare-clear with no await between read, compare, and clear (`task.ts:1284-1296`); empty/mismatched slot → warn + `'stale'` disposition, slot untouched; on match: `clearPendingTeardown()` via `requested_by`, `getPRStatus`, merge when `state === 'open' && isMergeReadyPerGithub(status)` with **no `approved` check**, completion finding on success / decision finding with exact reason on failure (incl. `{success:false}`, thrown error, and unconfigured-client cases), `debouncedSave()`, PM reactivation via `sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')`.
- 3.4 ✅ `Task.handleMergeDenial(expected)` (`task.ts:1344-1361`): same atomic gate, `Merge denied by user — PR not merged` finding, PM reactivated, zero GitHub calls.
- 3.5 ✅ New `src/tasks/__tests__/merge-approval.test.ts`: approve+mergeable (AC4), dirty (AC4), closed (AC4), merge-API `{success:false}` (AC4), thrown merge error (AC4), `approved: false` + clean → merges (AC5), deny → no `getPRStatus`/`mergePullRequest`, stale empty-slot no-op, supersede-during-resolution race (slot at PR#2, click for PR#1 → stale, neither merged, PR#2 slot intact, subsequent PR#2 click resolves), same mismatch case for denial.

**Section 4 — tool policy gating (AC3 plumbing, AC5, AC6)**
- 4.1 ✅ `createMergePRTool` forks on `isAutoMergeRepo` (`tools.ts:1470-1480` auto path = today's direct-merge body with the shared helper); tool description states the policy-gated contract (`tools.ts:1462`).
- 4.2 ✅ Approval-request branch (`tools.ts:1482-1560`): suppression/supersede fork applies only when the slot is set; duplicate suppression gated on task-level quiescence `[...task.agentProcesses.values()].some((a) => a.pendingTeardown)` (`tools.ts:1494`); stale slot with nobody parked falls through to supersede; readiness requires `state === 'open' && isMergeReadyPerGithub(status)` with no `approved` requirement; decision finding appended; interactive blocks with `approve_merge`/`deny_merge`, value `<taskId>|<github>#<pr_number>` (`tools.ts:1526-1541`); `postInteractiveToUser(..., 'merge')`; slot persisted; `suspendStatus()` + `deferTeardown(() => task.stop())`.
- 4.3 ✅ `pr-tools.test.ts` policy-gating describe: auto→direct merge/no prompt/no pause (AC6); non-auto ready→prompt, slot, deferred teardown, type `merge` (AC3 plumbing); not-ready→no prompt; same-turn duplicate→single prompt; concurrent-agent (different agent holds teardown)→already-pending, no supersede; stale-slot supersede for same PR and different PR; zero-approvals-but-clean→approval requested (AC5).

**Section 5 — orchestrator gating and notification (AC1, AC2)**
- 5.1 ✅ `BranchState.merge_ready_notified?: boolean` (`src/types/task.ts:167-172`).
- 5.2 ✅ `triggerMergeCheck` splits the mergeable bucket by `isAutoMergeRepo` (`merge.ts:169-170`), merges only `autoMergeable` (`merge.ts:244`), `MergeCheckResult.ready` bucket (`merge.ts:18`), `READY (merge on request)` categorization log (`merge.ts:219-221`).
- 5.3 ✅ Notify-once: `findBranchStatesForPR` walks `task.metadata.repositories` by `(github, pr_number)` (`merge.ts:287-299`); notified iff any entry carries the marker; markers cleared for PRs observed not-ready-while-open or closed (`merge.ts:172-190`).
- 5.4 ✅ `notifyPMAboutReadyPRs` modeled on `notifyPMAboutConflicts` (`merge.ts:347-367`), wired into `checkAndMergeLinkedPRs` for newly-notifiable PRs only via `markNewlyNotifiableReadyPRs` (`merge.ts:55-59, 70-97`); markers set on all matches; PR matching the current `pending_merge_approval` slot skipped (`merge.ts:81-82`).
- 5.5 ✅ New `src/connectors/github/__tests__/merge.test.ts`: webhook-burst → exactly one notification, no merge (AC1); auto → squash merge as today (AC2); mixed-policy per-PR split; un-ready→ready re-notifies; marker survives reload (persisted-metadata simulation); pending-slot PR → no notification.

**Section 6 — resolution surfaces (AC8)**
- 6.1 ✅ `registerMergeActionHandlers` (`src/connectors/slack/events.ts:392-457`, registered at `events.ts:345`): ack → parse value → `Task.get` → `getUserInfo` with `isExternalUser` bail-out (external approver still resolves, identity omitted) → Task method; **no handler-side slot verification**; message updated after the Task method from its disposition (✅/❌ vs stale notice).
- 6.2 ✅ `type === 'merge'` branch in `POST /tasks/:id/approve` (`src/connectors/api/routes.ts:241-247, 280-286`): missing `github`/`pr_number` → 400; passes `expected` to the same Task methods.
- 6.3 ✅ New `src/connectors/__tests__/merge-approval-surfaces.test.ts`: fake Bolt app captures `approve_merge`/`deny_merge` registrations, mounted-router capture of the route handler; asserts both surfaces call the identical `handleMergeApproval`/`handleMergeDenial` with the same parsed `expected`; mismatch case → stale disposition + stale notice, no confirmation; API merge body without identity → 400, no resolution call; external-approver case.

**Section 7 — debug MCP**
- 7.1 ✅ `approve` enum → `['edit_mode', 'research_budget', 'merge']`, optional `github`/`pr_number` forwarded verbatim in the request body, description names the merge identity requirement (`tools/debug-mcp/server.ts:179-193`, `archie-client.ts:100-115`).
- 7.2 ✅ `'merge'` added to `ApprovalType` (`wait-for-task.ts:14`) and to the event fold (`wait-for-task.ts:154`); `wait-for-task.test.ts` gains the `APPROVAL_TYPE=merge` case. Targeted `tsc --noEmit` over the touched `tools/debug-mcp/*.ts` files passes.

**Section 8 — docs**
- 8.1 ✅ `docs/architecture/github-integration.md`: new "Merge Policy (`autoMerge`)" section (flag, AND semantics, ready bucket + once-per-ready-period notification, explicit-request path, tool gating); Merge Logic table split into auto/ready rows; stale `repoInfo.pr_number` legacy-fallback sample replaced with the current `repositories → AttachedRepo[] → branch_states` walk.
- 8.2 ✅ `docs/architecture/edit-mode.md:15,185`: both `merge_pull_request` mentions note the second `merge` approval gate in non-auto repos.
- 8.3 ✅ archie-plugins `CLAUDE.md`: `autoMerge` row in the frontmatter reference table, repo-field list entry, and the multi-repo example annotated — plain language, default-off, no harness internals. (The example's `autoMerge: true` on one entry is prescribed verbatim by design Decision 9 and is a fenced docs sample, not parsed frontmatter — checked against the "no real repo opted in" non-goal and compliant: no agent `.md` frontmatter changed in either repo.)
- 8.4 ✅ archie-plugins `pm/skills/engineering-team/SKILL.md`: lifecycle step 6 rewritten (notify once, merge on request via approve/deny buttons, `autoMerge: true` exception) and line 78 rewritten (green-CI wakeups now cover the ready notification, not auto-merge).
- 8.5 ✅ `prompts/repo-agent.md:142`: `merge_pull_request` line describes the policy-gated contract.

**Section 9 — E2E and gate**
- 9.1 ✅ `.claude/skills/archie-e2e/SKILL.md`: canonical `merge-approval-deny` recipe mirroring `edit-mode-approval` (nonce → PR opened via edit-mode gate → merge request → `APPROVAL_TYPE=merge` → `approve(type: "merge", approve: false, github, pr_number)` → no-merge assertions), with the configured-repo prerequisite + BLOCKED reporting rule; scenario name added to the evidence-schema table.
- 9.2 ✅ Re-ran the full gate during this review: `npm run typecheck` clean, `npm run build` clean, `npm test` 680/680 green, targeted `tsc --noEmit` over `tools/debug-mcp/server.ts|archie-client.ts|wait-for-task.ts` clean.
- 9.3 ✅ Evidence present: `openspec/changes/pr-merge-policy/qa-evidence/merge-approval-deny.json` (+ `.md`), `scenario: merge-approval-deny`, `ac_ids: ["AC3"]`, `result: pass`.

## 2. AC code-level claims

- **AC1** ✅ Orchestrator never merges non-auto PRs (`merge.ts:244` iterates `autoMergeable` only); exactly-one notification enforced by the persisted `merge_ready_notified` marker with clear-on-not-ready; webhook-burst behavior proven by two consecutive `checkAndMergeLinkedPRs` runs in `merge.test.ts` ("holds a ready non-auto PR and notifies exactly once across a webhook burst").
- **AC2** ✅ Auto path byte-for-byte: same squash-default `mergePullRequest` call, same completion finding (`merge.test.ts` AC2 case).
- **AC3 plumbing** ✅ Non-auto tool call: no merge, `approval:requested` with `approvalType: 'merge'` emitted by `postInteractiveToUser` (`task.ts:587`), task paused via `suspendStatus` + `deferTeardown(() => task.stop())`; `wait_for_task` surfaces `APPROVAL_TYPE=merge`; deny path performs zero GitHub calls (`task.ts:1344-1361`, test-asserted). Live-verified per qa-evidence.
- **AC4** ✅ Approve → re-check → merge when `open && isMergeReadyPerGithub`; not-mergeable → decision finding with `state/mergeable/mergeableState`; merge failure (`{success:false}` or throw) → decision finding with the failure message; PM reactivated in every branch so the outcome reaches the user.
- **AC5** ✅ No `approved` check on the explicit path — neither in the tool's non-auto readiness check (`tools.ts:1516`) nor in `handleMergeApproval` (`task.ts:1310`); both asserted with `approved: false` fixtures.
- **AC6** ✅ Auto branch merges directly; test asserts no `postInteractiveToUser`, no `suspendStatus`, no `deferTeardown`, no slot.
- **AC7** ✅ Default off at every layer: strict `=== true` at both plugin-loader copy points, `r.autoMerge === true` at the registry copy, `autoMerge: false` hardcoded for dynamic agents (`registry.ts:222`), `isAutoMergeRepo` false for undeclared repos; no frontmatter changed in either repo.
- **AC8** ✅ Slack handlers and the API route converge on the same `Task.handleMergeApproval`/`handleMergeDenial` with the same parsed `{github, pr_number}`; identity verification lives inside the Task method, atomic with the clear; adapters do no verification of their own (`events.ts:392-457`, `routes.ts:280-286`, proven in `merge-approval-surfaces.test.ts`).
- **AC9** — deploy-only by design; correctly not attempted here.

## 3. Scope check (nothing beyond the plan)

Every touched file maps to a task: engine files (1.x–6.x), debug MCP (7.x), docs/prompts (8.x), e2e skill (9.1), plus test-only adjustments forced by the type change (`dynamic-agent.test.ts` RepoEntry literals) and by the round-trip test (`persistence.test.ts` temp-dir mock — required for real file I/O; all 680 tests pass). No unrequested refactors found. Non-goals respected: no approval counting, no merge-method override (squash default untouched), no channel-scoped permissions, no real repo opted into `autoMerge: true` (archie-plugins diff touches only `CLAUDE.md` and the PM skill — no agent frontmatter). The archie-plugins diff contains exactly tasks 8.3/8.4 and nothing else.

## Findings

1. **Non-blocking** — `src/agents/tools.ts:1483-1503`: the supersede fork is detected before the readiness check, but the slot is only rewritten after it. When a stale slot exists (nobody parked) and the *newly requested* PR is not ready, the tool returns "not ready" and leaves the old stale slot in place — task 4.2 reads as unconditional supersede on that fork. The implementation choice is the sensible one (posting a prompt for an unmergeable PR is noise per design step 3, and rewriting the slot without a prompt would strand a promptless slot), all planned scenarios behave as specified, and the old prompt's buttons still resolve per the plan's stale-prompt semantics. Recorded as a deviation-in-letter, not in intent; no action required.
2. **Non-blocking** — `src/agents/__tests__/registry-auto-merge.test.ts:581-586`: task 2.2's "single agent absent → false" case is exercised with an explicit `autoMerge: false` at the `RepoEntry` level, since `RepoEntry.autoMerge` is non-optional (absent is unrepresentable there by design). The absent case is covered where it actually exists — the registry copy (`registry-auto-merge.test.ts:530-537`) and the plugin-loader parse tests. Intent fully met; no action required.
