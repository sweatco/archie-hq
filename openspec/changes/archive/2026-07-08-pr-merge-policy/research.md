# Research dossier: pr-merge-policy

Merged findings from three parallel lenses (codebase mapper, prior-art scanner, constraints scanner), 2026-07-06. Every claim carries a citation. Claims failing the adversarial fact-check are removed; the verdict lives in `verdicts/research-verifier-round1.md`.

## 1. Merge orchestrator (current behavior)

- `checkAndMergeLinkedPRs(taskId)` at `src/connectors/github/merge.ts:39` is the webhook-triggered orchestrator; `triggerMergeCheck(taskId)` at `merge.ts:59` collects linked PRs, fetches statuses, categorizes, and merges ready PRs.
- Exact merge condition (`merge.ts:100-127`): PR merges when `state === 'open'` AND `approved === true` AND (`mergeableState === 'clean'` OR (`mergeable === true` AND `mergeableState === 'blocked'`)). The `blocked + mergeable` case works around GitHub Rulesets reporting `blocked` despite a green merge button (`merge.ts:105-110`).
- Linked-PR collection (`merge.ts:73-87`): iterates `task.metadata.repositories` (keyed by agent id, values `AttachedRepo[]`), scans `branch_states` per repo for `pr_number`, dedupes by `github#prNumber`. No legacy top-level `pr_number` fallback exists at HEAD.
- Merge execution (`merge.ts:174-187`): calls `client.mergePullRequest(github, prNumber)` per ready PR; squash is the default merge method (`src/connectors/github/client.ts:1150`).
- **Each ready PR merges independently — there is NO "all linked PRs approved before any merge" gate in the code** (`merge.ts:111-117` per-PR filter, `merge.ts:174-176` per-PR merge loop). `docs/architecture/github-integration.md:150-158` (Merge Logic table) matches this per-PR behavior; the stale "all linked PRs approved first" wording lives only in historical `docs/plans/v3-git-and-prs.md:29,52`. The architecture doc IS stale on one point: its code sample shows a `repoInfo.pr_number` legacy fallback that no longer exists. Consequence: the brief's "open design question" about mixed-policy coupling dissolves — per-PR policy evaluation matches existing per-PR merge behavior.
- PM notification today is post-outcome only: conflicts → `notifyPMAboutConflicts()` (`merge.ts:234-249`, blocker finding + `task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')`); successful merges → `notifyPMAboutMerge()` (`merge.ts:~282`). Pending PRs produce no notification.

## 2. Webhook routing and debounce

- `determineRouteAction()` (`src/connectors/github/webhooks.ts:365-415`) maps to `merge_check`: `pull_request_review` + `state=approved` (line 370); `pull_request` + `opened|synchronize` (line 384); `push` (line 388); `workflow_run` completed non-failure (line 393).
- Debounce: `handleMergeCheckDirect(taskId)` (`webhooks.ts:260-285`), per-task timer, `MERGE_CHECK_DEBOUNCE_MS = 5000` (line 261); each trigger resets the timer.
- Task correlation: branch pattern `archie/task-{taskId}` (legacy `feature/` accepted); `issue_comment` falls back to `findTaskByPRNumber()` (`webhooks.ts:459`); task existence verified via `loadMetadata()` before routing (line 474).
- Per-PR state available for dedup of a "ready" notification: `BranchState` (`src/types/task.ts:~160-165`) already carries per-branch fields (`pr_number`, `base_branch`, `last_processed_comment_id`) — precedent for adding a notification-dedup field there. There is no existing per-PR "notified" flag.

## 3. Frontmatter → config pipeline

- Agent `.md` files parsed with gray-matter in `scanPlugins()` (`src/system/plugin-loader.ts:240-319`).
- Two shapes: preferred `metadata.archie.repos: [{github, baseBranch}, ...]` + optional `metadata.archie.primary` (`plugin-loader.ts:284-309`); legacy `metadata.archie.repo: {github, baseBranch}` (`plugin-loader.ts:310-319`), normalized to plural. Both present in one file → rejected (`plugin-loader.ts:277-281`).
- `PluginRepoEntry` interface (`plugin-loader.ts:92-96`) currently has only `github` and `baseBranch`. No `autoMerge` field exists anywhere in the pipeline.
- Unknown repo-entry frontmatter keys are **dropped** by the explicit field copy (`plugin-loader.ts:293-296`), and dropped again at the registry re-map (`registry.ts:81-86`) — not passed through. Consequence: no compat break from a new field, but `autoMerge` must be explicitly added at BOTH copy points or it silently vanishes.
- Registry flow: `scanAgentDefs()` (`src/agents/registry.ts:45`) builds `AgentDef.repo` from `agent.repo.repos.map(r => ({github: r.github, baseBranch: r.baseBranch || 'main'}))` (`registry.ts:82-85`). New field must be threaded through this map.
- Lookup by repo: `getAgentDefByGithubRepo(github)` (`registry.ts:168`) matches **primary repo only**. An any-repo lookup already exists: `findAgentDefsContainingRepo` (`registry.ts:178`) — the right seam for merge-time policy resolution.
- The `metadata.archie.*` namespace exists to avoid collision with the Claude plugin spec (`plugin-loader.ts:~247` comment).
- Multi-repo agents: `autoMerge` belongs on each repo entry (`PluginRepoEntry`), i.e. `metadata.archie.repos[].autoMerge`, with the singular `metadata.archie.repo.autoMerge` auto-migrated like the rest of the singular shape. Per-repo, not per-agent.

