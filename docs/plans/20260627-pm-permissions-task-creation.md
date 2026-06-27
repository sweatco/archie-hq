# PM permissions & task-creation rework

## Context

Three PM abilities have proven to be bad ideas in practice and should be removed: opening **new task-linked threads** in arbitrary channels, **opening DMs** with users, and **launching headless background tasks**. They fragment conversations and sever the trace back to the original request.

In their place the PM should be able to **explore Slack read-only** (recent channel history, specific threads) and **post messages to channels/threads** — but those posts must be **decoupled from tasks**. A post does not create or extend a task. A task is created only when:

- someone **@mentions** the bot (top-level or in-thread) — unchanged, **or**
- someone **replies to a thread the PM itself started** (the thread's root message is the bot's), **or**
- someone **DMs the bot** — unchanged.

A PM reply *inside an existing human-started thread* never creates a task, even if others reply afterwards. Inbound DMs stay fully working; only the PM's ability to *open* a DM is removed.

**Net intent:** the PM becomes a transparent participant that lives in channels, can look around and chime in freely, and only spins up work when a human actually engages with something it started or addresses it directly.

## Scope decisions (updated per user direction)

- **Read/search → PUBLIC channels Archie was added to, bot token only.** Decided: no user token, no service account, and **never read or search private channels** (even when the request originates from a public channel). Reads (`conversations.history`/`replies`) are member-gated by Slack AND pre-checked with `conversations.info` → refuse if `is_private`/`is_im`/`is_mpim` (`PrivateChannelError`). Search uses `search.messages` on the bot token with **only** `search:read.public` (no `search:read.private`), so results are public + Archie's channels; private/DM matches are also filtered defensively. NOT the AI/sidebar `assistant.search.context` API. Adding the search scope requires a **Slack app reinstall**; reads work immediately.
- **Write → channels Archie was invited to, bot token.** `post_to_channel` is member-gated by Slack (`not_in_channel` otherwise). (Not private-gated — posting into a private channel Archie was added to doesn't expose private content; the privacy concern is about *reading*.)
- **Task ingestion is a separate path.** `fetchSlackThread` (used when a task is created/continued) is NOT private-gated — a task may legitimately live in a private channel Archie was @mentioned into. Only the *explore* read/search tools are public-only.
- **Explore tools do NOT filter bot messages.** `read_channel_history`/`read_thread`/`search_messages` show everything, including Archie's and other bots' posts (full picture for exploration).
- **Dead code → DELETED** (not left dormant); git history is the safety net.
- **Inbound DMs → UNCHANGED.** Only outbound DM-opening (`new_dm`) is removed.

---

## Engine changes — `archie-hq`

### 1. Detect "did the bot start this thread?" — `src/types/task.ts`, `src/connectors/slack/client.ts`

Simplified per user direction — **keep the bot's root message instead of preserving it separately:**

- Add ONLY `rootAuthorWasBot: boolean` to the `SlackThread` interface (`types/task.ts:73-79`). No `rootBotText`.
- In `fetchSlackThread` (`client.ts:1157`), compute `rootAuthorWasBot` from `rawMessages[0]` before filtering: `!!root && (root.user === botUserId || root.botId === botId)`.
- **Change the `visibleMessages` filter to keep index 0 when it's our bot** (`client.ts:1175-1186`). Every other bot message is still filtered as today. This means the bot's originating post survives into `thread.messages`, so `task.append` seeds the task with full context and the title generator sees it — **no `appendBotRootContext`, no title special-casing needed.** (Existing flows are unaffected: normal task threads are rooted by a human, so nothing changes there.)

### 2. Router / task creation — `src/connectors/slack/events.ts`

`handleSlackEvent` (~452-499). `thread` is already fetched at line 417. Change only the new-task condition:

```
} else if (event.type === 'app_mention' || event.channel.startsWith('D') || thread.rootAuthorWasBot) {
```

Inside that branch nothing special is needed for context — because `fetchSlackThread` now keeps the bot root, `task.append(thread)` already seeds the originating post. Just create/append/ack/title/`sendMessage(newTask)` as for any new task.

- **Ack:** `isAckable` (line 412) is computed before the thread fetch. Add a post-fetch `addReaction` + `task.ackMessage` for the `!taskId && thread.rootAuthorWasBot` case so a reply to Archie still gets the `:eyes:` ack.
- **No other branch changes.** Existing-task append, DM, @mention, and the final ignore all stay. `handleSlackEdit` is untouched (it only acts on threads that already have a task — `events.ts:537` — so it can never create one).

### 3. Context preservation — NONE NEEDED

Dropped. Keeping the bot root in `fetchSlackThread` (§1) preserves context for both the knowledge log and title generation automatically. No new persistence helper.

### 4. Explore/post tools (bot token only) — `client.ts`, `tools.ts`, `spawn.ts`, manifest

**Manifest** (`slack-manifest.yaml`): add bot scope `search:read.public` ONLY (no `search:read.private` — private channels are never searched). (Reinstall required to grant; reads need no new scope.) No user scopes, no `SLACK_USER_TOKEN`.

**Read/search helpers in `client.ts`** (bot client; **public channels only**; **no bot-message filtering** — show everything):
- `assertPublicChannel(channelId)`: `conversations.info` → throws `PrivateChannelError` if `is_private`/`is_im`/`is_mpim`. Read tools call this FIRST (before any history fetch), so private content is never read into memory.
- `fetchChannelHistory(channelId, limit?)`: assert-public, then `conversations.history` (newest-first → reverse to chronological).
- `fetchExploreThread(channelId, threadTs)`: assert-public, then `conversations.replies`, no filter (distinct from `fetchSlackThread`, which is task-ingestion and filters bot chatter except the root).
- `searchSlackMessages(query, count?)`: bot `search.messages`; `search:read.public` already limits to public — we also drop `is_private`/`is_im`/`is_mpim` (+ `D…` id) matches defensively.
- **Refactor:** factored the post-fetch extraction in `fetchThreadHistory` into a shared `resolveRawMessages(messages, channel)` (reused by replies + history); factored author-resolution+mapping into `resolveAuthorsAndMap`.

**Four PM tools in the existing `comms-tools` server** (`createCommsMcpServer`, `tools.ts:1721`):
  - `read_channel_history(channel, limit?)` — bot client, public only; `limit` 1–100 (default 30), chronological. `PrivateChannelError` → "private channel — off-limits"; `not_in_channel` → "invite Archie first".
  - `read_thread(channel, thread_ts)` — bot client, public only; parent ts + replies.
  - `search_messages(query, count?)` — bot client; `count` 1–20 (Slack's search cap); `not_allowed_token_type`/`missing_scope` → "reinstall with search:read.public".
  - `post_to_channel(channel, message, thread_ts?)` — bot client via `postSlackMessage` directly (does NOT register a channel in `task.metadata`); return the posted `ts`; `not_in_channel`/`channel_not_found` → "invite Archie first"; route `SlackMarkdownLimitError` through `formatSlackSendError`. (Member-gated; not private-gated — posting doesn't expose private content.)
- All four **reject DMs**: read/post reject `D…` (DM channel) and `U…`/`W…` (user-id-as-channel, which Slack coerces into a DM); search filters DM matches out of results.
- Add the four `mcp__comms-tools__*` names to the PM's `allowedTools` in `spawn.ts`.

**Design notes — from reviewing the official Slack MCP tool set (this session):**
- **Search power lives in the query string.** Document Slack's modifiers in the `search_messages` description so the PM uses them: `in:#channel`, `from:@user`, `before:/after:/on:YYYY-MM-DD`, `is:thread`, `has:link`, `"exact phrase"`, `-exclude`, `*` wildcard. Result count is capped (~20) — surface that.
- **Read shape:** `limit` + chronological is the core; `oldest/latest/cursor` pagination is a clean follow-on, not in v1.
- **DMs:** the official tools deliberately *allow* DMs by passing a `user_id` as the channel — we do the opposite (the `D/U/W` guard + search DM-filter).
- **Search API choice:** `search.messages` with the bot scope `search:read.public` (public only) — NOT the `assistant.search.context` Real-time Search API, which is for the AI-assistant sidebar context panel and needs a per-event `action_token`.
- **Why native, not the session's MCP server:** those Slack tools belong to the Claude Code session, not the Archie runtime — Archie can't borrow them.

### 5. Remove `new_dm` / `new_thread` (keep default + existing-channel targets)

- `PostTarget` interface (`task.ts:17-24`): drop `new_dm` and `new_thread`.
- `postToUser` (`task.ts:340-403`): delete the `new_dm` and `new_thread` branches; keep default-channel and `target.channel` (these carry inbound-DM replies).
- `post_to_user` tool schema + description (`tools.ts:323-364`): remove both targets and their guidance.
- Delete `openDMChannel` (`client.ts:1431`) — its only caller was the `new_dm` branch.
- Reword strings that still mention the removed targets: `post_files_to_user` description + empty-channel message (`tools.ts:371,380-381`), `request_edit_mode` guidance (`tools.ts:519`), and `post_to_user`'s own empty-channel message (`tools.ts:345-348`). (`post_files_to_user` already never supported these targets — `task.ts:413` — so this is text-only.)

### 6. Remove `launch_task` (headless tasks) — full surface

- Delete `createLaunchTaskTool` (`tools.ts:765-791`) and its entry in `createOrchestrationMcpServer` (`tools.ts:1888`).
- Delete `src/tasks/launch.ts` and `appendLaunchMessage` (`persistence.ts:520-539`).
- Remove the `launch_task` case in `activity.ts:206`.
- Update the PM system-prompt context line in `spawn.ts` (~280-282) that references `new_thread`/`launch_task`.
- (Channel-less tasks were only ever produced by `launch_task`; every remaining seed path links a channel, so the defensive no-channel guards in `report_completion`/`post_to_user` stay but never wrongly fire. `recovery.ts` makes no channel assumption.)

---

## PM guidance — `archie-hq/prompts/pm-agent.md` (engine repo, NOT the plugin overlay)

Rewrite the communication sections to the new model. Specific edits:

- **§3 "Stay in one place"** (lines 53-57): drop the `new_dm`/`new_thread`/`launch_task` references. Replace with: the task lives where it was created; reply there; to involve someone, `@mention` them in that thread.
- **Available Tools / post_to_user** (lines 109-116): remove `target.new_dm`/`target.new_thread` bullets; keep default + `target.channel`. Fix the "Use before sending DMs / posting to new threads" lines on `find_slack_user`/`find_slack_channel`.
- **Task Management Tools** (lines 129-131): delete the `launch_task` entry.
- **Cross-Channel Communication** (lines 146-153): delete (its whole premise was opening linked DMs/threads).
- **Add a new "Exploring Slack" section**: the PM can `read_channel_history` / `read_thread` to understand what's happening, and `post_to_channel` to chime in anywhere it's a member — **but these are read/observe/post only; they do not create or join a task**. State the task-creation model plainly: *a message you post never creates a task by itself; a task is born only when a human replies to a thread you started, @mentions you, or DMs you; a reply inside someone else's thread you merely posted into never becomes a task.* Note DMs can no longer be opened by the PM (inbound DMs still work).
- Leave the §59 reactions block and mute guidance, adjusting only stale DM-opening wording.

---

## Plugin edits — `archie-plugins` (minimal; only stale tool references)

- `ops/references/brand-managers.md:64`: routing-table row names `post_to_user(target.new_dm, <user_id>)` — remove/replace that DM row (the campaign skills already mandate staying in-thread).
- `pm/skills/ops-campaign-create/SKILL.md:106`: "Post a short note in the rep's **DM thread**" → "in the **original thread**" (the surrounding skill already forbids DMs; this line contradicts it).
- No change needed: `app-stability-report` ("in a DM" is a still-valid inbound scenario), and the ops `campaign-creation`/`campaign-edit` bodies ("don't open DMs, don't launch tasks — you don't have those tools") remain accurate for specialist agents.

---

## Tests

Runner: **Vitest** — `npm test` (all), `npx vitest run <file>` (one), `npm run test:watch`.

**Update:**
- `src/agents/__tests__/tool-contract.test.ts`: add `read_channel_history`, `read_thread`, `post_to_channel` to `PM_COMMS_TOOLS`; remove `launch_task` from `PM_ORCHESTRATION_TOOLS` (it asserts exact per-server sets against `spawn.ts`).
- `src/agents/__tests__/activity.test.ts`: remove the `launch_task` assertion (line 150); add one only if `post_to_channel` gets an activity phrase.

**Add:**
- Extract the root detection into a pure helper `computeRoot(rawMessages, botUserId, botId)` and table-test it: bot-user root, bot-`botId` root, human root, internal-other-bot root, external-bot root, empty array, files-only bot root (empty text).
- `fetchChannelHistory`: mock `conversations.history` + `users.info`; assert chronological order, bot/external filter parity with `fetchSlackThread`, mention resolution, file/reaction extraction (mirror `persistence.test.ts` mocking).
- `appendBotRootContext`: render-shape test (author line + `msg:<ts>` + body; no-op on empty text).
- `post_to_channel`: `D`-id rejection, success returns ts, `not_in_channel` guidance, markdown-limit path.
- Optionally extract the new-task predicate from `handleSlackEvent` into a pure helper and table-test {app_mention, DM, rootAuthorWasBot, existing-task} → {create, append, ignore}.

---

## Verification

1. `npm run typecheck` — then grep `new_dm`/`new_thread`/`launch_task` across `src` to confirm no stragglers.
2. `npm run build`.
3. `npm test` — all green, with the contract/activity updates and new tests.
4. **Behavioral (Slack dry-run or a test workspace):**
   - PM `post_to_channel` top-level into a test channel → human reply → **a task is created**, and its knowledge log / title include the PM's original post.
   - PM `post_to_channel` as a reply inside a human-started thread → another human reply → **no task**.
   - @mention (top-level and in-thread) → task. Inbound DM → task, PM replies in the DM. (regression)
   - Confirm `post_to_user` no longer accepts `new_dm`/`new_thread`, and `launch_task` is gone (covered by the contract test).
   - `read_channel_history` / `read_thread` return chronological, mention-resolved, bot/external-filtered messages; all explore/post tools reject `D…` ids.

## Commit & push

Two repos, both on `claude/pm-permissions-task-creation-gzif33`. Group commits logically (engine removals, engine explore/post + router, prompt, plugin fixes). Push with `git push -u origin claude/pm-permissions-task-creation-gzif33` (retry w/ backoff on network errors). No PR unless requested.
