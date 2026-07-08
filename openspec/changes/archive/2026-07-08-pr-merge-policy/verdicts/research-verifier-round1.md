# Adversarial fact-check: pr-merge-policy research.md — round 1

Verifier: fresh-context adversarial pass, 2026-07-06. Every citation opened at HEAD of `forge/pr-merge-policy` (= main + run-state). `gh` evidence re-checked live.

## §1 Merge orchestrator

- `checkAndMergeLinkedPRs(taskId)` at merge.ts:39, `triggerMergeCheck(taskId)` at merge.ts:59 — **CONFIRMED**. `src/connectors/github/merge.ts:39,59`.
- Exact merge condition (open AND approved AND (clean OR mergeable+blocked)) — **CONFIRMED**. `merge.ts:111-117`: `pr.status.state === 'open' && pr.status.approved && (pr.status.mergeableState === 'clean' || (pr.status.mergeable && pr.status.mergeableState === 'blocked'))`. Rulesets rationale comment at `merge.ts:106-110`.
- Linked-PR collection iterates `task.metadata.repositories`, scans `branch_states`, dedupes by `github#prNumber` — **CONFIRMED** at `merge.ts:73-87` (dedupe key at line 81). **BUT: "legacy fallback to top-level `pr_number`" is WRONG** — there is no such fallback in merge.ts at HEAD; the loop reads only `state.pr_number` from `branch_states` (`merge.ts:79-85`, no `else if` branch). The legacy-fallback code sample exists only in `docs/architecture/github-integration.md:~168-180`, which is itself stale relative to the code.
- Merge execution per ready PR via `client.mergePullRequest` — **CONFIRMED**. `merge.ts:174-187`; squash default **CONFIRMED** at `src/connectors/github/client.ts:1150` (`mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'`).
- **Flagged contradiction 1 — "each ready PR merges independently, NO all-approved gate": CONFIRMED.** Decisive lines: the `mergeable` filter is per-PR (`merge.ts:111-117`) and the merge loop is `for (const pr of mergeable) { await githubClient.mergePullRequest(pr.github, pr.prNumber); }` (`merge.ts:174-176`) — no cross-PR condition anywhere in the file.
- **"docs/architecture/github-integration.md (~line 156) claims all linked PRs must be approved first — the doc contradicts the code": WRONG.** The architecture doc does NOT say this. Its Merge Logic table (`github-integration.md:150-158`) categorizes each PR individually ("Mergeable | state === 'open' AND approved AND ... | Attempt merge") — it matches the code. The "all linked PRs approved" wording exists only in the historical plan `docs/plans/v3-git-and-prs.md:29,52`. The architecture doc IS stale, but on a different point: its code sample shows a `repoInfo.pr_number` legacy fallback (~lines 168-180) that no longer exists in merge.ts.
- PM notification post-outcome only: conflicts → `notifyPMAboutConflicts` — **CONFIRMED** at `merge.ts:234-250` (blocker finding line 246, `task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')` line 249); merges → `notifyPMAboutMerge` — **CONFIRMED**, function at `merge.ts:256-283` (research's "~282" is the `sendMessage` line inside it). Pending → silent — **CONFIRMED** (`merge.ts:50` comment, no pending branch in `checkAndMergeLinkedPRs`).

## §2 Webhook routing and debounce

- `determineRouteAction()` mapping — **CONFIRMED**. `src/connectors/github/webhooks.ts:365` (function); `pull_request_review` approved → merge_check line 370; `pull_request` opened|synchronize → merge_check line 384; `push` → merge_check lines 387-388; `workflow_run` completed non-failure → merge_check lines 391-395. (Note: there is also a `checks_ready` route for failure-class `check_suite`, lines 397-410 — not claimed, not contradicted.)
- Debounce `handleMergeCheckDirect`, per-task timer, `MERGE_CHECK_DEBOUNCE_MS = 5000`, each trigger resets — **CONFIRMED** with minor drift: constant at `webhooks.ts:262`, function at `webhooks.ts:269-290`, `clearTimeout` on existing timer line 271-275.
- Task correlation: branch pattern + legacy `feature/`, `issue_comment` → `findTaskByPRNumber()` (line 459), `loadMetadata()` verification (line 474) — **CONFIRMED**. `webhooks.ts:459,465,474`; branch parsing in `src/connectors/github/branch-naming.ts:29-39` — pattern is `archie/{taskId}` where taskId is `task-YYYYMMDD-HHMM-random`, so branches literally read `archie/task-...`; legacy `feature/` prefix accepted (`branch-naming.ts:20`). Research's `archie/task-{taskId}` notation is slightly off (would double the `task-`), but the described behavior is right.
- `BranchState` carries `pr_number`, `base_branch`, `last_processed_comment_id`; no existing "notified" flag — **CONFIRMED**. `src/types/task.ts:161-167` (also has `stash_name`, `pr_card`; no notification field).

## §3 Frontmatter → config pipeline

- gray-matter parsing in `scanPlugins()` at plugin-loader 240-319 — **CONFIRMED**. `matter(agentContent)` at `src/system/plugin-loader.ts:243`.
- Two shapes; plural preferred, legacy singular normalized to plural; both → rejected — **CONFIRMED**. Rejection `plugin-loader.ts:277-282` (`throw ... declares both metadata.archie.repo and metadata.archie.repos — use one`); plural parse 284-310 (incl. `primary` validation 298-308); legacy singular synthesis 311-320.
- `PluginRepoEntry` = only `github` + `baseBranch`; no `autoMerge` anywhere — **CONFIRMED**. Interface at `plugin-loader.ts:93-96`; `grep -rn autoMerge` over archie-hq src and archie-plugins → zero hits.
- "Unknown frontmatter fields are silently passed through" — **WRONG mechanism, right conclusion**. Unknown keys are silently **ignored/dropped**, not passed through: the repos map copies only `github` and `baseBranch` (`plugin-loader.ts:293-296`), so an `autoMerge` key on a repo entry would be stripped today. No strict validation rejects new keys — that part is correct, and backward compatibility holds. But research/§9 must not imply the value survives the loader; it must be explicitly added to the map.
- Registry flow: `scanAgentDefs()` at registry.ts:45, repos map — **CONFIRMED**. `src/agents/registry.ts:45`; map at `registry.ts:81-86` (`repos: agent.repo.repos.map((r) => ({ github: r.github, baseBranch: r.baseBranch || 'main' }))`). New field must be threaded — correct.
- `getAgentDefByGithubRepo` UNCERTAIN → **RESOLVED: primary-only**. `registry.ts:168`: `registry.find((d) => isRepoAgent(d) && d.repo!.primary === githubRepo)`; doc comment says "Matches on the primary only". An any-repo lookup already exists: `findAgentDefsContainingRepo` at `registry.ts:178`.
- `metadata.archie.*` namespace anti-collision comment — **CONFIRMED**. `plugin-loader.ts:246-249`.
- "autoMerge belongs on each repo entry" — design opinion, not fact-checked; the premise (per-repo entries exist, singular auto-migrated) is CONFIRMED above.

## §4 merge_pull_request tool

- Definition, schema, resolveGithub validation, getPRStatus, open check, `mergeable && mergeableState === 'clean'`, merge call — **CONFIRMED**. `src/agents/tools.ts:1458-1481` (`createMergePRTool`); `resolveGithub` rejects undeclared repos (`tools.ts:74-82`); open check 1471-1473; clean check 1474-1476; merge 1478. Returns status text instead of merging when not ready — CONFIRMED (both rejections return `ok(...)` text).
- Edit-mode gating at spawn.ts:482 — **CONFIRMED**. `src/agents/spawn.ts:482` (`'mcp__repo-tools__merge_pull_request'` inside the `editAllowed ? [] : [...]` block, ~473-486). `docs/architecture/edit-mode.md:15` (prose list) and `:185` (tool list) — **CONFIRMED**.
- No interaction with approval flow; merges immediately when GitHub state allows — **CONFIRMED** (no `approved` check, no `postInteractiveToUser` in the tool).
- Stricter than orchestrator (clean-only vs blocked+mergeable) — **CONFIRMED**. `tools.ts:1474` vs `merge.ts:115-116`.

## §5 Approval flow machinery

- `postInteractiveToUser(text, blocks, approvalType, channelKey?)` at task.ts:585; emits `approval:requested` with `{text, approvalType}` at 586 — **CONFIRMED**. `src/tasks/task.ts:585-586`.
- **Flagged contradiction 2 — approvalType union at HEAD: RESOLVED.** Union at `task.ts:585` is exactly `'edit_mode' | 'research_budget'`. **`max_mode` does NOT exist at HEAD**: `grep -rn "max_mode|maxMode|MaxMode"` over `src/` and `tools/` → zero hits. No `handleMaxModeApproval`, no `request_max_mode`, no `approve_max_mode`/`deny_max_mode` Slack actions, no API branch. They exist only on the branch of **open, unmerged PR #169** (see §8 below — the "merged 2026-07-05" premise was false).
- `request_edit_mode` pattern — **CONFIRMED** with small drift. `tools.ts:489` (`createRequestEditModeTool`); task-lifetime idempotency `tools.ts:505-509`; duplicate-request suppression via `agent.pendingTeardown` `tools.ts:511-514`; `task.suspendStatus()` `tools.ts:565`; `agent.deferTeardown(() => task.stop())` `tools.ts:567`. Also posts action ids `approve_edit_mode`/`deny_edit_mode` (`tools.ts:547,554`).
- Slack handlers — **CONFIRMED**. `src/connectors/slack/events.ts:217` (`approve_edit_mode`), `getUserInfo` + `isExternalUser` check at 248-251 (external approver: edit mode still approved, approver not recorded → commits stay bot-authored — matches research), `handleEditModeApproval(approver)` at 258; `deny_edit_mode` at 266, `handleEditModeDenial()` at 285; research-budget handlers same shape at 293+.
- API path — **CONFIRMED**. `src/connectors/api/routes.ts:218` (`POST /tasks/:id/approve`), body `{type, approve, approver?}` 221-227, `type === 'edit_mode'` branch at 253, `research_budget` at 259, unknown type → 400 at 264-266, `emitEvent('approval:resolved', ...)` at 270.
- Task resolution methods — **CONFIRMED** with 1-line drift. `handleEditModeApproval` at `task.ts:1232`; `metadata.edit_allowed = true` at 1243 (research said 1242); approver recording 1249-1251; decision finding + PM reactivation 1254-1256; `handleEditModeDenial` at 1258 (research said 1257). Slack and API converge on shared Task methods — CONFIRMED.
- Debug MCP — **CONFIRMED**. `approve` tool at `tools/debug-mcp/server.ts:179-192`, enum exactly `z.enum(['edit_mode', 'research_budget'])` (server.ts:184) — **no `max_mode`**. `wait-for-task.ts:14`: `export type ApprovalType = 'edit_mode' | 'research_budget';`. Commit 759fee1 is the APPROVAL_TYPE fix (`git show 759fee1`: touches wait-for-task.ts/.test.ts) — CONFIRMED.
- Extension surface list — consistent with all confirmed locations above. CONFIRMED as a derived claim.

## §6 Tests and CI

- Vitest via `npm test` — **CONFIRMED** (`package.json:25`: `"test": "vitest run --reporter=verbose"`). CI runs typecheck/build/test — **CONFIRMED** at `.github/workflows/ci.yml:24-26`. Tests co-located in `__tests__/` — CONFIRMED.
- Named existing test files (`persistence.test.ts`, `repositories-migration.test.ts`, `registry-visibility.test.ts`, `dynamic-agent.test.ts`, `wait-for-task.test.ts` covering approval_requested + approval_type) — **CONFIRMED**; all exist; `wait-for-task.test.ts:56-60,139-145` asserts `approval_type === 'edit_mode'`.
- **"No unit/integration tests exist for merge.ts, webhook routing, or the tools.ts approval paths": PARTLY WRONG.**
  - merge.ts orchestrator: CONFIRMED no tests (`grep triggerMergeCheck|checkAndMergeLinkedPRs|determineRouteAction` over `*.test.ts` → zero hits).
  - Webhook routing: no `determineRouteAction` tests — CONFIRMED; but `src/connectors/github/__tests__/branch-naming.test.ts` covers the branch→task correlation half.
  - tools.ts approval paths: **WRONG** — `src/agents/__tests__/pr-tools.test.ts:416-445` has a `request_edit_mode` describe block (idempotent no-op when approved; posts approval prompt otherwise). Additionally, `pr-tools.test.ts:176-261` covers the `merge_pull_request` tool itself (rejects non-open, rejects non-clean, rejects mergeable=false, merges when open+clean) — directly relevant seams/regression baseline for this change, and unmentioned by research.
- "Frontmatter parsing test coverage: none found (UNCERTAIN)" — **RESOLVED: correct that frontmatter parsing is untested**, but note `src/system/__tests__/plugin-loader.test.ts` DOES exist — it covers only `loadMcpJson` (describe blocks at lines 29-94), not agent frontmatter/repos parsing.
- "mocking seams needed for GitHubClient and Slack" — pr-tools.test.ts already demonstrates a GitHubClient mocking seam; the "bare ground" framing overstates.

## §7 Multi-repo coupling

- `BranchState` fields — **CONFIRMED**, `src/types/task.ts:161-167`. Task-level `edit_allowed` at `src/types/task.ts:281`, `edit_approved_by` at `:289` — **CONFIRMED** (exact lines).
- No task-level all-approved gate — **CONFIRMED** (see §1). Dedupe-by-`github#prNumber` at `merge.ts:81` — **CONFIRMED**.

## §8 Prior art / collisions

- **"No collisions: no open PRs touch merge.ts, tools.ts approval paths, or frontmatter repo parsing": WRONG.** Open PR **#169** (`feat(max-mode): per-task, human-approved model/effort upgrade (#142)`, state OPEN, mergedAt null) touches `src/agents/tools.ts`, `src/tasks/task.ts`, `src/connectors/slack/events.ts`, `src/connectors/api/routes.ts`, `src/system/plugin-loader.ts`, `src/agents/registry.ts`, `src/types/task.ts` (`gh pr view 169 --json files`) — i.e. every approval-flow surface this change extends (it adds an approval type end-to-end). Open PR **#176** also touches `src/agents/tools.ts` and `src/tasks/persistence.ts`. True parts: no open PR touches `merge.ts`; no remote branch named for merge policy (`git ls-remote --heads` grep merge/policy → none); no autoMerge knob anywhere — CONFIRMED.
- Issue #168 (per-call approval gates for critical MCP tools, `metadata.archie.*` schema, no PR in flight) — **CONFIRMED**. `gh issue view 168`: title "Human-in-the-loop approval gate for critical MCP tools", OPEN; no open PR implements it.
- **"PR #169 (max-mode approval, merged 2026-07-05)": WRONG on status.** PR #169 is **OPEN, not merged** (`gh pr view 169`: `"state":"OPEN","mergedAt":null`). It IS a max-mode approval feature mirroring edit-mode (title/body confirm), so it is valid prior art as a *pending* template — but nothing from it is at HEAD, and it is a live merge-conflict risk, not history. Also its changed files do NOT include `tools/debug-mcp/*`, so the "tool → buttons → handlers → debug MCP" template description overreaches on the debug-MCP leg.
- PR #182 / #186 merged 2026-07-05 / 2026-07-06, e2e harness + APPROVAL_TYPE surfacing — **CONFIRMED** (`gh pr view 182/186`: both MERGED at those dates; #186 title includes "APPROVAL_TYPE fix").
- forge.md ~line 81 merge-policy quote — **CONFIRMED**. `docs/proposals/forge.md:81`: "apply per-repo merge policy (never auto-merge by default; #139)".

## §9 Constraints

- Orchestrator is the only webhook-triggered merge path; tool is the direct path — **CONFIRMED** (`merge.ts:39-51`, `tools.ts:1458-1481`; doc cross-check `github-integration.md` Trigger Points).
- Mirror-edit-mode pattern citations — **CONFIRMED** (all verified in §5).
- External Slack users bail-out — **CONFIRMED** (`events.ts:248-251`; note semantics: approval still proceeds, only authorship attribution is skipped — a merge-approval design must decide whether that carry-over is acceptable, since for merges the *decision* is the sensitive part).
- Merge scope already exists — **CONFIRMED** (orchestrator calls `mergePullRequest` today, `merge.ts:176`).
- `merge.ts:111-117` includes `approved===true` — **CONFIRMED** (line 114).
- 5s debounce does not guarantee once-ness across bursts — CONFIRMED as reasoning (timer fires per burst, `webhooks.ts:280-289`; nothing persists across bursts).
- `approval:requested` compat surfaces — **CONFIRMED** (`task.ts:586`, `wait-for-task.ts:14`).
- Logger/CI/test conventions — **CONFIRMED** (CLAUDE.md, ci.yml, `__tests__/` layout).
- "silently ignored by older engine versions (loader passes unknown keys through)" — **WRONG mechanism** (same as §3: the loader *drops* unknown repo-entry keys via explicit field copy, `plugin-loader.ts:293-296`); the no-compat-break conclusion still holds.

---

## Summary

**Counts: 41 CONFIRMED, 6 WRONG, 0 UNVERIFIABLE** (2 of the 6 WRONGs are the same error stated twice; both §5/§8 UNCERTAIN flags resolved).

WRONG claims and required corrections to research.md:

1. **§1 doc contradiction**: `docs/architecture/github-integration.md` does NOT claim "all linked PRs approved before any merge" — its Merge Logic table (lines 150-158) matches the per-PR code. Delete the doc-vs-code contradiction; the stale "all linked PRs approved" wording lives only in historical `docs/plans/v3-git-and-prs.md:29,52`. (The architecture doc IS stale on a different point: its code sample shows a `repoInfo.pr_number` legacy fallback that merge.ts no longer has.) Open item 1 dissolves.
2. **§1 linked-PR collection**: remove "legacy fallback to top-level `pr_number`" — no such fallback exists in `merge.ts:73-87` at HEAD.
3. **§5 + §8 PR #169 status**: PR #169 is **OPEN, not merged**. Consequently at HEAD there is NO `max_mode` anywhere: union is `'edit_mode' | 'research_budget'` (`task.ts:585`), debug MCP enum is `['edit_mode', 'research_budget']` (`server.ts:184`), ApprovalType is the same pair (`wait-for-task.ts:14`), and `handleMaxModeApproval`/`request_max_mode`/`approve_max_mode` do not exist in the codebase. #169 is prior art only as a pending template, and its files do not include `tools/debug-mcp/*`.
4. **§8 "No collisions"**: WRONG — open PR #169 touches tools.ts, task.ts, events.ts, routes.ts, plugin-loader.ts, registry.ts, types/task.ts (all surfaces this change extends); open PR #176 touches tools.ts and persistence.ts. Must be flagged as a live conflict/sequencing risk.
5. **§6 test coverage**: "no tests for the tools.ts approval paths" is WRONG — `src/agents/__tests__/pr-tools.test.ts:416-445` tests `request_edit_mode`, and `pr-tools.test.ts:176-261` tests the `merge_pull_request` tool (rejection + merge cases) with an existing GitHubClient mocking seam. Correct: no tests for the merge.ts orchestrator or `determineRouteAction`. Also note `src/system/__tests__/plugin-loader.test.ts` exists (loadMcpJson only; frontmatter parsing indeed uncovered).
6. **§3/§9 "unknown frontmatter keys passed through"**: WRONG mechanism — unknown repo-entry keys are silently **dropped** by the explicit field copy at `plugin-loader.ts:293-296` (and registry re-map `registry.ts:81-86`), not passed through. Compat conclusion (no break) stands, but `autoMerge` must be explicitly added at both copy points.

Resolved UNCERTAINs (update research.md):

- §3 `getAgentDefByGithubRepo` (`registry.ts:168`) is **primary-only**; the any-repo lookup already exists as `findAgentDefsContainingRepo` (`registry.ts:178`) — open item 3 has a ready-made answer.
- §5/§8 approvalType at HEAD: `'edit_mode' | 'research_budget'` everywhere (see #3 above).

Minor notes (no research change strictly required): branch pattern is `archie/{taskId}` with taskId already `task-...` (not `archie/task-{taskId}`); `MERGE_CHECK_DEBOUNCE_MS` is at `webhooks.ts:262`; `notifyPMAboutMerge` is defined at `merge.ts:256`; `handleEditModeDenial` at `task.ts:1258`; `determineRouteAction` also has a `checks_ready` route for failure-class `check_suite` events (webhooks.ts:397-410) that §2 omits; external-approver handling still *approves* (only authorship is skipped) — worth an explicit design decision for merge approvals.