## 4. merge_pull_request tool

- Defined at `src/agents/tools.ts:1458-1481`: schema `{pr_number, github?}`; resolves repo via `resolveGithub(agent, args.github)` (validates PR's repo is declared by the agent, line 1464); fetches `getPRStatus` (line 1469); requires `state === 'open'` (line 1470) and `mergeable && mergeableState === 'clean'` (line 1473); merges via `client.mergePullRequest` (line 1477). Returns status text on not-ready instead of merging.
- Edit-mode gating: `mcp__repo-tools__merge_pull_request` is added to `disallowedTools` when `editAllowed === false` (`src/agents/spawn.ts:482`); available only after edit-mode approval (`docs/architecture/edit-mode.md:15,185`).
- The tool today has no interaction with the approval flow — it merges immediately when GitHub state allows.
- Note: the tool's `mergeableState === 'clean'` requirement is stricter than the orchestrator's condition (which also accepts `blocked + mergeable===true`, `merge.ts:105-110`).

## 5. Approval flow machinery (the pattern to mirror)

- `postInteractiveToUser(text, blocks, approvalType, channelKey?)` at `src/tasks/task.ts:585`; emits `approval:requested` event with `{text, approvalType}` (line 586); routes to Slack or CLI/API channel.
- approvalType union at `task.ts:585` is `'edit_mode' | 'research_budget'` at HEAD. No `max_mode` anything exists at HEAD (`handleMaxModeApproval`/`request_max_mode`/`approve_max_mode`: zero grep hits) — PR #169 (max-mode approval) is **OPEN, not merged**; see §8.
- Request-side pattern in `request_edit_mode` (`src/agents/tools.ts:489-570`): duplicate-request suppression (`tools.ts:503-513`), post interactive blocks with action ids, `task.suspendStatus()` freeze (`tools.ts:~562`), `agent.deferTeardown(() => task.stop())` to pause at turn end (`tools.ts:563-567`).
- Slack handlers: `app.action('approve_edit_mode')` (`src/connectors/slack/events.ts:217`) → resolve user via `getUserInfo()`, external-user check (`isExternalUser`, `events.ts:249-250` — external approvers are not recorded for commit authorship), → `task.handleEditModeApproval(approver)` (`events.ts:258`); `deny_edit_mode` (`events.ts:266`) → `task.handleEditModeDenial()` (`events.ts:285`). Research-budget handlers follow the same shape (`events.ts:293-320`).
- API path: `POST /tasks/:id/approve` (`src/connectors/api/routes.ts:218-276`); body `{type, approve, approver?}`; branches on `type === 'edit_mode'` (line 253) / `'research_budget'`; emits `approval:resolved` (line 270).
- Resolution methods on Task: `handleEditModeApproval(approver?)` (`task.ts:1232`) sets `metadata.edit_allowed = true` (line 1242), records approver for commit authorship (lines 1248-1250), appends decision finding, reactivates PM (line 1254); `handleEditModeDenial()` (`task.ts:1257`) logs + reactivates PM. Slack and API paths converge on these shared Task methods — resolution code IS shared; only the entry adapters differ.
- Debug MCP: `wait_for_task` surfaces `APPROVAL_TYPE` (fixed in commit 759fee1); ApprovalType at `tools/debug-mcp/wait-for-task.ts:14` and the `approve` tool enum at `tools/debug-mcp/server.ts:184` are both exactly `['edit_mode', 'research_budget']` at HEAD.
- Extension surface for a new `merge` type: union at `task.ts:585`; new Slack action ids + handlers in `events.ts`; new branch in `routes.ts:253` area; new `handleMergeApproval/Denial` on Task; debug MCP `approve` enum + wait-for-task type.

## 6. Tests and CI

- Test runner: Vitest via `npm test`; CI runs `npm run typecheck`, `npm run build`, `npm test` (`.github/workflows/ci.yml:24-26`). Tests co-located in `__tests__/` dirs.
- Existing: `src/tasks/__tests__/persistence.test.ts` (metadata I/O, PR tracking), `src/tasks/__tests__/repositories-migration.test.ts`, `src/agents/__tests__/registry-visibility.test.ts`, `src/agents/__tests__/dynamic-agent.test.ts`, `tools/debug-mcp/wait-for-task.test.ts` (covers `approval_requested` + `approval_type` for existing types).
- `src/agents/__tests__/pr-tools.test.ts:176-261` tests the `merge_pull_request` tool and `pr-tools.test.ts:416-445` tests `request_edit_mode` — an existing `GitHubClient` mocking seam to build AC4/AC5/AC6 tests on. **No tests exist for the `merge.ts` orchestrator or `determineRouteAction` webhook routing** (AC1/AC2 build on bare ground). `plugin-loader.test.ts` exists but covers only `loadMcpJson` — frontmatter repo parsing is uncovered (AC7 needs new tests).

## 7. Multi-repo coupling

- Per-PR state: `BranchState.pr_number`, `base_branch`, `last_processed_comment_id` (`src/types/task.ts:~160-165`). Per-task state: `edit_allowed` (`task.ts` metadata, `src/types/task.ts:281`), `edit_approved_by` (line 289).
- No task-level "all approved" gate exists (see §1). Mixed-policy tasks: each PR is categorized and merged (or, post-change, held) on its own state. Policy keyed by `{github}` at PR-collection time fits the existing dedupe-by-`github#prNumber` structure (`merge.ts:81`).

## 8. Prior art / collisions

- **Collision risk — open PR #169** (max-mode approval, OPEN as of 2026-07-06): touches `tools.ts`, `task.ts`, `events.ts`, `routes.ts`, `plugin-loader.ts`, `registry.ts`, `types/task.ts` — every approval surface this change extends. Its shape (new approval type end-to-end: tool → buttons → handlers) is the exact pattern to mirror, but it does NOT touch `tools/debug-mcp/*`. Sequencing/rebase risk must be handled in the plan (merge-conflict-prone files; whoever lands second rebases).
- **Open PR #176** also touches `tools.ts`/`persistence.ts` — lesser overlap, same class of risk.
- Nothing open touches `merge.ts`; no remote branch addresses merge policy; no existing autoMerge knob anywhere.
- **Issue #168** (MCP tool approval gates): sibling proposal for per-call approval gates on critical MCP tools generally, schema also under `metadata.archie.*`. Not in flight (no PR). This change's `merge` approval type and frontmatter reading are a narrower, compatible precedent; #168 would generalize later.
- **PR #182/#186** (archie-e2e harness, merged 2026-07-05/06): provides the AC3 live-e2e machinery, including `APPROVAL_TYPE` surfacing.
- `docs/proposals/forge.md` line ~81: "apply per-repo merge policy (never auto-merge by default; #139)" — this change is a named Forge prerequisite; direction matches the brief.

## 9. Constraints (design must not violate)

- Orchestrator stays the only webhook-triggered merge path; policy enforced in BOTH orchestrator and tool (`merge.ts:39-50`, `tools.ts:1458-1481`).
- Merge approval must mirror edit-mode exactly: duplicate-request suppression, `suspendStatus()`, `deferTeardown()` pause, PM reactivation on resolve (`tools.ts:489-570`, `task.ts:1232-1257`).
- External Slack users: same bail-out as edit-mode (`events.ts:249-250`).
- No new GitHub App permissions may be assumed — merge scope already exists (used daily by the orchestrator).
- No approval-count floor: mergeability per GitHub is the sole gate on the explicit path (brief AC5; current conditions at `merge.ts:111-117` include `approved===true` which the explicit path must NOT require).
- "Ready" notification: exactly once per PR per ready-state; per-branch `BranchState` is the natural home for the dedup marker; 5s debounce alone does NOT guarantee once-ness across separate webhook bursts (`webhooks.ts:260-285`).
- `approval:requested` event with new type must remain compatible with SSE/JSONL consumers (`task.ts:586`) and debug MCP (`wait-for-task.ts:14`).
- Unified logger only, no bare console (`src/system/logger.ts`); TypeScript strict typecheck in CI; tests co-located in `__tests__/`.
- Frontmatter field optional, default false; older engine versions drop the unknown key at the explicit field copy — no compat break, but the new engine must add the field at both copy points (`plugin-loader.ts:293-296`, `registry.ts:81-86`).
- Plugins-repo docs (if touched) follow archie-plugins CLAUDE.md conventions: plain-language, no harness internals.

## Open items for plan stage

1. Notification dedup mechanism: `BranchState` marker vs ready-state transition detection.
2. Tool's `clean`-only mergeable check vs orchestrator's `blocked+mergeable` tolerance — align or keep divergent on the explicit path.
3. Sequencing vs open PR #169 (same approval surfaces) and #176 (tools.ts): design for minimal conflict; expect a rebase.
4. Doc refresh: `docs/architecture/github-integration.md` merge section gains the policy layer; also fix its stale `repoInfo.pr_number` legacy-fallback code sample while there.

(Resolved during fact-check: multi-repo coupling is already per-PR in code and docs — brief's open design question dissolves; policy lookup seam is `findAgentDefsContainingRepo` (`registry.ts:178`); approvalType union at HEAD is exactly `'edit_mode' | 'research_budget'`.)
