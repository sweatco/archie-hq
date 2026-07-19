# Tasks: memory-v2-authz

> Sections 1–8 implemented the first iteration (`access: dm` overlap grants). The 2026-07-18 policy revision (see design.md preamble) retires the dm read class; section 9 is the rework and supersedes conflicting items above. The change ships only when §9 is done.

## 1. Visibility foundation

- [x] 1.1 `ChannelVisibility` type; `SlackChannel.visibility?` + `SlackThread.visibility?` (`src/types/task.ts`)
- [x] 1.2 `getChannelVisibility` + pure `classifyConversationInfo` + shared 60s `conversations.info` cache; `isChannelShared` rides the cache, failure policies split (fail-open advisory vs fail-closed authz) (`src/connectors/slack/client.ts`)
- [x] 1.3 Stamp points: `fetchSlackThread` carries visibility; inbound restamp in `sendSharedChannelWarnings`; `registerSlackChannel(visibility?)` with `new_dm` → `'dm'` static and `new_thread` → lookup; `append()` copies/refreshes (`events.ts`, `task.ts`)
- [x] 1.4 Classification tests (`src/connectors/slack/__tests__/channel-visibility.test.ts`)

## 2. Authorization module

- [x] 2.1 `src/memory/authz.ts`: `MemoryToolsCtx`, `parseSummaryAccess`, `authorizeEpisodicRead`, `classifyTaskChannels` (pure, no paths.ts import); mirrored types in `src/memory/types.ts`
- [x] 2.2 `src/memory/__tests__/authz.test.ts`: parse fixtures matching `buildSummaryMarkdown` bytes; full decision matrix

## 3. Push path (extraction gate + ownership)

- [x] 3.1 Gate in `processExtraction`: private/ext-shared (incl. unstamped) → skip + log + `extraction-skip` telemetry (`lifecycle.ts`, `telemetry.ts`)
- [x] 3.2 `extractAuthorUsers` (source-line scan, external-redacted excluded); authors replace mentions for `allowedUserIds`, `<user_memory>` input, summary `users:` block, activity user column
- [x] 3.3 `access: org|dm` frontmatter stamp + `links.slack[].visibility`; activity `Access` column with legacy 5-column parse tolerance; `sanitizeActivityEntry` passes the class (`lifecycle.ts`, `activity.ts`, `sanitize.ts`)
- [x] 3.4 Extractor prompt: own-statements-only attribution rule + `Access:` metadata line (`prompts/memory-extractor.md`, `extractor.ts`)
- [x] 3.5 Lifecycle tests: gate (private/unstamped/ext-shared), dm extraction, mention-only user not writable, author-extraction unit tests

## 4. Pull path (tools authorization)

- [x] 4.1 `buildMemoryTools(ctx: MemoryToolsCtx)`; episodic authz on `read_task_summary` + `grep_task_log` (grant read before log open); search corpus pre-filter (author users, authorized summaries/activity); content-free policy denials; header invariant + tool descriptions updated (`tools.ts`)
- [x] 4.2 `recordPull` denied reason; `recordExtractionSkip` (`telemetry.ts`)
- [x] 4.3 Tools tests: allow org / deny dm-foreign / deny legacy / self-always / ext-shared / old-shape ctx / search scoping

## 5. Inject path + spawn

- [x] 5.1 `buildMemoryContext`: activity re-rendered filtered to org + own row (`context.ts`, `renderActivityTable` in `activity.ts`)
- [x] 5.2 Spawn: `extractTaskAuthorUsers` (gate widened to tools-or-inject), hoisted above MCP registration; exported `deriveMemoryToolsCtx`; ext-shared lockdown skips tools registration AND `enrichPromptWithMemory`, logged (`spawn.ts`)
- [x] 5.3 Tests: context activity filtering; `deriveMemoryToolsCtx` derivation (`src/agents/__tests__/memory-tools-ctx.test.ts`)

## 6. Eval aggregation

- [x] 6.1 `PullRecord.denied/denyReason`, `ExtractionSkipRecord`; `aggregatePull` denial counts (denied queries excluded from store gaps); `aggregateExtractionSkips`; report lines; wired into `scripts/memory-eval.ts`; fixtures (`tools/memory-eval/`)

## 7. Spec + docs (same change)

- [x] 7.1 Canonical spec: Purpose policy paragraph; Non-Goal replaced; glossary entries; 4 ADDED + 4 MODIFIED requirements; ejectability surface list refreshed (`openspec/specs/memory-layer/spec.md`)
- [x] 7.2 Delta mirror in `specs/memory-layer/spec.md` (this change)
- [x] 7.3 Ordering cross-reference added to `memory-v2-pull-and-eval/tasks.md` 6.2
- [x] 7.4 `docs/architecture/memory.md` + `src/memory/CLAUDE.md` invariant updated

## 8. Rollout notes (folded into memory-v2-pull-and-eval §6 as tasks 6.2 precondition + 6.25 — no separate flips here)

- [x] 8.1 6.1/6.2 proceed only with this change merged; the 6.1 store review should additionally eyeball entity pages for pre-policy private-derived facts (cleanup postponed — see design D9)
- [x] 8.2 After 6.2: watch `deniedRate`/`denyReasons`, `extraction-skip`, and `extraction-prefs-only` counts in `memory:eval` — high denial rates mean agents probe the boundary; skip counts quantify the policy's memory loss

