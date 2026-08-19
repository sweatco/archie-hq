# Slack Integration

Slack is the primary user experience layer for Archie. All human interaction flows through Slack threads, and all agent responses are delivered back to Slack. The system uses `@slack/bolt` to receive events — over HTTP webhooks by default, or in Socket Mode (outbound WebSocket, no public URL) when an app-level token is provided — and the `@slack/web-api` client to post messages.

## Connection Method

Archie supports two ways of receiving Slack events. The mode is selected at startup by which Slack credentials are present in the environment — there is no separate `SLACK_MODE` switch.

### HTTP webhook mode (default)

When only `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set, Archie uses Slack Bolt's `ExpressReceiver`. Events arrive as POST requests on `/webhooks/slack` and are verified against the signing secret.

```
# From slack-manifest.yaml
settings:
  event_subscriptions:
    request_url: https://<host>/webhooks/slack
    bot_events:
      - app_mention
      - assistant_thread_started
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: https://<host>/webhooks/slack
  socket_mode_enabled: false
```

The Bolt app is mounted by `mountSlackApp()` in `src/connectors/slack/events.ts`, which constructs an `ExpressReceiver` against an existing Express app with the Slack signing secret and the `/webhooks/slack` endpoint, then attaches a Bolt `App` to that receiver.

### Socket Mode (no inbound webhook URL)

When `SLACK_APP_TOKEN` (an `xapp-...` app-level token with the `connections:write` scope) is also set, `mountSlackApp()` constructs a `SocketModeReceiver` instead. Events flow over an outbound WebSocket initiated by the bot, removing the need for a public webhook URL. This is convenient for local development (no ngrok) and for production environments without inbound webhook capability.

To enable Socket Mode end-to-end, also flip `socket_mode_enabled: true` in `slack-manifest.yaml` and re-import the manifest in the Slack app config — otherwise Slack will keep trying to deliver events over HTTP and the WebSocket will sit idle. The header comment in `slack-manifest.yaml` walks through the steps.

### Lifecycle

`mountSlackApp()` registers handlers immediately but does not begin accepting events. It returns a `{ start, stop }` lifecycle handle. `src/index.ts` calls `start()` only after `recoverActiveTasks()` and the reminder scheduler have finished, so an inbound event arriving during boot cannot race a recovery prompt and double-trigger an agent. `stop()` is invoked from the SIGINT/SIGTERM handler for a graceful Socket Mode disconnect before the HTTP server closes.

### Bot Scopes

The manifest declares these bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `users:read`, `usergroups:read`, `files:read`, `files:write`, `pins:read`, `reactions:read`, `reactions:write`, `assistant:write`. The `channels:*` and `groups:*` scopes cover public and private channels respectively (`groups:history` is required to read messages and thread context in private channels); the `im:*` scopes enable DM-originated tasks; the `mpim:*` scopes cover group DMs (multi-party DMs) — `mpim:history` lets `conversations.replies`/`conversations.history` read a group DM's thread and enables the `message.mpim` event, and `mpim:read` lets `conversations.info` resolve a group DM's channel name, shared status, and canvas tabs; `pins:read` backs `pins.list` for the pinned-message index (see [Channel Pinned Messages](#channel-pinned-messages)) and is the one scope the app is not yet installed with — the feature is dormant without it and costs nothing until it is granted; `reactions:write` powers the eyes-emoji acknowledgment pattern and the PM's `react_to_message` tool; `reactions:read` backs `get_message_reactions`; `assistant:write` is required to push generated titles to DM-rooted assistant threads via `assistant.threads.setTitle`, and (together with `chat:write`) backs the live "Archie is …" status indicator via `assistant.threads.setStatus` — see [Live Status Indicator](#live-status-indicator).

**Adding a scope to the manifest does not grant it to an existing installation.** Saving the manifest updates what the app *requests*; the bot token keeps its old scope set until the app is **reinstalled to the workspace**. Until then the affected calls fail with `missing_scope` while everything else keeps working, which reads as a code bug but is not one — e.g. before the reinstall that granted `mpim:*`, a group DM produced `[Slack] Failed to fetch shared-channel status … needed: 'mpim:read'` followed by `[Server] Error processing Slack event … needed: 'mpim:history'`, and the message was dropped with no reply in Slack. To check what the live token actually holds, read the `x-oauth-scopes` response header from any Web API call (e.g. `auth.test`) rather than trusting the manifest.

## Bot Identity Detection

On startup, `initSlackClient()` in `src/connectors/slack/client.ts` calls `auth.test()` to retrieve both the bot's `user_id` and `bot_id`. These two identifiers serve different purposes:

- **`botUserId`** is used to detect `@Archie` mentions in message text (the `<@U...>` pattern).
- **`botId`** is used by the event router in `src/connectors/slack/events.ts` to discard the bot's own messages, preventing infinite feedback loops. The router compares `event.bot_id` against the stored `botId` and returns a `discard` action on match.

## Event Handling

The server registers two Bolt event handlers:

1. **`app_mention`** -- Fires when a user mentions `@Archie` in any channel Archie is a member of — public, private, or a group DM. This is the primary way users start new tasks in channels and group DMs.

2. **`message`** -- Fires for thread replies, DM messages, and top-level channel posts in channels a trigger watches. Slack delivers these via four subscribed event types — `message.channels` (public channels), `message.groups` (private channels), `message.im` (1:1 DMs), and `message.mpim` (group DMs) — all of which Bolt surfaces as a single `message` event.

   The forward decision lives in `task-routing.ts`, which is deliberately import-free so it can be unit-tested without the Bolt or Task machinery. It answers **two separate questions**, because they have opposite appetites: `mayWakeTask` decides whether an event reaches a task Archie is already working in, and `mayReachTriggers` decides whether a channel-message trigger may see it. `shouldForwardMessageEvent` is their disjunction and remains the single call site's entry point; the trigger-index predicate stays lazy *inside* the gate, consulted only once a post is known to be top-level. The call site is a separate matter: it consults the index again for every event the gate refused, in order to log the drop when a trigger is watching, so that lookup is not lazy on the refused path. It is an in-memory read.

   **The subtype filter is a denylist, not an allowlist.** `MESSAGE_NOISE_SUBTYPES` names 17 subtypes that carry no human-authored body — the join/leave, archive, convert and posting-permissions families, the pin/unpin notices, the body-less markers `message_deleted` and `message_replied`, `ekm_access_denied` where Slack withholds the content, and `message_changed` which has its own handler. **Everything else is forwarded, including subtypes nobody has enumerated yet.** This is the inverse of the earlier three-entry allowlist (empty / `file_share` / `thread_broadcast`), which silently dropped every subtype nobody had thought of: `bot_message`, `me_message`, `huddle_thread`, `channel_topic` and anything Slack ships next. A dropped event in a channel that has a watching trigger is logged at `debug`, so "why didn't my trigger fire?" is answerable.

   **App posts are treated like any other content.** A bot reply in a thread Archie is already working in wakes the task, which is usually the point — CI reporting a failed build in the very thread Archie is fixing is exactly what the PM should see. This mirrors the line thread ingestion draws: `fetchSlackThread` keeps internal bots such as bug-tracker integrations and drops only bots from another workspace. Archie's own posts never reach the predicates at all; `routeSlackEvent` discards them by `bot_id` and by our bot user id, which is what closes the feedback loop.

   The asymmetry between the two questions is narrower than "bots": a **top-level** app post reaches triggers but does not wake a task, because no top-level post does — that arm is thread-replies-and-DMs only. A foreign-workspace bot is refused explicitly on the trigger path; on the task path it needs no guard, since `fetchSlackThread` already drops its message so the content never reaches an agent (the residue is that such a reply can wake the task to find nothing new — a wasted turn in a Slack Connect channel, not a leak).

   Task creation additionally requires the fetched thread to carry at least one visible message, so a payload with no author and no body cannot seed a task on an empty knowledge log.

   In channels and group DMs, messages containing a bot mention are skipped here because `app_mention` already handles them; in 1:1 DMs, mention-containing messages are processed here because `app_mention` does not fire for DMs. Note that Archie only receives private-channel and group-DM events for conversations it has been invited to.

   The `message` handler also branches on the **`message_changed`** subtype (a user editing a message) and routes it to `handleSlackEdit` — see [Message Edits](#message-edits) below.

Both handlers run the same pipeline:

```
Slack webhook
  -> routeSlackEvent()  [discard own bot messages by bot_id]
  -> handleSlackEvent() [inline, fire-and-forget]
