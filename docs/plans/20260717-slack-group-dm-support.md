# Slack group DM (mpim) support

Status: Implemented (this PR)

## Brief

Add support for Slack group DMs (multi-party DMs / "mpims", channel id `G…`, `is_mpim: true`) to Archie (repo `sweatco/archie-hq`). GitHub issue #215.

**Problem.** Group DMs are unsupported. On an @mention Archie adds 👀 but never replies — it reads the thread via `conversations.replies` on the `G…` channel, which needs the `mpim:history` scope the app lacks, so the call throws `missing_scope`, the error is only logged (events.ts ~145), and task creation (events.ts ~775) never runs. Non-mention messages never arrive because the app does not subscribe to `message.mpim`. History: PR #66 added `message.mpim`; PR #67 removed it for lack of `mpim:history` — this closes the gap as a complete unit.

**Goal.** Support group DMs end-to-end, treating a group DM as CHANNEL-LIKE, NOT DM-like. An @mention creates a task and Archie replies in-thread; once engaged in a thread, member replies route to that task with no re-mention; ambient non-mention messages are IGNORED; group DMs get the same channel extras as real channels (canvas scan, shared detection, ambient status) where Slack supports them.

**Why this differs from the issue.** Issue #215 step 3 proposed treating `G…` like 1:1 DMs (every message an implicit mention). The user overrides that: a group DM has multiple people and not every message is for Archie, so it behaves like a channel where only an @mention (or a reply in an already-engaged thread) engages Archie. Research confirms the code ALREADY treats `G…` as channel-like — every DM-specific branch keys strictly off the `D` prefix (task-routing.ts:24 `shouldCreateNewTask`; events.ts:167 `isDm`; :690 `isAckable`; :744 mute-unmute; :788 ambient handler; :625 `setAssistantThreadTitle`). So this design is mostly unlocked by the Slack scope/event change plus tests that lock the behavior in.

