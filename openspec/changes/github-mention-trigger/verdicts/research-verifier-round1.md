# Verdict — `github-mention-trigger` research dossier vs working copy @ 3ed6ba4 (+3063c2d)

Role: adversarial fact-checker (fresh context). Per-claim verdicts; corrected line numbers reported where drifted. Dossier updated accordingly (only CONFIRMED claims retained; corrections folded in).

## A. Webhook ingress and routing

- A1: CONFIRMED — mount+handler `events.ts:37-76` (headers 400 :51-54, HMAC 401 :57-61, ack 200 :64, fire-and-forget :66-73); `verifyWebhookSignature` `webhooks.ts:27-35`; mount gated `src/index.ts:231-233`.
- A2: CONFIRMED — `GitHubEventContext` `webhooks.ts:44-54` (no `issueNumber`); `prNumber` only under `issue?.pull_request` `webhooks.ts:97-104`.
- A3: CONFIRMED — no `issues` case in `formatGitHubContext` (`webhooks.ts:59-141`).
- A4: CONFIRMED — `InternalRouteAction` :360; `determineRouteAction` :365; `issue_comment created → existing_task` :378-380; `issues → default: noop` :412-413; `GitHubRouteResult` :346-355.
- A5: CONFIRMED — self-filter `webhooks.ts:444-451` (machine exemption :445-448); `issue_comment` PR fallback :458-460; `check_suite` fallback :464-466 (uncited but present); discard :470.
- A6: CONFIRMED — :420-423; `if (ourBotUsername && …)` :449 — null slug disables filter entirely.
- A7: CONFIRMED — dispatch `events.ts:131-139`; `handleExistingTaskDirect` `events.ts:267`.
- A8: CONFIRMED — `events.ts:302-303`; `formatGitHubEvent` `webhooks.ts:226-227`.
- A9: CONFIRMED (substance) / WRONG (path) — dedup `events.ts:273-300`; `findBranchStateByPR` at `src/connectors/github/branch-state.ts:47` (NOT src/tasks/); `last_processed_comment_id` on `BranchState` (`types/task.ts:170`) + legacy `RepositoryInfo` (:240) only.
- A10: CONFIRMED with caveats — 5s :260-261, 20s :298-299; missed `CARD_REFRESH_DEBOUNCE_MS = 2500` (`events.ts:149-150`) and `DAILY_FIRE_CAP = 200` on trigger-fired creation (`trigger-scheduler.ts:27, 357-361`).

## B. Task creation, channels, PM delivery

- B1: CONFIRMED with correction — `Task.create()` `task.ts:184-221`, metadata :200-211. Exactly 3 call sites (slack/events.ts:775, routes.ts:183, trigger-scheduler.ts:363); "CLI launcher" is not distinct (CLI uses POST /tasks).
- B2: CONFIRMED — `slack/events.ts:775-787`; `routes.ts:183-186`; `linkCliChannel` `task.ts:412-413`.
- B3: PARTIAL, one WRONG element — `fireTrigger` :336, `Task.create()` :363 confirmed. WRONG: task.ts:882-region method is `linkSlackThread(channelId, threadTs, channelName)` (`task.ts:887-902`), not a channel-less knowledge-append; `fireTrigger` appends nothing to knowledge.log, seeds PM via `sendMessage(AGENT_PROMPTS.triggered(seed, reason))` (:385; `prompts.ts:26`); schedule fires create channel-less tasks.
- B4: CONFIRMED — `prompts.ts:10-11` verbatim.
- B5: CONFIRMED — `ChannelType` `types/task.ts:89`; `GitHubChannel` :121-125; union :135; never constructed (zero `type: 'github'` writes); consumers `lifecycle.ts:377-383` (`/pull/` :381), `spawn.ts:309`.
- B6: CONFIRMED — warn :451; slack :454; cli :457; github falls to `return null` :460, no warn.
- B7: CONFIRMED — `resolveSlackChannel` :621; `reactToMessage` :842 / `unreactFromMessage` :856 warn-no-op; `ackMessage` :589-591 silent; `postInteractiveToUser` :566-575 log-line fallback.
- B8: CONFIRMED with nuance — `findTaskByPRNumber` `persistence.ts:582-619`; `findTaskByThread` :559-573 (in-memory first :561-566); pure-fs scan via `scanMetadataFiles` :535-553 (shell grep was previous impl per comment :530-533).
- B9: CONFIRMED — `persistence.ts:477-496`.