```

Events are processed inline with no queue — the Bolt receiver acknowledges the webhook immediately and processing continues asynchronously. The shutdown flag short-circuits handlers during graceful shutdown. See `src/connectors/slack/events.ts`.

## Message Edits

When a user edits a message, Slack delivers a `message` event with subtype `message_changed`, carrying both the new (`message`) and prior (`previous_message`) versions. The `message` handler routes these to `handleSlackEdit`, which treats a substantive edit like any other new input: it records the change and wakes the owning task. This matters because an edit can alter the *meaning* of an instruction (e.g. "deploy to staging" → "deploy to prod") that Archie would otherwise act on from stale text.

`handleSlackEdit` only acts when **all** of these hold, otherwise it returns silently:

- **The text actually changed.** Slack fires `message_changed` for link unfurls and attachment re-renders too, where `message.text === previous_message.text`. These are dropped up front — they're the dominant source of edit-event noise. Note the comparison is on the raw `text` field, deliberately, not on the rendered body: an edit that touched *only* an attachment card is indistinguishable from an unfurl re-render at this point, so it is dropped with them.
- **The edit is not bot-authored.** Edits carrying a `bot_id`, a `bot_message` subtype, or authored by Archie's own user are skipped.
- **A task already follows the thread.** Resolved via `findTaskByThread(message.thread_ts || message.ts)`; an edit only wakes a thread that already has a task — an edit never *creates* one (unlike a fresh reply, which can seed a task for an @mention, a DM, or a bot-started thread).
- **The editor is internal.** The same external/guest bail-out (`isExternalUser`) used by `handleSlackEvent` applies, and a muted channel is not woken.

When they hold, the edited payload goes through `rawMessageBody` — the same full inbound extraction every other path uses, so blocks, attachment cards, files and mention resolution all apply, not just the flat `text` field — and `task.appendSlackEdit` writes a **fresh** knowledge-log entry — the log is append-only, so edits are never mutations of the original line. The entry reuses the original message's `msg:<ts>` id and its body, built by the pure `renderEditForContext`, is the rendered new content tagged as an edit — so an edit that added an attachment card or a file shows them, where an earlier version logged only the flat text:

```
@<U123:Dana> in slack:#<C456:deploys>:1700000000.000100 | msg:1700000000.000100
  [edited] deploy to prod