**Non-goals (binding on reviewers).** Do NOT treat group DMs like 1:1 DMs — ambient non-mention messages must not create tasks or count as implicit mentions. Do NOT add `G` to any `D`-prefix guard (`isDm`/`isAckable`/mute-unmute/`setAssistantThreadTitle`) — those stay D-only. Do NOT unblock `post_to_channel` for mpims — the explore-tool refusal of mpims (`assertPostableChannel`/`DmPostError`/`PrivateChannelError`, PR #130) stays and its tests must stay green. No 1:1-DM assistant-pane title (`setAssistantThreadTitle`) for group DMs. No persisted-state migration (`task.metadata.channels` keys `slack:<channel>:<thread>` already accept `G…`).

**Constraints.** The external/guest-author bail-out (events.ts:671, `isExternalUser`) must still run on the `message.mpim` path. Redaction posture (`append()` redacts external authors when `thread.shared`) must be no worse than private channels; `isChannelShared` must be able to call `conversations.info` for `G…` (`mpim:read`). Use the unified logger only; never hard-wrap prose; do NOT touch `CHANGELOG.md` (auto-generated).

**Affected repo:** `sweatco/archie-hq` only. **Risk class:** low–moderate (host connector; main risks are the mpim trust/redaction posture and not lumping `G` with `D`).

## Acceptance criteria

| AC | Criterion | Method |
|----|-----------|--------|
| AC1 | WHEN an app_mention event is received on a group-DM channel (`G…`, is_mpim: true), THEN it is classified as task-creating exactly like a channel @mention (a new task is created) AND the triggering message receives the 👀 ack. | unit |
| AC2 | WHEN a non-mention `message.mpim` event arrives as a reply inside a group-DM thread that already has an engaged task, THEN it is forwarded for handling and routed to that existing task — no new task, no re-mention required. | unit |
| AC3 | WHEN a non-mention top-level `message.mpim` event arrives in a group DM with no engaged task and no watching trigger, THEN no task is created and it is not treated as an implicit mention — the group DM behaves like a channel, not a 1:1 DM. | unit |
| AC4 | WHEN an app_mention or `message.mpim` event in a group DM is authored by an external or guest user, THEN the existing external-author bail-out skips it (no task, no reaction, no log), so the mpim path is no weaker than other conversation types. | integration |
| AC5 | `slack-manifest.yaml` declares the bot scopes `mpim:history` and `mpim:read` and subscribes to the `message.mpim` bot event. | unit |
| AC6 | WHEN a group-DM (mpim) event is processed, THEN the channel-context machinery is not short-circuited the way it is for 1:1 DMs: `ensureChannelCanvas`, `isChannelShared`, and ambient status run for `G…` ids — with the understood caveat that Slack disallows canvas tabs in mpims, so the canvas scan is a no-op there rather than an error. | unit |
| AC7 | WHEN the manifest has been re-imported and the app reinstalled, AND a user @mentions Archie in a real Slack group DM, THEN Archie reads the thread with no `missing_scope` on `conversations.replies` for the `G…` channel and replies in-thread; AND a subsequent non-mention reply in that thread is handled without a re-mention. | deploy-only |

## Design

### Approach

The behavior is almost entirely already implemented in the code — every DM-specific branch keys strictly off the `D` prefix, so a group-DM `G…` id is already handled channel-like everywhere. The gap is (a) the Slack manifest doesn't grant the scopes or subscribe to the event that would let `G…` events flow, and (b) the message-filter/forward decision is inline in the Bolt handler and therefore not unit-testable. So the change is: **unlock the scopes/event in the manifest**, **extract the existing filter logic into pure, behavior-preserving helpers** so AC1/AC2/AC3 become unit-testable, and **lock the whole thing in with tests**. No behavioral branch is added for `G` and no `G` is added to any `D`-prefix guard.

### Source changes (3 files, all small)

1. **`slack-manifest.yaml`** — add bot scopes `mpim:history` and `mpim:read` among the existing history/read scopes, and add `message.mpim` to `bot_events`. This is the whole runtime unlock: `mpim:history` scopes `conversations.replies`/`conversations.history` on `G…` and enables the `message.mpim` event; `mpim:read` scopes `conversations.info` on `G…` (needed by `getChannelInfo`, `isChannelShared`, `getChannelCanvasTabs`). Posting/reacting need no new scope. Satisfies AC5, is the precondition for AC7.

2. **`src/connectors/slack/task-routing.ts`** — add two dependency-free pure helpers next to the existing `shouldCreateNewTask` (which already needs no change — `app_mention` returns true for any channel):
   - `isAckableEvent(eventType, channelId)` = `eventType === 'app_mention' || channelId.startsWith('D')` — verbatim extraction of the `isAckable` expression at events.ts:690. For a `G…` app_mention it is true via the `app_mention` arm, NOT via the prefix — so the D-only posture is preserved and a non-mention `G…` message is correctly NOT ackable.
   - `shouldForwardMessageEvent(event, hasWatchingTrigger)` — verbatim extraction of the inline filter at events.ts:167-180. Returns true when `type==='message'` AND subtype is empty/`file_share`/`thread_broadcast` AND (`isThreadReply || isDm || watchedByTrigger`), where `isDm = channel.startsWith('D')`. `hasWatchingTrigger` is passed as a **lazy predicate** `(channel) => boolean` so the trigger-index lookup still only runs for top-level channel posts (no new lookups for DMs/thread-replies) — behavior identical for channels and DMs.

3. **`src/connectors/slack/events.ts`** — refactor the `app.event('message')` handler to early-return `if (!shouldForwardMessageEvent(event, (ch) => getChannelMessageTriggers(ch).length > 0)) return;`, keeping the existing mention-skip guard (line 185, `!isDm && text includes bot mention → return`) and everything downstream unchanged. Replace the inline `isAckable` expression at line 690 with `isAckableEvent(event.type, event.channel)`. Export `handleSlackEvent` so AC4's integration test can drive it (mirrors the existing `registerMergeActionHandlers` export used by `merge-approval-surfaces.test.ts`). Net behavior change for channels and DMs: none.

### Why no other source changes

- **AC6** needs `ensureChannelCanvas`, `isChannelShared`, `getChannelCanvasTabs` to run for `G…`. All three already early-return only on `'D'`, so a `G…` id already flows through to `conversations.info` (now scoped by `mpim:read`) and returns no canvas tabs — a no-op, not an error — exactly as required. No code change; tests confirm.
- **AC4** external-author bail-out (`handleSlackEvent` line 671, `isExternalUser`) is channel-type-agnostic (keys only off `event.user`) and sits ahead of ack/fetch/`Task.create`. The `message.mpim` path is the identical `handleSlackEvent`, so the bail already runs for `G…`. No code change; test confirms.
- **Non-goals honored**: `isDmOrUserId` (`/^[DUW]/`), `assertPostableChannel`/`DmPostError`/`assertAccessibleChannel` (explore/post refusal of mpims, PR #130), `setAssistantThreadTitle` D-guard (events.ts:625), and mute/unmute D-guard (744) are all left untouched. No `G` is added to any of them.

### How each flow resolves for `G…` (is_mpim: true)

- **@mention** → `app_mention` handler → `handleSlackEvent` → `isAckableEvent`=true (👀) → `fetchSlackThread` (`conversations.replies`, now scoped) → `shouldCreateNewTask('app_mention',…)`=true → `Task.create` → reply via `postSlackMessage` (no channel-type guard). AC1.
- **Non-mention reply in engaged thread** → `message.mpim` → `message` handler → `shouldForwardMessageEvent` true (isThreadReply) → `handleSlackEvent` → `findTaskByThread` routes to the engaged task, appends, replies — no new task, no re-mention. AC2.
- **Ambient top-level non-mention** → `message.mpim` → `shouldForwardMessageEvent`: isDm=false (G≠D), isThreadReply=false, watchedByTrigger=false (no trigger) → not forwarded → ignored. Channel-like, not DM-like. AC3.
- **Mention-bearing `message.mpim`** → forwarded, then skipped by the line-185 mention guard (`!isDm && text has mention`), so `app_mention` is the sole processor — no double-processing.

### Error / recovery paths

`isChannelShared` fails open (returns false) on `conversations.info` error — unchanged; with `mpim:read` granted the call succeeds so shared detection is correct for `G…` (redaction posture no worse than private channels). `getChannelCanvasTabs`/`ensureChannelCanvas` swallow errors and return no tabs. The external-author classifier fails open (doesn't drop) on lookup error — unchanged.

### Trade-offs / risks

Low–moderate (host connector). Main risks called out in the brief: mpim trust/redaction posture (mitigated — bail-out and shared detection both run on the `G…` path) and not lumping `G` with `D` (mitigated — helpers are verbatim extractions with `D`-only prefix logic; a `G` app_mention is ackable/task-creating only via the `app_mention` arm). The lazy-predicate shape of `shouldForwardMessageEvent` preserves the exact trigger-lookup timing so no channel/DM behavior shifts. AC7 (scope grant + reinstall) is the only step not coverable by tests and is verified live.

## Tasks

- **T1 — Manifest: add mpim scopes + `message.mpim` event.** In `slack-manifest.yaml` add bot scopes `mpim:history` and `mpim:read` among the existing history/read scopes (e.g. after `im:read`), and add `message.mpim` to `settings.event_subscriptions.bot_events` (alongside `message.groups`/`message.im`). Preserve YAML formatting/indentation; do not reorder unrelated entries. Tests: new `src/connectors/slack/__tests__/slack-manifest.test.ts` reads `slack-manifest.yaml` as text and asserts the bot scopes block contains `mpim:history`/`mpim:read` and `bot_events` contains `message.mpim` (AC5).
- **T2 — Extract pure `isAckableEvent` + `shouldForwardMessageEvent` helpers.** In `src/connectors/slack/task-routing.ts` add two dependency-free exports. `isAckableEvent(eventType, channelId)` returns `eventType === 'app_mention' || channelId.startsWith('D')` (verbatim of the events.ts:690 `isAckable` expression). `shouldForwardMessageEvent(event, hasWatchingTrigger)` reproduces events.ts:167-180 with `hasWatchingTrigger` as a lazy predicate so the trigger lookup runs only for top-level channel posts. Do NOT change `shouldCreateNewTask`. Add JSDoc noting these are verbatim extractions and that a `G…` app_mention is ackable/forwardable only via the app_mention/thread-reply arms, never the D prefix. Tests: extend `task-routing.test.ts` with the AC1/AC2/AC3 cases plus a `C…`-ambient regression proving channel behavior is unchanged.
- **T3 — Wire helpers into events.ts (behavior-preserving) + export `handleSlackEvent`.** Replace the inline forward condition in the `app.event('message')` handler with the early guard, keep the mention-skip/shutdown/route/handle path exactly as-is, replace the inline `isAckable` expression with `isAckableEvent(event.type, event.channel)`, and `export` `handleSlackEvent`. Do not touch any D-prefix guard or the explore/post mpim refusals. Tests: full existing suite stays green and typecheck passes — in particular `client.test.ts` `assertPostableChannel` mpim refusal and `explore-tools.test.ts` must remain green.
- **T4 — AC4 integration test: external-author bail on the mpim path.** Add `src/connectors/slack/__tests__/mpim-external-author.test.ts`. Drive the exported `handleSlackEvent` with a `G…` channel event shaped as both an app_mention and a message.mpim, authored by a user `isExternalUser` classifies external. Assert `Task.create`, `addReaction`, and thread fetch are never called — the bail at line 671 fires for `G…` exactly as for other channel types.
- **T5 — AC6 tests: `G` is not short-circuited like a 1:1 DM.** No source change. In `client.test.ts` add cases showing `isChannelShared('G_mpim')` and `getChannelCanvasTabs('G_mpim')` call `conversations.info` (not the D early-return) and return a boolean / empty-tabs with no throw; in `channel-canvas.test.ts` add a case showing `ensureChannelCanvas('G_mpim')` proceeds past the D-guard to `getChannelCanvasTabs` and completes as a no-op.

## Verification plan

- **AC1 (unit):** `task-routing.test.ts` asserts `shouldCreateNewTask('app_mention','G0ABC',false)===true` (new task on mpim @mention) and `isAckableEvent('app_mention','G0ABC')===true` (👀 ack fires via the app_mention arm, not the D prefix). Evidence: passing assertions under `npm test`.
- **AC2 (unit):** `task-routing.test.ts` asserts `shouldForwardMessageEvent({type:'message',channel:'G0ABC',ts:'2',thread_ts:'1'}, ()=>false)===true` — a non-mention reply inside an engaged mpim thread is forwarded (downstream `findTaskByThread` routes it to the existing task, no re-mention, no new task). Evidence: passing forward-decision case; the forward path into the same `handleSlackEvent` is exercised by the shared handler.
- **AC3 (unit):** `task-routing.test.ts` asserts `shouldForwardMessageEvent({type:'message',channel:'G0ABC',ts:'1'}, ()=>false)===false` (ambient top-level mpim, no watching trigger, isDm false since G≠D) and `isAckableEvent('message','G0ABC')===false`. Evidence: passing not-forwarded and not-ackable assertions.
- **AC4 (integration):** `mpim-external-author.test.ts` drives the exported `handleSlackEvent` with a `G…` channel event (both app_mention- and message.mpim-shaped) whose author is classified external; asserts `Task.create` and `addReaction` are never called (bail-out at events.ts:671 runs on the mpim path). Evidence: passing integration test with spies showing zero `Task.create` / `addReaction` invocations.
- **AC5 (unit):** `slack-manifest.test.ts` reads `slack-manifest.yaml` and asserts bot scopes include `mpim:history`/`mpim:read` and bot_events includes `message.mpim`. Evidence: passing assertions.
- **AC6 (unit):** `client.test.ts`: `isChannelShared('G_mpim')` and `getChannelCanvasTabs('G_mpim')` each invoke `conversations.info` (not the D-early-return) and return a boolean / empty-tabs with no throw; `channel-canvas.test.ts`: `ensureChannelCanvas('G_mpim')` proceeds past the D-guard to `getChannelCanvasTabs` and completes as a no-op (Slack disallows mpim canvas tabs). Evidence: passing assertions across both files showing `conversations.info` is called for the G id and the canvas scan is a no-op rather than an error.
- **AC7 (deploy-only):** After re-importing `slack-manifest.yaml` and reinstalling the app (granting `mpim:history`/`mpim:read`), boot the branch via the archie-e2e harness / live workspace: @mention Archie in a real Slack group DM and confirm the thread is read with no `missing_scope` on `conversations.replies` for the `G…` channel and Archie replies in-thread; then post a non-mention reply in that thread and confirm it is handled without a re-mention. Evidence: archie-e2e per-scenario evidence file plus live thread showing 👀 + in-thread reply on the mention, a routed follow-up reply with no re-mention, and logs with no `missing_scope` on the `G…` `conversations.replies` call.