## C. GitHub client

- C1: CONFIRMED — `addPRComment` `client.ts:625-637` (issues endpoint :629); `getPRComments` :757-773.
- C2: CONFIRMED — no reaction/permission/collaborator helpers (sole "permission" word is a code-scanning doc comment :1028).
- C3: CONFIRMED — `client.ts:262-267`; `createGitHubClient` :1176-1203; singleton :1257-1264.

## D. Plugin→repo coverage

- D1: CONFIRMED — `plugin-loader.ts:293-345`.
- D2: CONFIRMED — `registry.ts:171-173`; no production callers.
- D3: WRONG — `findAgentDefsContainingRepo` EXISTS: `registry.ts:181-185` (commit 4dc039c, ancestor of 3ed6ba4); callers `tools.ts:2525, 2579`, `registry.ts:199`; tests `dynamic-agent.test.ts:85+`. The brief was right; the dossier's "correction" was the error.
- D4: PARTIAL, second half WRONG — startup clone confirmed (`index.ts:119-129`, `workdir.ts:127-136`); but undeclared repos ARE reachable: `spawn_repo_agent` dynamic agents (`tools.ts:2540+`, `synthesizeDynamicAgentDef` :2618) + `ensureBaseCache` lazy clone (`repo-clone.ts:78-110`).

## E. Readonly / edit mode

- E1: CONFIRMED — gate `spawn.ts:381`; RO disallow list :493-510 (`push_branch` :498, `create_pull_request` :499, `add_pr_comment` :501); sandbox :514-525.
- E2: CONFIRMED with nuance — `tools.ts:596, 664, 671`; non-Slack fallback log `task.ts:573-575`; task still pauses. Nuance: `approval:requested` emitted on event bus (`task.ts:559-564`) — API/SSE observers can still approve; silent-hang holds for GitHub-born tasks with no CLI attached.
- E3: CONFIRMED — `request_max_mode` `tools.ts:679, 747, 754`; third defer-stop `tools.ts:1793-1814`; the `:2327` postInteractive does not defer-stop.
- E4: CONFIRMED — no auth middleware (`routes.ts:35`); `POST /tasks/:id/approve` :221-328, edit_mode → `handleEditModeApproval(cleanApprover)` :274-276, any task, no origin check; mounted :450; `server.listen(config.port, resolve)` no host arg `src/index.ts:264`.
- E5: RESOLVED — `handleEditModeApproval(approver?)` `task.ts:1199-1243`: clears PM teardown :1208; `edit_allowed = true` unconditionally :1209; `edit_approved_by` first-wins when passed :1215-1217; sync save :1221; restarts repo agents :1231-1238; approval finding :1240-1241. Approver-less POST still flips the flag. No origin/participant guard.
- E6: CONFIRMED — PRs #198/#191 merged 2026-07-08; mechanics `task.ts:1223-1238`.

## F. Security model and conventions

- F1: CONFIRMED — `security.md:23` (:21 section); guardrails/defense-tags web-only :126-162; not-implemented list :336-341.
- F2: CONFIRMED, cites drifted — redaction `persistence.ts:246-247` (region :235-310); `isExternalUser` gating `slack/events.ts:259, 555, 674, 874, 957, 978`.
- F3: CONFIRMED — `spawn.ts:501`; `merge.ts` zero comment-posting.
- F4: CONFIRMED, one stale example — 31 matches in `prompts/pm-agent.md` (:1, :119, :121-122, :336, :339); `target.new_dm` no longer appears in pm-agent.md (only tools.ts:710 error string).
- F5: CONFIRMED — `package.json:13`; no eslint config anywhere; vitest `package.json:25`.
- F6: CONFIRMED — `index.ts:68-70`; `validateMasterKey()` :102-105.

