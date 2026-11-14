# Documentation filing and module maps

ID: 2026-11-11-documentation-filing-and-module-maps-9af6d1
Created: 2026-11-11T18:50:07+00:00

Status: Completed documentation reorganization, prepared for draft review. Created 2026-11-11; updated 2026-11-13. Initial audit baseline: `4242842`; refreshed implementation baseline: `6a689e1` from freshly fetched `origin/main`. The user requested the audit and applied reorganization, then authorized rebasing, committing and opening a draft PR on 2026-11-13. Deployment remains outside this change.

## Outcome and decisions

Give a maintainer or agent one route from a responsibility to its owning source, contracts and checks. Reuse `docs/architecture/<name>.md` and a single [module template](../architecture/_template.md); the [system map](../architecture/overview.md) is the map of modules. The [filing guide](../guides/documentation.md) owns agent-facing placement and lifecycle rules, linked from `AGENTS.md` and contributor guidance.

A module is a stable responsibility, not every directory. This retains focused capabilities such as edit mode and max mode, treats security as a cross-cutting map, and adds the missing API/CLI responsibility. Useful detailed explanations stay below the same five map sections. No arbitrary length limit or generated source inventory is introduced.

Historical plans and proposals remain at their existing paths, with visible status/role banners and current-owner links. This avoids mass moves and preserves external links, failed experiments and design intent. The alternative—moving every old document into a new archive—adds link repair without first improving the distinction between current contracts and historical evidence. Revisit physical archive folders only when retrieval requires them. No old document was deleted merely for age or length.

## Audit and disposition

The baseline contains 16 architecture documents, 10 guides, 52 plan records plus their index, seven proposals, four OpenSpec specifications and seven archived OpenSpec changes (78 Markdown evidence files). Coverage was structural/header inspection across those collections, detailed document reads and targeted checks of decisive claims against owning code. It was not a requirement-by-requirement requalification of every historical plan or an external-plugin/provider audit.

| Finding | Source checked | Applied disposition |
| --- | --- | --- |
| Index omits proactivity, five guides and two proposals; plan status is duplicated and incomplete | Baseline `docs/README.md` compared with the directory inventory | One complete current-doc index, complete plan/proposal indexes, one system map |
| Architecture files lack a consistent responsibility/code/contract structure | All 16 baseline architecture documents | Retain their useful detail under one template; add API/CLI and explicit bootstrap ownership |
| GitHub doc still describes repositories keyed by agent | [`merge.ts`](../../src/connectors/github/merge.ts), [`task.ts` types](../../src/types/task.ts) | Document task-owned flat attachments; remove obsolete copied implementation |
| Persistence and Slack describe a max-mode session reset | [`handleMaxModeApproval`](../../src/tasks/task.ts), [max-mode contract](../architecture/max-mode.md) | Retain the session; link its owning contract |
| Approval flow says tool descriptions are rendered | [`renderCall`](../../src/agents/tool-approval-gate.ts) | Use configured title or tool name and sanitized arguments |
| Pending trigger read is described as always refused | [`createGetTriggerTool`](../../src/agents/tools.ts) | Document proposing-task/operator access and the legacy visibility fallback |
| Task state listing omits inert preparation | [`TaskStatus`](../../src/types/task.ts), [`Task.prepare`](../../src/tasks/task.ts) | Add `preparing` and link the approved-handoff lifecycle |
| Completion plan still says unimplemented | [`task.ts`](../../src/tasks/task.ts), [`recovery.ts`](../../src/tasks/recovery.ts) | Preserve original intent and add a dated implementation correction |
| Coding adoption still says prepared for a draft PR | Current `main` contains the changes and merge history | Close implementation status; retain pending readability/operational evidence limits |
| OpenSpec merge and memory snapshots disagree with current contracts | [`isAutoMergeRepo`](../../src/agents/registry.ts), [current memory](../architecture/memory.md) | Mark snapshots as historical; link their current owners instead of deleting acceptance history |
| Security reporting and SDK guide retain peer-agent terminology/APIs | Session sandbox, `updateAgentState(boolean)`, current title/research sources | Correct task-wide isolation and source examples; preserve reporting procedure |
| OAuth text treats every wake as credential rebinding | [`applyOAuthBindings`](../../src/system/oauth/inject.ts), SDK spawn path | Distinguish spawn from messages in an existing stream; separate operator commands into a guide |

The [plan index](README.md) gives a disposition for every baseline plan. The [proposal index](../proposals/README.md) separates three unresolved/deferred/revalidation items from four historical/research records. Queue design has one short revisit summary linking the historical v4 proposal. Analytics and Forge external implementation claims remain explicitly unverified. The September reply pilots retain their failed or incomplete gates; this filing change neither approves rollout nor declares external PRs closed.