```

The pre-edit text is deliberately **not** duplicated — the original message already sits in the log under the same `msg:<ts>` id, so the agent correlates the edit to it by id rather than us re-logging now-stale text.

Crucially, `appendSlackEdit` does **not** advance `last_processed_ts`: an edit reuses the original message's `ts`, so touching the watermark would cause genuinely new replies to be skipped. After logging, the task is woken with the standard `AGENT_PROMPTS.existingTask` ("new input received") prompt — the agent reads the edit from the log and decides whether the change is material, taking no action when it is merely cosmetic.

## Triage Agent (Disabled)

The Haiku-based triage agent in `src/system/triage.ts` is **currently disabled**. The classification block in `handleSlackEvent` is commented out (`src/connectors/slack/events.ts:351-382`); routing is performed directly by the event handler using the structural cues described below. The triage module is kept in the tree because it may be reintroduced.

## Message Flow: Slack to PM Agent

`handleSlackEvent` (in `src/connectors/slack/events.ts`) drives all routing without an LLM step:

```
Slack webhook
  -> routeSlackEvent()                       [drop own bot's messages]
  -> External-author bail-out                [resolve user, skip if external/guest]
  -> Eyes reaction (ack)                     [@mention/DM: add to current msg, remove from prev]
  -> fetchSlackThread()                      [history + author resolution + shared flag + rootAuthorWasBot]
  -> findTaskByThread(threadId):
       found    -> Task.get() -> task.append(thread)
                   -> task.sendMessage(AGENT_PROMPTS.existingTask)
       not found, (app_mention OR DM OR rootAuthorWasBot) AND thread has >=1 visible message
         -> Task.create() -> task.append(thread)
                   (a reply to a bot-started thread is acked here, post-fetch)
                   -> task.sendMessage(AGENT_PROMPTS.newTask)
       not found, reply in a thread the bot didn't start -> ignore
```

`rootAuthorWasBot` (computed by `fetchSlackThread` from the raw root message, before bot-message filtering) is true when the thread's root was posted by Archie itself — i.e. a top-level message it made via the task-decoupled `post_to_channel` explore tool. A human reply to such a thread seeds a new task (and the bot's root message is kept in the thread so the task has context); a reply in a thread Archie merely posted into, or never touched, has a non-bot root and is ignored.

A muted thread (`SlackChannel.muted = true`, set by the PM's `mute_channel` tool) is unmuted by an `@mention` and otherwise skipped. In DM channels, any inbound message also unmutes — there is no `@mention` path in a DM, so a DM message is treated as the equivalent. `mute_channel` mutes a single channel — the one the PM names, or the task's `default_channel` if omitted; it refuses to mute DM channels (channel IDs starting with `D`) up front, but the DM-as-unmute rule above is the backstop that recovers any legacy task whose DM channel was muted before this restriction existed. Title generation runs as a fire-and-forget Haiku call after the first append; for DM-rooted tasks the resulting title is pushed to Slack via `assistant.threads.setTitle` (see `src/connectors/slack/title.ts`). External users (different `team_id`, or `is_restricted` / `is_ultra_restricted` guests) are filtered out before any work is spawned; their messages are still re-read on later events because `fetchSlackThread` refreshes full history each time.

## Group DMs (channel-like)

Group DMs (multi-party DMs, or "mpims" — `is_mpim: true`) are treated as **channel-like, not DM-like**. Their channel ids are **not reliably `G…`**: Slack also issues `C…` ids for mpims (a live group DM in the Sweatcoin workspace resolves as `C…` with `is_mpim: true` and the `mpdm-…` name), so the `is_mpim` API flag — never the id prefix — is the marker to key off, as `assertPostableChannel` does. Only the `D…` prefix is meaningful, and only as "this is a 1:1 DM". A group DM has several people in it and not every message is meant for Archie, so it engages exactly the way a channel does rather than the way a 1:1 DM does:

- An **@mention** creates a task and Archie replies in that thread — the mention flows through `app_mention` → `handleSlackEvent` → `fetchSlackThread` → `shouldCreateNewTask` (true because the event is an `app_mention`) → `Task.create`, then replies via the normal task-reply path.
- Once a thread is engaged, **member replies route to that task with no re-mention** — a `message.mpim` thread reply is forwarded (it is a thread reply) and `findTaskByThread` attaches it to the engaged task.
- **Ambient, non-mention top-level messages are ignored.** A top-level group-DM post is not a thread reply, is not a 1:1 DM (a group-DM id is never `D…`), and has no watching trigger, so `shouldForwardMessageEvent` does not forward it. Mention-bearing top-level posts are skipped in the `message` handler and handled by `app_mention` instead, so nothing is double-processed.

Group DMs get the same **channel extras** as real channels wherever Slack supports them: the canvas scan (`getChannelCanvasTabs`), shared-channel detection (`isChannelShared` via `conversations.info`), and the ambient live status indicator. The external/guest-author bail-out (`isExternalUser`) runs on the group-DM path just as it does elsewhere — an external author never triggers a task — and redaction of external authors in shared conversations is no worse than in a private channel.

Because a group DM is channel-like, every branch that keys strictly off the `D` prefix stays **D-only** and does *not* fire for group DMs: the eyes-reaction acknowledgment applies only via the `app_mention` arm (a non-mention ambient group-DM message is not acked), there is no DM-as-unmute backstop, and no 1:1-DM assistant-pane title is pushed. Group DMs are also **not** a valid target for the PM's task-decoupled `post_to_channel` explore tool — `assertPostableChannel` refuses both 1:1 DMs and group DMs, so Archie only ever speaks into a group DM through the task-reply path of a thread it was engaged in, never by proactively posting into a small private audience.

## Channel Pinned Messages

What a channel pins is standing context about that channel, in the same way the `Archie…` canvas is — but far noisier: nobody writes a pin for Archie, pins accumulate for years, and anyone in the channel can add one. So pins are injected as a one-line **index**, not as content.

`ensureChannelPins` (`src/connectors/slack/channel-pins.ts`) runs from the same places as the canvas scan — the bot's own `member_joined_channel` and the inbound message path just before the PM wakes, both in `events.ts`, plus a third caller outside it: `fireTrigger` refreshes a schedule-fired task's home channel before waking it (`src/system/trigger-scheduler.ts`), on the same terms as any other caller, announcements included — bounded by a 60s TTL per channel and skipped for DMs. It reads `pins.list` through `listChannelPins` — which hands out the message's structured parts (`ownText`, attachments, files, reactions) rather than a pre-joined string, so the render happens in `channel-pins.ts` via `pinBody` and `client.ts` renders nothing. `pinBody` excludes reactions deliberately: the rendered string feeds `digestOf`, which is what makes re-summarise-on-edit work, and reactions change without the pin ever being edited. It stores what survives in the per-channel store (`$ARCHIE_WORKDIR/slack/channels/<channelId>.json`, alongside the canvases), and posts nothing: unlike canvas adoption, indexing a pin changes nothing for the channel, so there is no state change worth announcing.

**Two principals are gated, not one.** A pin has an author and a pinner, and they are usually different people. Both must classify as internal (`isExternalUser`); either being external drops the item, and either being unclassifiable fails closed — an already-vetted entry is retained, a new one is skipped and retried at the next scan. An **app-posted pin is adopted**, and only a bot posting from *another* workspace is refused — the same line thread ingestion already draws (in `fetchSlackThread`: drop bots from another workspace, keep real users and internal bots). Deploy notifications, incident summaries and workflow cards are among the most-pinned things in a real channel. What makes it safe is the other principal: a bot has no human author to vet, but the pinner is always a person and always classified, so an internal human chose to put the line in front of the agent. Bot-authored lines render as `by="<name> (app)"`.

**Ordering, then the gate, then the cap.** Items sort newest-pinned-first, are gated, and only then capped at 25. Capping first would let refused pins consume index slots, so one external participant pinning twenty-five things could blank a channel's index entirely. `pinsEligible` records the post-gate count, so the `<pins_omitted>` element discloses what the *cap* hid and never what the gate refused.

**Summaries are cheap and cached.** A pin at or under 200 characters is its own index line, verbatim, with no model call. A longer one gets a single Haiku call (`src/connectors/slack/pin-summary.ts`, the same one-shot shape as the task title generator), cached in the store against a digest of the source text — so an edited pin is re-summarised exactly once and a steady-state scan costs one `pins.list` and nothing else. At most six model calls run per scan, because the scan is awaited before the PM wakes; the overflow is indexed from its own truncated text and upgraded on a later scan. Any model failure falls back to truncation rather than dropping the pin, because a missing line is indistinguishable from nothing being pinned.

`buildChannelPinsPromptSection` renders the block at spawn, at a single injection point in `src/agents/spawn.ts` above the canvas block, so **every** agent gets it — PM, repo, and plugin alike. Each `<pin>` carries the channel label and id, the pin date and age, the message date and age, the author and pinner names, the `ts` or file id needed to open it, and `source`: `model` when a summariser paraphrased the pin, `verbatim` when the line is the pinned text itself. That distinction is load-bearing — a verbatim line is untrusted user input reaching the prompt unaltered, and the block's `note` says so.

**Nothing is filtered by age.** A runbook pinned two years ago is often the most relevant thing in a channel, so both dates and both ages are exposed and the agent judges. Every value in the block — element text and attribute alike — is XML-escaped, which is what keeps pinned content, a display name or a channel name from closing the wrapper or forging a `<pin>` element with someone else's attribution.

Opening a pin needs no new tool: the PM already has `read_thread` for a message, whose `channel` and `thread_ts` parameters take the pin's `channel_id` and `ts`, and `fetch_slack_reference` now accepts a pinned file id as well as a canvas-referenced one. Both live in `comms-tools`, which is PM-only, so a specialist that needs a pin asks — exactly as it does for a canvas file reference.

## Multi-Channel Support

A single task can be linked to multiple destinations — Slack threads (channel or DM) and the CLI. The `TaskMetadata` type (`src/types/task.ts`) holds a `channels` record keyed by `slack:<channelId>:<threadTs>` (or `cli` for the CLI channel). The relevant Slack entry shape is:

```typescript
interface SlackChannel {
  type: 'slack';
  thread_id: string;
  channel_id: string;
  channel_name: string;
  last_processed_ts: string;
  url?: string;
  muted?: boolean;
  isShared?: boolean;
  warnedUsers?: string[];
  forwardNotifiedUsers?: string[];
}
```

A task's Slack channels are linked by `task.append(thread)` as inbound events arrive (the originating @mention/DM/bot-started thread, plus any thread the bot is later drawn into). The first linked channel is recorded as `default_channel`, the implicit destination when `post_to_user` is called without a target. The PM cannot open new DMs or new task-linked threads; to reach a channel that is NOT part of the task it uses the task-decoupled explore/post tools (`read_channel_history`, `read_thread`, `post_to_channel`), which never register a channel on `metadata.channels`.

## Message Deduplication

Each Slack channel entry stores a `last_processed_ts` timestamp. The eyes-reaction acknowledgment in `handleSlackEvent` uses it to remove the previous "eyes" reaction before adding one to the new message, so only the most recent inbound message ever shows the indicator. `task.append(thread)` in `src/tasks/task.ts` is also responsible for advancing `last_processed_ts` and skipping messages it has already absorbed into the knowledge log.

## How PM Replies Reach Slack

There is no `post_to_slack` MCP tool and no event-bus subscription that ferries messages to Slack — the PM calls `postSlackMessage` (and `postSlackFiles`) directly, in-process, through the `Task` instance. The pipeline is:

1. The PM agent calls the `post_to_user` MCP tool (defined in `src/agents/tools.ts`). This is the **only** outbound user-messaging tool — repo and plugin agents do not have it; they communicate via `send_message_to_agent` and let the PM decide what to relay. File uploads use the sibling `post_files_to_user` tool, which can only attach to an already-linked thread.
2. The tool handler invokes `task.postToUser(message, agentName, target)` in `src/tasks/task.ts`, which routes by target:
   - no target → post to `default_channel` (Slack or CLI)
   - `target.channel <key>` → post to a specific already-linked thread
   - no target **and** no `default_channel`, on a trigger-fired task that has a `metadata.home_channel` → post a new **top-level** message in that channel and adopt it as the task's thread, returning its channel key (`openHomeThread`). This is the only path that opens a thread: the destination comes from the approved trigger's binding rather than from any tool argument, only a message sent by an agent takes it (a system notice must not become a thread root), the open is serialized per task, and the linking write is flushed. See [Triggers](triggers.md#a-schedule-fire-homes-its-task-in-the-bound-channel).
3. Each branch ultimately calls `postSlackMessage()` in `src/connectors/slack/client.ts`, which renders the text as a single Block Kit `markdown` block (`{ type: 'markdown', text }`). Slack renders that natively as CommonMark — headings, tables, fenced code blocks, lists, blockquotes, task lists, and links — without manual conversion. See [Markdown block reference](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/). Per-message payload is capped at 12,000 characters (`SLACK_MARKDOWN_LIMIT`); the function asserts the limit and throws `SlackMarkdownLimitError` on overflow.
4. On success, `Task.logOutgoingMessage` writes the message to the task's `knowledge.log`, emits a `message` event on the in-process event bus (consumed only by the SSE/CLI streaming endpoint — see `src/system/event-bus.ts`), and logs via the unified logger. On failure, nothing is logged or emitted; the tool returns split-and-retry guidance to the agent via `formatSlackSendError`.

`@<U…:Real Name>` mention syntax used in agent prompts is converted back to Slack's `<@U…>` form by `restoreMentions` inside `postSlackMessage` so notifications fire correctly.

## Message Footer

Every user-facing message carries a small grey footer: `task-<id> · <models>`, where `<models>` is the **distinct set of models the task has actually used** — PM first, then each spawned specialist — joined with ` + ` (e.g. `task-20260626-2130-a3f9k2 · Opus 5 + Sonnet 5 (1M)`). As more agents join, the set grows. It is built once per send by `Task.buildUserFooter()` → `collectModelsUsed()`, which prefers the **concrete model the SDK resolved each agent's alias to** — recorded at the agent's session `init` via `Task.recordResolvedModel()` (so `opus` shows as its real version, e.g. `Opus 5`; a max-mode swap starts a fresh session, so the label follows, e.g. `Fable 5`). It falls back to the configured alias (`resolveAgentModel`, shared with `spawn.ts`) only before an agent's first `init`. Labels are then derived by `modelDisplayLabel` in `src/agents/model-label.ts`, which **parses** any model id generically — drops the `claude-`/`anthropic/` prefix, capitalises the family, dots up to two numeric version segments, drops the date, and renders the `[1m]` 1M-context marker as `(1M)` — so a brand-new model version renders correctly with no code change (there is no per-version lookup table). Delivered to both surfaces:

- **Slack** — `postToUser` passes it as `postSlackMessage({ …, footer })`, which appends a trailing `context` block beneath the `markdown` block.
- **CLI** — `logOutgoingMessage` includes `footer` in the `message` event data; `TaskDetail.tsx` renders it dimmed under the message text. Slack ignores the event field (it uses the context block).

The task id is plain text today; it is the single render site to later wrap in a session-share link.

## PR Cards

When a repo agent opens a PR, Archie posts a compact, self-updating **PR card** so it's obvious a PR exists, its state, and CI progress. The card is driven by a channel-agnostic `pr_card` event (see [GitHub Integration → PR Cards](github-integration.md)); Slack is one renderer:

- `buildPrCardBlocks` emits a Block Kit **`card`** block: a title row (`<url|#number> head-branch`) and a subtitle (`repo · CI summary`), e.g. `sweatcoin-mobile · :hourglass: CI checks (1/2)`. A merged/closed PR shows its final state in the subtitle instead of CI. Subtitle text is shared with the CLI via `pr-card-format`; Slack uses emoji shortcodes (`:hourglass:`/`:white_check_mark:`/`:x:`/`:large_purple_circle:`).
- `Task.resurfacePrCards()` posts the card with `postInteractiveToThread` into the default thread and stores the message `ts` in `BranchState.pr_card.slack`. It runs **eagerly from `report_completion`** (right after the final message, so the card appears instantly rather than at deferred teardown) and again from `complete()`/`stop()` as an idempotent safety net.
- When the PR changed since its last card, the old card is **deleted** (`deleteMessage`) and reposted at the bottom so it sits under the PM's final message.
- Async GitHub webhooks (CI conclusion, merge/close) call `Task.refreshPrCardInPlace`, which **edits** the existing message via `updateMessage` (no resurface — the card stays put). The fingerprint excludes PR title/description, so editing those never moves or refreshes the card.

## Live Status Indicator

While a task is being worked on, Archie shows a live "**Archie is …**" status line of what it's currently doing. This is a **surface-agnostic** capability: one status string is composed per task and rendered to whatever surfaces are available — the CLI, the logs, and Slack. Slack happens to render it natively as the assistant-thread loading shimmer under the composer (via `assistant.threads.setStatus`, the progress sibling of the title pipeline — same `client.assistant.threads.*` accessor and `channel_id` + `thread_ts`, wrapped best-effort in `src/connectors/slack/status.ts`). Slack auto-prepends the app name, so the string is always a verb fragment (`"is checking mobile and backend…"` → "**Archie** is checking mobile and backend…"). Since the 2026-03 platform change `setStatus` accepts `chat:write` as well as `assistant:write`, so it works in regular channel threads as well as DM/assistant threads — Archie sets it on every linked, non-muted Slack thread. (Documented here because Slack is the primary renderer; the engine itself is generic and lives in `src/tasks/status.ts`.)

The status is derived **automatically** from agent activity — no agent prompt changes, and it works for the PM and every present/future plugin agent:

- **Capture.** The per-agent SDK loop in `src/agents/spawn.ts` calls `task.noteActivityFromEvent(agentId, event)` on every event, alongside the existing logging hook. `deriveActivity` (`src/agents/activity.ts`) maps each `tool_use` block (`block.name`, `block.input`) to a short first-person fragment:
  A specialist's fragments always name **where** (its domain), so a single active specialist is never vague; only the PM (no domain) and genuinely domain-agnostic actions stay generic.
  - **work** — `Read`/`Grep` → "digging into the backend"; `Edit`/`Write` → "making changes to the backend"; `Bash` → "running some checks on the backend"; `Skill` → "getting up to speed on the backend"; `create_pull_request` → "opening a backend pull request"; `push_branch` → "pushing the backend changes"; external MCP → "checking Rollbar" / "updating Monday.com" (metadata-derived). `web_research` stays "researching" (external info, not the codebase domain).
  - **coordination & PM steps**, phrased in the single voice so no agent is ever named — `send_message_to_agent` → "looking into the backend" (resolved from the **target's** domain, so a delegation reads as Archie turning to that area) or "coordinating" (to the coordinator / unknown); `log_finding` → "making a note on the backend"; `share_artifact` → "writing up the backend"; `find_slack_user`/`find_slack_channel` → "looking someone up"/"finding the right channel"; `read_channel_history`/`read_thread` → "catching up on a channel"/"reading a thread"; `get_agents_status` → "checking on progress"; `set_reminder` → "setting a reminder". (The PM has no domain, so its steps stay generic.)
  - **plumbing** maps to `null` and never surfaces — `post_to_user`/`post_to_channel` (clear-on-post path), `assign_task_owner`, `report_completion`, `request_edit_mode`, `parse_datetime`, reactions/mute.

  Agent active/idle transitions flow through `Task.updateAgentState`, which already knows who is mid-turn.
- **Render.** `TaskStatusController` (`src/tasks/status.ts`) composes **one** line from the whole team with a fixed precedence: if the **PM** is active it speaks ("is putting this together…"); else if exactly **one specialist** is active it shows that specialist's specific action ("is working on the mobile app…"); else it **aggregates the domains** of the several active specialists ("is checking mobile and backend…"). It is always first person and never names an agent — specialists appear only by their **domain noun**, resolved by `agentDomainLabel` from the optional `metadata.archie.statusLabel` frontmatter, falling back to the agent key (engineering: `mobile`, `backend`) or a cleaned plugin name. This composes naturally with the PM's stop-and-wait flow: after delegating, the PM goes idle and specialist statuses show through; when it wakes to synthesise, its own status returns.
- **Deliver.** Each rendered line goes through a single sink, `Task.onStatusRendered`, which fans it out to both surfaces so the status can be observed with or without Slack: (1) a `status` event on the in-process event bus → SSE → the **CLI** renders the same "Archie is …" line live (a spinner above the message input — `TaskDetail.tsx`); (2) the **Slack** assistant-thread indicator (best-effort, every linked non-muted Slack thread). A CLI-only task has no Slack channel, so the Slack push is a no-op there and the CLI is how you test it. (Status changes are intentionally not logged — they'd be noise; the CLI is the debug surface.)
- **Debounce, keepalive & clear.** Pushes are debounced (~1s) and de-duplicated so no surface is spammed and the indicator doesn't flicker between turns. Because Slack auto-clears a status after ~2 minutes if nothing refreshes it, a keepalive re-asserts the current status every ~90s — without it, a long-running, quiet tool call (e.g. `web_research`) would lose the indicator mid-work. It is cleared when the PM posts to the user (`logOutgoingMessage` → Slack also auto-clears on a posted reply) and on task `stop()`/`complete()` (which also stops the keepalive). When a turn is **winding down** to a stop/complete — `report_completion`, an edit-mode request, or a research-budget stop — the controller is **suspended** (`Task.suspendStatus`) so the indicator is blanked *immediately* rather than at turn-end; otherwise a trailing tool call (or the keepalive) would pop the status back for a couple seconds after the final message. Activity is in-memory only — never persisted — so a restart never resurfaces a stale "working…". The whole feature is gated by `ARCHIE_LIVE_STATUS` (default on).

## Interactive Messages

Some system events require user decisions via Slack buttons. The PM calls `task.postInteractiveToUser(text, blocks, approvalType, channelKey?)`, which routes to `postInteractiveToThreads()` for the given channel — or the task's default Slack channel when `channelKey` is omitted. Currently implemented interactive flows:

- **Edit mode approval**: "Approve" / "Deny" buttons (action IDs: `approve_edit_mode`, `deny_edit_mode`). See [Edit Mode](./edit-mode.md).
- **Research budget approval**: "Approve (+5)" / "Deny" buttons (action IDs: `approve_research_budget`, `deny_research_budget`).

Button clicks are handled by Bolt action handlers in `src/connectors/slack/events.ts`. When clicked, the handler acknowledges the interaction, updates the original message (removing buttons and showing the outcome), and calls the corresponding `Task` method (`handleEditModeApproval` / `handleEditModeDenial` / `handleResearchBudgetApproval` / `handleResearchBudgetDenial`), which modifies task metadata and reactivates the PM agent.

## Natural Language Guidelines for PM Responses

The PM agent's prompt (`prompts/pm-agent.md`) establishes these communication rules:

- Write as "I", not "my agent" or "the backend agent".
- Never mention task owners, delegation, or internal coordination to the user.
- Keep messages natural, brief, and focused on what users care about.
- Use simple markdown (bold, italic, lists) but avoid headers.
- For social contexts (welcomes, celebrations, announcements), respond warmly as a team member would.

Channel decision logic:
- New work from Slack: acknowledge in Slack ("Looking into this...")
- Milestone announcements: always post to Slack regardless of input source
- Background system events: usually silent unless significant for the user

## Mention Resolution

When fetching thread history, `src/connectors/slack/client.ts` resolves Slack's opaque mention formats into human-readable text:

- User mentions `<@U123>` become `@<U123:Real Name>`
- Group mentions `<!subteam^S123>` become `@<S123:group-name>`
- Channel mentions `<#C123>` become `#<C123:channel-name>`

This resolution happens in `fetchMentionInfo()` and `applyMentionReplacements()`, which batch-fetch user, group, and channel info before applying replacements across all messages. This ensures agents see human-readable names rather than opaque Slack IDs.

## File Handling

The Slack client extracts file metadata from messages, including files shared directly, files nested in forwarded messages, and image attachments from unfurled links. File metadata is captured as `SlackFile` objects with download URLs. The `downloadSlackFile()` function handles authenticated downloads using the bot token via Bearer authorization headers.

## Acknowledgment, Muting, and Shared-Channel Awareness

- **Acknowledgment (eyes reaction)** — `@mention` and DM messages are acknowledged with an `:eyes:` reaction (plain thread replies in an engaged channel are not, to avoid noise during inter-employee conversation). `task.ackMessage` records the acked message on `SlackChannel.ack_ts` and clears the previous one, so only one indicator is live per thread and it survives non-mention follow-ups. Cleaned up on task stop/complete by `clearAcks`.
- **Agent-driven reactions** — the PM can react to *any* message in a linked thread via the `react_to_message` tool (and `unreact_from_message` / `get_message_reactions`). Messages are addressable because `appendSlackMessage` stamps each knowledge-log source line with a `msg:<ts>` id; the agent passes that `ts` as `message_id`. Reactions present at ingest time are also captured as a `SlackReaction[]` snapshot (from `conversations.replies`) and rendered as a `[Reactions: …]` line in the log; `get_message_reactions` reads the live state via `reactions.get`.
- **Muting** — the PM's `mute_channel` tool sets `SlackChannel.muted = true` on a single channel (the one named, or the task's `default_channel` if no `channel` arg is given), after which that thread is ignored until a new `@mention` toggles it back on. DM channels cannot be muted because there is no `@mention` re-engagement path in a DM.
- **Shared channels (Slack Connect)** — `isChannelShared` (60s TTL cache) flags external-shared channels; `sendSharedChannelWarnings` posts ephemeral notices once per (thread × user): a general shared-channel heads-up to internal participants, and a forward-from-external notice to anyone who pastes content originally authored by an external user.

## Relevant Source Files

- `src/connectors/slack/client.ts` — Slack WebClient wrapper: `postSlackMessage`, `postSlackFiles`, `postInteractiveToThread(s)`, thread history, mention resolution, file downloads, shared-channel detection, user/channel lookup caches
- `src/connectors/slack/events.ts` — Bolt app setup (`mountSlackApp`), `app_mention` / `message` handlers, `routeSlackEvent` + `handleSlackEvent`, button action handlers, title pipeline, shared-channel warnings
- `src/connectors/slack/task-routing.ts` — pure inbound-routing decisions, import-free by design: `mayWakeTask` / `mayReachTriggers` (the two questions the gate answers separately) over the `MESSAGE_NOISE_SUBTYPES` denylist, `shouldForwardMessageEvent` (their disjunction — the single call site's entry point), `isAckableEvent` (does it earn an eyes reaction), `shouldCreateNewTask` (does it seed a task) — the channel-vs-DM predicates that keep group DMs channel-like
- `src/connectors/slack/message-body.ts` — **the one place a Slack message becomes agent-facing text**: `renderMessageBody` plus the named entry points every path uses (`messageBody` for the title transcript, `exploreBody` for explore reads, `pinBody` for the pin index, `rawMessageBody` for a raw Bolt payload). Task ingestion calls `renderMessageBody` + `shouldRedact` directly rather than `messageBody`, because it must substitute the DOWNLOADED files into the parts — only those carry a `localPath`, and the `[Attachments: …]` suffix prints the path only when it is set, so rendering from the un-downloaded files would silently drop every path an agent needs to open the file and `shouldRedact`, the single answer to the redaction question
- `src/connectors/slack/title.ts` — `assistant.threads.setTitle` wrapper for DM-rooted tasks
- `src/connectors/slack/status.ts` — Slack renderer for the status indicator: best-effort `assistant.threads.setStatus` wrapper
- `src/tasks/status.ts` — `TaskStatusController` (composes the single first-person status line: PM precedence → single specialist → aggregated domains, debounced) + `isStatusEnabled` (the `ARCHIE_LIVE_STATUS` master gate, all surfaces)
- `src/cli/components/TaskDetail.tsx` — CLI renderer: shows the live status line from `status` events (a spinner above the message input)
- `src/agents/activity.ts` — `deriveActivity` (tool call → status fragment) and `agentDomainLabel` (agent → domain noun, never its identity)
- `src/system/triage.ts` — Haiku-based message classifier (currently disabled at the call site)
- `src/agents/tools.ts` — `post_to_user`, `post_files_to_user`, `mute_channel`, `react_to_message`, `unreact_from_message`, `get_message_reactions`, `find_slack_user`, `find_slack_channel`, etc. (no `post_to_slack`)
- `src/tasks/task.ts` — `postToUser`, `postFilesToUser`, `postInteractiveToUser`, `reactToMessage`, `unreactFromMessage`, `readMessageReactions`, channel registration
- `src/system/event-bus.ts` — in-process event bus (used for SSE streaming to CLI; not a Slack transport)
- `src/types/task.ts` — `SlackChannel`, `TaskMetadata.channels`, `default_channel`
- `slack-manifest.yaml` — Slack app configuration
- `prompts/pm-agent.md` — PM agent communication guidelines
