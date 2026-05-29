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
      - message.im
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

The manifest declares these bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:read`, `im:history`, `im:read`, `im:write`, `users:read`, `usergroups:read`, `files:read`, `files:write`, `reactions:read`, `reactions:write`, `assistant:write`. The `im:*` scopes enable DM-originated tasks; `reactions:write` powers the eyes-emoji acknowledgment pattern and the PM's `react_to_message` tool; `reactions:read` backs `get_message_reactions`; `assistant:write` is required to push generated titles to DM-rooted assistant threads via `assistant.threads.setTitle`.

## Bot Identity Detection

On startup, `initSlackClient()` in `src/connectors/slack/client.ts` calls `auth.test()` to retrieve both the bot's `user_id` and `bot_id`. These two identifiers serve different purposes:

- **`botUserId`** is used to detect `@Archie` mentions in message text (the `<@U...>` pattern).
- **`botId`** is used by the event router in `src/connectors/slack/events.ts` to discard the bot's own messages, preventing infinite feedback loops. The router compares `event.bot_id` against the stored `botId` and returns a `discard` action on match.

## Event Handling

The server registers two Bolt event handlers:

1. **`app_mention`** -- Fires when a user mentions `@Archie` in any channel. This is the primary way users start new tasks in channels.

2. **`message`** -- Fires for thread replies and DM messages. The handler accepts an event when it is either a thread reply (`event.thread_ts && event.thread_ts !== event.ts`) or a DM (channel ID starting with `D`), and the subtype is empty / `file_share` / `thread_broadcast`. In channels, messages containing a bot mention are skipped here because `app_mention` already handles them; in DMs, mention-containing messages are processed here because `app_mention` does not fire for DMs.

Both handlers run the same pipeline:

```
Slack webhook
  -> routeSlackEvent()  [discard own bot messages by bot_id]
  -> handleSlackEvent() [inline, fire-and-forget]
