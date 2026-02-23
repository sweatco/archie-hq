# Slack Integration

Slack is the primary user experience layer for Archie. All human interaction flows through Slack threads, and all agent responses are delivered back to Slack. The system uses `@slack/bolt` in HTTP webhook mode (not socket mode) to receive events and the `@slack/web-api` client to post messages.

## Connection Method

Archie runs an Express-based HTTP server using Slack Bolt's `ExpressReceiver`. The Slack app manifest (`slack-manifest.yaml`) explicitly sets `socket_mode_enabled: false` and configures event subscriptions and interactivity to point at the `/webhooks/slack` endpoint.

```
# From slack-manifest.yaml
settings:
  event_subscriptions:
    request_url: https://<host>/webhooks/slack
    bot_events:
      - app_mention
      - message.channels
  interactivity:
    is_enabled: true
    request_url: https://<host>/webhooks/slack
  socket_mode_enabled: false
```

The server is created in `src/system/server.ts`, where `ExpressReceiver` is instantiated with the Slack signing secret and the `/webhooks/slack` endpoint. The Bolt `App` is then attached to this receiver.

### Bot Scopes

The manifest declares these bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `users:read`, `usergroups:read`, `files:read`.

## Bot Identity Detection

On startup, `initSlackClient()` in `src/slack/client.ts` calls `auth.test()` to retrieve both the bot's `user_id` and `bot_id`. These two identifiers serve different purposes:

- **`botUserId`** is used to detect `@Archie` mentions in message text (the `<@U...>` pattern).
- **`botId`** is used by the webhook router (`src/system/webhook-router.ts`) to discard the bot's own messages, preventing infinite feedback loops. The router compares `event.bot_id` against the stored `botId` and returns a `discard` action on match.

## Event Handling

The server registers two Bolt event handlers:

1. **`app_mention`** -- Fires when a user mentions `@Archie` in any channel. This is the primary way users start new tasks or interact with existing ones.

2. **`message`** -- Fires for all channel messages. The handler filters to only process thread replies (messages where `thread_ts` exists and differs from `ts`) that do not contain a bot mention (to avoid double-processing with `app_mention`).

Both handlers follow the same flow:

```
Slack webhook
  -> routeSlackEvent() [discard own bot messages]
  -> processSlackTriage() [inline, fire-and-forget]
```

Events are processed inline with no queue -- the webhook is acknowledged immediately and processing happens asynchronously. See `src/system/server.ts` lines 166-228.

## Triage and Message Classification

Every Slack event that passes the bot-identity filter goes through triage (`src/system/event-handler.ts`). The triage agent (Haiku model, defined in `src/agents/triage.ts`) classifies each message into one of four actions:

| Action | Description |
|---|---|
| `new_task` | A new work request. Creates a task, appends thread history to knowledge log, spawns PM agent. |
| `existing_task` | Follow-up on an active task. Appends new messages to the task's knowledge log, reactivates PM. |
| `cancel_task` | User wants to stop work. Calls `stopTask()` and posts a confirmation message. |
| `noop` | Acknowledgment or noise. No action taken. |

The triage agent receives the current message plus full thread history (fetched via `conversations.replies`) to make its classification decision.

## Message Flow: Slack to Agents

```
User @mentions Archie in Slack thread
  -> server.ts: app_mention handler
  -> webhook-router.ts: routeSlackEvent() - filters bot messages
  -> event-handler.ts: processSlackTriage()
    -> Fetches thread history via fetchThreadHistory()
    -> Runs triage agent (Haiku) to classify the message
    -> Routes based on classification:
       new_task:      createTask() -> sendMessage(PM, "New task created, assign owner")
       existing_task: loadTask()   -> sendMessage(PM, "New input received...")
       cancel_task:   stopTask()   -> posts confirmation to threads
       noop:          no action
```

## Multi-Thread Support

A single task can be associated with multiple Slack threads. The `TaskMetadata` type (`src/types/task.ts`) holds an array of `SlackThread` objects:

```typescript
interface SlackThread {
  thread_id: string;
  channel_id: string;
  last_processed_ts: string;
}
```