| Existing guides and root documents | Decision |
| --- | --- |
| Local development, coding guidelines, GitHub setup, cloud E2E | Keep as distinct working procedures; make each discoverable |
| Deployment and `DOCKER.md` | Keep production and local-container roles; deployment capacity and host claims require installation evidence when used |
| Bedrock setup | Keep optional-provider procedure; provider UI/pricing and effectiveness were not requalified in this review |
| SDK patterns | Keep examples linked to current source; remove deleted triage references and stale method calls |
| Flat PM migration | Keep the version-specific transition guide; a current architecture map does not replace migration history |
| Initiative operations and verification | Keep separate operation and evidence roles; do not equate simulation, delivery and usefulness |
| `README.md`, `CONTRIBUTING.md`, `AGENTS.md` | Keep distinct entry points; link canonical documentation rules and navigation rather than duplicating indexes |
| `SECURITY.md`, `CODE_OF_CONDUCT.md`, generated `CHANGELOG.md` | Keep distinct project policies/history; correct only the stale security-model summary; leave generated changelog untouched |
| Prompts, skills, examples and scoped memory instructions | Preserve behavior/instructions; link scoped constraints rather than folding them into a docs archive |

## Acceptance and verification

- Every current module map, including API/CLI and cross-cutting security, uses the same five sections and links owning source and focused checks. The overview maps all those responsibilities.
- Every current architecture doc and guide is indexed; every baseline plan/proposal has a visible disposition and route to current documentation.
- Known contradictory claims above are corrected against the baseline source. Historical intent, negative results and unique operational rationale remain available.
- Current-document relative links, affected heading anchors, linked source paths, template sections and the diff are checked. Existing historical link debt is reported separately; this change does not silently rewrite every archived source reference.
- Changes remain documentation-only, with no application behavior, dependency, CI, runtime configuration or generated-changelog edits. No application tests are added for prose.

Executed on 2026-11-11: checked 17 maps against the five-section template; verified complete indexes; scanned 835 local Markdown links and heading targets; checked all 16 focused-test command target sets; verified the historical plan bodies remain unchanged except for the two explicit status corrections and filing banners; confirmed archived OpenSpec evidence is unchanged. One new heading link and one test-path typo were found and corrected. Final link/source-target, formatting and whitespace results are recorded below.

The scan retains 179 pre-existing missing relative path targets in historical plans, excluding one illustrative placeholder. Current documentation and newly added links have no missing targets. External links, every historical requirement, live Slack, provider consent, deployment behavior and measured agent navigation benefit were not requalified. No application tests ran: the diff changes prose and navigation only.

## Review receipt and follow-up

Two read-only research scouts inventoried plans/proposals/OpenSpec and architecture. The main review covered guides, root instructions, indexes, source contradictions and link structure. One fresh critic reviewed the completed diff and owning source, using the inherited model. It found misattributed status/shutdown/bootstrap ownership and retained web-research/GitHub-flow contradictions. Both findings were corrected and checked at their owning source. No further review call was needed; stop reason: settled. This is three agent calls total (two research, one review), not a measurement of efficiency or cost.

On the next substantive module change, use the map to locate the state owner and relevant test without reading historical plans. Record confusing boundaries or duplicated facts in that change; this reorganization alone does not establish faster agent work. The intended filing and navigation changes are delivered locally; their effect on future agent work remains unmeasured.

## Local checks on 2026-11-11

Passed after review corrections: all 17 architecture maps match the shared section order; all current documents and historical records are indexed; the 835-link scan reports no current/new missing paths or heading anchors; all 16 focused-test command target sets exist; Prettier 3.9.10 accepts the touched current documentation; `git diff --check` passes. Historical plan bodies are preserved except for filing banners and the two explicit status corrections; archived OpenSpec change evidence is unchanged.

The initial local diff contained 93 Markdown files and no application, dependency, runtime-configuration or generated-changelog changes. At that checkpoint, no application tests, commit, push, deployment or external application write had been performed. The initial package-name lookup could not use the offline metadata cache; formatting succeeded with the already-cached exact Prettier tarball, without installing project dependencies.

## Refresh for draft review on 2026-11-13

Rebased the branch onto freshly fetched `origin/main` at `6a689e1`, retaining the documentation edits. The newer Git workflow rules are preserved. The proactivity map now incorporates the merged extraction changes: independent per-thread application, a 6,000-character source bound, cached validated parts, a three-response retry limit for unchanged requests, deferred thread eligibility, bot-only handling, explicit review assignments and concise nudge/digest presentation. The map also identifies the existing attention-record owner of checkpoints and retry accounting. Every substantive paragraph in the current-main proactivity document is retained under the shared map structure.

The conflict was limited to placing the new nudge guidance alongside the reorganized spending and handoff sections; spending has one canonical section. Current source changes since the original baseline were reviewed. This refresh changes documentation only; it does not alter extraction behavior or requalify live delivery usefulness.

Post-rebase checks passed: all 17 maps follow the template, all current documents and historical records are indexed, the 836-link scan has no current/new missing paths or heading anchors, all 16 focused-check command target sets exist, Prettier 3.9.10 accepts the current documentation, and whitespace checks pass. Historical plan bodies remain preserved apart from the previously recorded banners and two status corrections. The 179 pre-existing historical missing targets remain outside this filing change. No application tests were run for this documentation-only diff.