```

Events are processed inline with no queue — the Bolt receiver acknowledges the webhook immediately and processing continues asynchronously. The shutdown flag short-circuits handlers during graceful shutdown. See `src/connectors/slack/events.ts`.

## Triage Agent (Disabled)

The Haiku-based triage agent in `src/system/triage.ts` is **currently disabled**. The classification block in `handleSlackEvent` is commented out (`src/connectors/slack/events.ts:351-382`); routing is performed directly by the event handler using the structural cues described below. The triage module is kept in the tree because it may be reintroduced.

## Message Flow: Slack to PM Agent

`handleSlackEvent` (in `src/connectors/slack/events.ts`) drives all routing without an LLM step:

```
Slack webhook
  -> routeSlackEvent()                       [drop own bot's messages]
  -> External-author bail-out                [resolve user, skip if external/guest]
  -> Eyes reaction (ack)                     [add to current msg, remove from prev]
  -> fetchSlackThread()                      [history + author resolution + shared flag]
  -> findTaskByThread(threadId):
       found    -> Task.get() -> task.append(thread)
                   -> task.sendMessage(AGENT_PROMPTS.existingTask)
       not found, app_mention OR DM -> Task.create() -> task.append(thread)
                                       -> task.sendMessage(AGENT_PROMPTS.newTask)
       not found, plain thread reply -> ignore (bot was never invited)
```

A muted thread (`SlackChannel.muted = true`, set by the PM's `mute_channel` tool) is unmuted by an `@mention` and otherwise skipped. In DM channels, any inbound message also unmutes — there is no `@mention` path in a DM, so a DM message is treated as the equivalent. `mute_channel` mutes a single channel — the one the PM names, or the task's `default_channel` if omitted; it refuses to mute DM channels (channel IDs starting with `D`) up front, but the DM-as-unmute rule above is the backstop that recovers any legacy task whose DM channel was muted before this restriction existed. Title generation runs as a fire-and-forget Haiku call after the first append; for DM-rooted tasks the resulting title is pushed to Slack via `assistant.threads.setTitle` (see `src/connectors/slack/title.ts`). External users (different `team_id`, or `is_restricted` / `is_ultra_restricted` guests) are filtered out before any work is spawned; their messages are still re-read on later events because `fetchSlackThread` refreshes full history each time.

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

New Slack destinations are linked when the PM calls `post_to_user` with `target.new_dm <userId>` or `target.new_thread <channelId>`; both flows post the message via `postSlackMessage`, register the new thread on `metadata.channels`, and return the channel key so the PM can reuse it later (notably with `post_files_to_user`). The first linked channel is also recorded as `default_channel`, which is the implicit destination when `post_to_user` is called without a target.

## Message Deduplication

Each Slack channel entry stores a `last_processed_ts` timestamp. The eyes-reaction acknowledgment in `handleSlackEvent` uses it to remove the previous "eyes" reaction before adding one to the new message, so only the most recent inbound message ever shows the indicator. `task.append(thread)` in `src/tasks/task.ts` is also responsible for advancing `last_processed_ts` and skipping messages it has already absorbed into the knowledge log.

## How PM Replies Reach Slack

There is no `post_to_slack` MCP tool and no event-bus subscription that ferries messages to Slack — the PM calls `postSlackMessage` (and `postSlackFiles`) directly, in-process, through the `Task` instance. The pipeline is:

1. The PM agent calls the `post_to_user` MCP tool (defined in `src/agents/tools.ts`). This is the **only** outbound user-messaging tool — repo and plugin agents do not have it; they communicate via `send_message_to_agent` and let the PM decide what to relay. File uploads use the sibling `post_files_to_user` tool, which can only attach to an already-linked thread.
2. The tool handler invokes `task.postToUser(message, agentName, target)` in `src/tasks/task.ts`, which routes by target:
   - no target → post to `default_channel` (Slack or CLI)
   - `target.channel <key>` → post to a specific already-linked thread
   - `target.new_dm <userId>` → `openDMChannel` then post + register
   - `target.new_thread <channelId>` → post a top-level message + register
3. Each branch ultimately calls `postSlackMessage()` in `src/connectors/slack/client.ts`, which renders the text as a single Block Kit `markdown` block (`{ type: 'markdown', text }`). Slack renders that natively as CommonMark — headings, tables, fenced code blocks, lists, blockquotes, task lists, and links — without manual conversion. See [Markdown block reference](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/). Per-message payload is capped at 12,000 characters (`SLACK_MARKDOWN_LIMIT`); the function asserts the limit and throws `SlackMarkdownLimitError` on overflow.
4. On success, `Task.logOutgoingMessage` writes the message to the task's `knowledge.log`, emits a `message` event on the in-process event bus (consumed only by the SSE/CLI streaming endpoint — see `src/system/event-bus.ts`), and logs via the unified logger. On failure, nothing is logged or emitted; the tool returns split-and-retry guidance to the agent via `formatSlackSendError`.

`@<U…:Real Name>` mention syntax used in agent prompts is converted back to Slack's `<@U…>` form by `restoreMentions` inside `postSlackMessage` so notifications fire correctly.

## Interactive Messages

Some system events require user decisions via Slack buttons. The PM calls `task.postInteractiveToUser(text, blocks, approvalType)`, which routes to `postInteractiveToThreads()` for the task's default Slack channel. Currently implemented interactive flows:

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

- **Acknowledgment (eyes reaction)** — `@mention` and DM messages are acknowledged with an `:eyes:` reaction (plain thread replies in an engaged channel are not, to avoid noise during inter-employee conversation). `task.acknowledgeMessage` records the acked message on `SlackChannel.acknowledged_ts` and clears the previous one, so only one indicator is live per thread and it survives non-mention follow-ups. Cleaned up on task stop/complete by `clearAcknowledgments`.
- **Agent-driven reactions** — the PM can react to *any* message in a linked thread via the `react_to_message` tool (and `unreact_from_message` / `get_message_reactions`). Messages are addressable because `appendSlackMessage` stamps each knowledge-log source line with a `msg:<ts>` id; the agent passes that `ts` as `message_id`. Reactions present at ingest time are also captured as a `SlackReaction[]` snapshot (from `conversations.replies`) and rendered as a `[Reactions: …]` line in the log; `get_message_reactions` reads the live state via `reactions.get`.
- **Muting** — the PM's `mute_channel` tool sets `SlackChannel.muted = true` on a single channel (the one named, or the task's `default_channel` if no `channel` arg is given), after which that thread is ignored until a new `@mention` toggles it back on. DM channels cannot be muted because there is no `@mention` re-engagement path in a DM.
- **Shared channels (Slack Connect)** — `isChannelShared` (60s TTL cache) flags external-shared channels; `sendSharedChannelWarnings` posts ephemeral notices once per (thread × user): a general shared-channel heads-up to internal participants, and a forward-from-external notice to anyone who pastes content originally authored by an external user.

## Relevant Source Files

- `src/connectors/slack/client.ts` — Slack WebClient wrapper: `postSlackMessage`, `postSlackFiles`, `postInteractiveToThread(s)`, thread history, mention resolution, file downloads, shared-channel detection, user/channel lookup caches
- `src/connectors/slack/events.ts` — Bolt app setup (`mountSlackApp`), `app_mention` / `message` handlers, `routeSlackEvent` + `handleSlackEvent`, button action handlers, title pipeline, shared-channel warnings
- `src/connectors/slack/title.ts` — `assistant.threads.setTitle` wrapper for DM-rooted tasks
- `src/system/triage.ts` — Haiku-based message classifier (currently disabled at the call site)
- `src/agents/tools.ts` — `post_to_user`, `post_files_to_user`, `mute_channel`, `react_to_message`, `unreact_from_message`, `get_message_reactions`, `find_slack_user`, `find_slack_channel`, etc. (no `post_to_slack`)
- `src/tasks/task.ts` — `postToUser`, `postFilesToUser`, `postInteractiveToUser`, `reactToMessage`, `unreactFromMessage`, `readMessageReactions`, channel registration
- `src/system/event-bus.ts` — in-process event bus (used for SSE streaming to CLI; not a Slack transport)
- `src/types/task.ts` — `SlackChannel`, `TaskMetadata.channels`, `default_channel`
- `slack-manifest.yaml` — Slack app configuration
- `prompts/pm-agent.md` — PM agent communication guidelines