When triage classifies a message as `existing_task` and the thread is not yet tracked for that task, the event handler adds the new thread to `metadata.slack_threads` and posts a linking confirmation: "Got it, I've linked this to the ongoing investigation." All subsequent `post_to_slack` calls from the PM agent post to every tracked thread.

## Message Deduplication

Each `SlackThread` stores a `last_processed_ts` field. When processing an existing thread, the event handler only appends messages with a timestamp greater than `last_processed_ts`, then updates the field to the current message's timestamp. This prevents duplicate processing when multiple events arrive for the same thread.

See `src/system/event-handler.ts`, `handleExistingTask()` -- specifically the comparison `msg.ts <= lastProcessedTs` used to skip already-processed messages.

## The `post_to_slack` MCP Tool

The PM agent communicates with users via the `post_to_slack` MCP tool, defined in `src/mcp/tools.ts`. When the PM calls this tool:

1. The tool callback (`onPostToSlack` in `src/system/task-runtime.ts`) invokes the Slack post callback.
2. The callback loads the task's metadata and calls `postToThreads()` from `src/slack/client.ts`.
3. `postToThreads()` iterates over all `SlackThread` entries in the task metadata and posts the message to each one.
4. Before posting, the message text is converted from standard Markdown to Slack's `mrkdwn` format using the `slackify-markdown` library.
5. The message is also logged to the task's `knowledge.log` as a decision entry.

The PM agent is the only agent with access to `post_to_slack`. Repo agents communicate findings back to PM via `send_message_to_agent`, and PM decides what to relay to the user.

## Interactive Messages

Some system events require user decisions via Slack buttons. These use `postInteractiveToThreads()`, which posts Block Kit messages with action buttons. Currently implemented interactive flows:

- **Edit mode approval**: "Approve" / "Deny" buttons (action IDs: `approve_edit_mode`, `deny_edit_mode`). See [Edit Mode](./edit-mode.md).
- **Research budget approval**: "Approve (+5)" / "Deny" buttons (action IDs: `approve_research_budget`, `deny_research_budget`).

Button clicks are handled by Bolt action handlers in `src/system/server.ts`. When clicked, the handler acknowledges the interaction, updates the original message (removing buttons and showing the outcome), and calls the corresponding handler function (e.g., `handleEditModeApproval()`) which modifies task metadata and reactivates the PM agent.

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

When fetching thread history, `src/slack/client.ts` resolves Slack's opaque mention formats into human-readable text:

- User mentions `<@U123>` become `@<U123:Real Name>`
- Group mentions `<!subteam^S123>` become `@<S123:group-name>`
- Channel mentions `<#C123>` become `#<C123:channel-name>`

This resolution happens in `fetchMentionInfo()` and `applyMentionReplacements()`, which batch-fetch user, group, and channel info before applying replacements across all messages. This ensures agents see human-readable names rather than opaque Slack IDs.

## File Handling

The Slack client extracts file metadata from messages, including files shared directly, files nested in forwarded messages, and image attachments from unfurled links. File metadata is captured as `SlackFile` objects with download URLs. The `downloadSlackFile()` function handles authenticated downloads using the bot token via Bearer authorization headers.

## Relevant Source Files

- `src/slack/client.ts` -- Slack WebClient wrapper, message posting, thread history, mention resolution, file downloads
- `src/system/server.ts` -- Bolt app setup, event handlers, interactive action handlers
- `src/system/webhook-router.ts` -- Slack event routing and bot message filtering
- `src/system/event-handler.ts` -- Triage orchestration and task routing for Slack events
- `src/agents/triage.ts` -- Haiku-based message classifier
- `src/mcp/tools.ts` -- `post_to_slack` tool definition
- `src/system/task-runtime.ts` -- Slack callback injection and `onPostToSlack` implementation
- `src/types/task.ts` -- `SlackThread`, `SlackMessage`, `SlackFile` type definitions
- `slack-manifest.yaml` -- Slack app configuration
- `prompts/pm-agent.md` -- PM agent communication guidelines