## 9. Policy revision 2026-07-18 — DM write lockdown (supersedes §1–8 where they conflict)

- [x] 9.1 Classification: ext-shared wins for D ids — `classifyConversationInfo` evaluates ext-shared before the dm branch; `getChannelVisibility` consults `conversations.info` for D-prefixed ids (no API-free short-circuit), fail-closed `unknown` on error (9.11); `isChannelShared` drops the hardcoded `false` for D ids; `task.ts` `new_dm` stamps via lookup, not the `'dm'` literal (`client.ts`, `task.ts`) + Slack-Connect-DM test (`channel-visibility.test.ts`)
- [x] 9.2 Gate whitelist + modes: `classifyTaskChannels` returns `skip (ext-shared) | skip (unknown) | skip (private, incl. out-of-vocab/missing values) | prefs-only | full` — only `public`/`dm` recognized as non-gating; unknown-value test (`authz.ts`, `authz.test.ts`)
- [x] 9.3 Prefs-only mode in `processExtraction`: apply `user_updates` only (author-scoped as today); drop summary/activity/entity/related-tasks outputs code-side; `extraction-prefs-only` telemetry record; extractor prompt mode hint (`lifecycle.ts`, `telemetry.ts`, `prompts/memory-extractor.md`, `extractor.ts`)
- [x] 9.4 Retire `access: dm`: extraction stamps `org` only; `parseSummaryAccess` recognizes only `org` (dm/unknown ⇒ null ⇒ deny) and stops harvesting channel/user ids; delete `intersects` + overlap rule 5; drop `MemoryToolsCtx.channelIds` (+ spawn derivation of it) (`authz.ts`, `types.ts`, `lifecycle.ts`, `spawn.ts`)
- [x] 9.5 Ext-shared per-call deny in ALL four tool handlers, before self and before any corpus read, telemetry reason `ext-shared`; update the tests that currently assert entity hits for ext-shared callers (`tools.ts`, `tools.test.ts`)
- [x] 9.6 Injection: activity filter to `access === 'org'` only (own-row carve-out removed); Related Tasks selection reads org rows only (belt-and-braces for v1 leftovers) (`context.ts`, `lifecycle.ts`)
- [x] 9.7 Tests for the revision: gate matrix (public/dm/mixed/private/ext-shared/unknown/unstamped), prefs-only writes only user files, dm-stamped legacy denied even with overlap, DM caller gets full injection + tools, Slack Connect DM locks down, activity/related-tasks never show dm rows
- [x] 9.8 Re-sync canonical spec + `docs/architecture/memory.md` + `src/memory/CLAUDE.md` invariant to the revised policy (delete v1 dm-grant prose; document prefs-only mode + DM-callers-read-everything)
- [x] 9.9 Eval: `extraction-prefs-only` aggregation + report line; adjust v1 dm fixtures (`tools/memory-eval/`)
- [x] 9.10 (Optional — SKIPPED by owner decision: flag never flipped in prod, v1 dm artifacts exist in dev stores only; unreachable via read rules) one-off cleanup script: delete v1 `access: dm` summaries + dm activity rows from dev stores (never shipped to prod)
- [x] 9.11 `unknown` visibility class (review-3 codex-1): add `unknown` to `ChannelVisibility`; `getChannelVisibility` stamps `unknown` on classification error (errors uncached — restamp self-heals); spawn lockdown + injection skip trigger on `ext-shared` OR `unknown` OR legacy `isShared` (one ctx flag); gate skips with reason `unknown`; tests: API-error channel → no tools/no injection/skip(unknown), successful restamp restores or keeps lock per new class (`types.ts`, `client.ts`, `spawn.ts`, `authz.ts`, `channel-visibility.test.ts`, `memory-tools-ctx.test.ts`)
- [x] 9.12 Body framing kills authorship forgery (review-3 codex-3): `formatLogEntry` indents message-body continuation lines at append time so no body line matches the source-line shape; `AUTHOR_LINE_RE` stays line-start-anchored; legacy unframed lines still parse; tests: multi-line body mimicking `[ts] [@<UID:Name> …]` adds no author, framed lines render fine in context/grep (`src/connectors/slack/persistence.ts` or the module owning `formatLogEntry`, `lifecycle.ts` tests)
- [x] 9.13 Evidence-validated user updates (review-3 codex-4): extractor schema gains required `evidence: ["msg:<ts>", …]` per user_update + prompt instruction; lifecycle resolves each cited id to its source-line author and applies the update only when all match the target user (≥1 required), else drops + `kind: "user-update-dropped"` telemetry; eval aggregation counts drops; tests: second-hand claim citing Alice's lines for Bob → dropped, valid self-cited update → applied (`extractor.ts`, `prompts/memory-extractor.md`, `lifecycle.ts`, `telemetry.ts`, `tools/memory-eval/telemetry-agg.ts`)
- [x] 9.14 Retraction on downgraded re-completion (review-3 claude-1): skip/prefs-only paths in `processExtraction` delete `memory/tasks/<taskId>/summary.md` and remove the task's activity row when present, inside the serialized write queue; skip/prefs-only telemetry records gain `retracted: true`; tests: org-extracted task re-completes prefs-only → summary gone, activity row gone, episodic read denied `no-access-stamp`; retraction idempotent when nothing exists (`lifecycle.ts`, `activity.ts`, `telemetry.ts`, lifecycle tests)