## G. Tests

- G1: WRONG (one element) — include is `['src/**/*.test.ts', 'tools/**/*.test.ts']` (`vitest.config.ts:6`); rest confirmed.
- G2: WRONG — three files (branch-naming, merge, mergeability); narrower conclusion survives: router/dispatch/client untested.
- G3: CONFIRMED — `pr-tools.test.ts` mocks :24/:34/:42/:50/:61; `makeAgent` :91; `makeTask` :111.
- G4: CONFIRMED + stronger precedent — no supertest/HTTP tests; `src/connectors/__tests__/merge-approval-surfaces.test.ts:113-126` invokes `mountApiRoutes` on a fake app and calls extracted Router layers; `persistence.test.ts:39` mocks SESSIONS_DIR.
- G5: CONFIRMED, attribution fixed — harness `tools/e2e` + `tools/debug-mcp` (`list_tasks` server.ts:70, `get_log` :137, `wait_for_task` :205); e2e PRs are #178/#182 (#183/#185/#194 are forge-skill PRs).

## H. External facts

- H1: ACCEPTED (recently verified; code consistent `webhooks.ts:100`).
- H2: ACCEPTED.
- H3: CONFIRMED (re-fetched) — endpoints + 8 content values + Issues-write, no dedicated reactions permission.
- H4: CONFIRMED (re-fetched) — maintain→write, triage→read verbatim; `role_name` + `user.permissions`; Metadata read.
- H5: ACCEPTED.
- H6: CONFIRMED (source-fetched) — regex + `i` flag; admin|write gate via `getCollaboratorPermissionLevel`.
- H7: ACCEPTED.

## I. Prior art

- I1: CONFIRMED except one detail — proposal exists (55 lines, design-only, PR-creator-only authz :21, `created_from` :49, dead doc link :55); WRONG detail: no "Slack cross-post" in it (only "cross-platform continuity" :34).
- I2: CONFIRMED — #206 merged 2026-07-10; #198/#191 merged 2026-07-08; e2e per G5.
- I3: CONFIRMED — #203/#201/#202/#150 open, characterizations fair.
- I4: CONFIRMED — 8 open PRs, none touches `src/connectors/github/`; #173/#70/#29 touch task.ts+types/task.ts.
- I5: CONFIRMED — #200 open, 0 comments, 0 cross-references.

## J. Corrections to the brief

- J1: WRONG (inherits D3) — must be retracted; brief was right.
- J2: CONFIRMED.
- J3: CONFIRMED.
- J4: CONFIRMED.
- J5: CONFIRMED — reinforced by E4/E5.

## Material corrections (substance, not just lines)

1. D3+J1 — `findAgentDefsContainingRepo` exists; AC9 coverage check is not new code; dossier's brief-correction reverted.
2. D4 — undeclared repos reachable at runtime (dynamic agents + `ensureBaseCache` lazy clone); only startup pre-warm + plugin-defined agents absent.
3. B3 — `linkSlackThread` (not channel-less append); `fireTrigger` seeds PM via `AGENT_PROMPTS.triggered`, appends nothing to knowledge.log; schedule fires are channel-less.
4. A9 — `findBranchStateByPR` at `src/connectors/github/branch-state.ts:47`.
5. A10 — missed throttles: `CARD_REFRESH_DEBOUNCE_MS=2500`; `DAILY_FIRE_CAP=200` (task-creation cap precedent).
6. G2 — three github test files.
7. G1 — vitest include covers `tools/**`.
8. B1 — exactly 3 `Task.create()` call sites.
9. I1 — old proposal has no Slack cross-post.
10. E5 — resolved: `edit_approved_by` recorded first-wins, `edit_allowed` flipped unconditionally, no origin guard.
11. F4 — `target.new_dm` gone from pm-agent.md.
12. G5 — e2e harness PRs are #178/#182.
