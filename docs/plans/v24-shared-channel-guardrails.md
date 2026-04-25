# Shared-Channel Guardrails (External-Org Filtering)

## Context

Archie operates in Slack channels that can be shared with external organisations (Slack Connect). Today the integration has no notion of "home org" vs "external org": every human message reaches the PM agent with full content, file attachments are downloaded to the task sandbox, external `@mentions` can create or unmute tasks, and there is no user-visible signal that a channel is externally visible. This is a prompt-injection surface (external text can steer an autonomous agent with code-edit and posting powers), a data-egress surface (Archie may post sensitive internal content on behalf of an internal user into a shared channel), and an attachment-exfil surface (files uploaded by externals get fetched into the task workspace).

Intended outcome: in any shared channel, (a) messages authored by external participants are structurally visible to the agent but content-redacted; (b) forwarded/unfurled external messages are kept with a provenance label so the agent sees explicit "came from external" signal and an internal user who chose to forward is on-record; (c) internal users in the thread receive a one-time ephemeral warning the first time Archie is active in that thread, and separately a one-time ephemeral when they forward external content; (d) external messages cause Archie to bail out of the event handler entirely (no agent spawn, no task creation, no reactions); (e) the PM agent's prompt is annotated when operating in a shared channel.

Guests (single/multi-channel guests on the home workspace) are treated as external under the same rules.

## Design

### 1. Capture home team ID at startup

`auth.test()` today captures `user_id`, `bot_id`, `url` but **not** `team_id`. Extend [initSlackClient()](src/connectors/slack/client.ts#L33-L46) to also read `team_id` from the `auth.test()` response (it *is* present in the API response — just not currently read) and store it in a module-level `homeTeamId: string | null`. Export `getHomeTeamId()`. No new env var.

### 2. Shared-channel detection with 1-minute TTL cache

New module-level cache in [src/connectors/slack/client.ts](src/connectors/slack/client.ts):

```ts
type ChannelSharedInfo = { isShared: boolean; fetchedAt: number };
const channelSharedCache = new Map<string, ChannelSharedInfo>();
const CHANNEL_SHARED_TTL_MS = 60_000;

export async function isChannelShared(channelId: string): Promise<boolean>;
```

Implementation calls `conversations.info({ channel })` and evaluates:
`is_ext_shared || is_pending_ext_shared || (connected_team_ids?.length ?? 0) > 1`.
(`is_shared` alone is true for org-wide channels in Enterprise Grid; `is_ext_shared` is the external-org signal.) 1-minute TTL per channel; respect Slack's tier-3 rate limit (50+/min).

DMs (`channelId` starting with `D`) short-circuit to `false` without an API call.

### 3. Classify users as external

Extend [SlackUserInfo](src/connectors/slack/client.ts#L863-L872) with `teamId: string`, `isRestricted: boolean`, `isUltraRestricted: boolean`. Populate in both [getUserInfo()](src/connectors/slack/client.ts#L652-L662) (from `users.info` response: `user.team_id`, `user.is_restricted`, `user.is_ultra_restricted`) and [listWorkspaceUsers()](src/connectors/slack/client.ts#L882-L913).

New helper:
```ts
export function isExternalUser(info: SlackUserInfo): boolean {
  const home = getHomeTeamId();
  if (!home) return false;  // fail-open if auth.test() didn't return team_id
  return info.teamId !== home || info.isRestricted || info.isUltraRestricted;
}
```

Fail-open behaviour is acceptable because the alternative (fail-closed on missing team_id) would filter *everyone* and break the bot. We log a warning at startup if `homeTeamId` is null.

### 4. Redact external messages in thread ingestion

Extend [SlackThreadMessage](src/types/task.ts#L23-L28) with:
```ts
externalAuthor?: boolean;  // true when user is external per isExternalUser()
redacted?: boolean;        // true when text/files should be treated as filtered
```

In [fetchSlackThread()](src/connectors/slack/client.ts#L795-L837), after resolving user info, check `isChannelShared(channelId)`:

- If channel is **not shared**: behaviour unchanged.
- If channel **is shared**: for each message whose author is external, emit a message object with `externalAuthor: true, redacted: true`, `text: ''`, no `files`, and `user: { id: msg.user, username: '<external>', realName: '<external>' }`. Do not fetch their real name (avoid a `users.info` side-trip for an external user; we only need the ID).

### 5. Forwarded/unfurled external messages: preserve content with provenance label

Slack delivers forwarded messages and permalink-unfurls as a parent `message` (authored by the internal forwarder) with `attachments[]` where each attachment has `is_msg_unfurl: true` (permalink) or comes from a forward variant containing `author_id`, `text`, `ts`, and `channel_id` for the *original* message.

When the top-level author is **internal** in a shared channel, walk `attachments[]` for entries with `is_msg_unfurl: true` or a populated `author_id`. For any attachment whose `author_id` resolves to an external user (via cached `getUserInfo` + `isExternalUser`):

1. Set `msg.forwardedFromExternal = { authorId, authorTeamId }` on the outer `SlackThreadMessage`.
2. Keep the forwarded text content.
3. In the knowledge log (§7), prepend the message with `[forwarded from @<Uext:team T>]` so the agent sees explicit provenance. Rationale: keeping the metadata lets the agent treat forwarded-external content with appropriate skepticism rather than mistaking it for something the internal user authored themselves.

This flag also drives Warning B (§10).

Extend `SlackThreadMessage` accordingly:
```ts
forwardedFromExternal?: { authorId: string; authorTeamId: string };
```

### 6. Update `SlackChannel` metadata

Extend [SlackChannel](src/types/task.ts#L47-L55):

```ts
export interface SlackChannel extends ChannelBase {
  type: 'slack';
  thread_id: string;
  channel_id: string;
  channel_name: string;
  last_processed_ts: string;
  url?: string;
  muted?: boolean;
  isShared?: boolean;                  // snapshot of last observed state
  warnedUsers?: string[];              // user IDs warned about shared channel
  forwardNotifiedUsers?: string[];     // user IDs notified after forwarding externally-authored content
}
```

No migration needed (optional fields; existing tasks pick up values on next message).

On each inbound message, after computing `shared = await isChannelShared(channelId)`, write `existing.isShared = shared`. No clearing of warning lists on transitions — a user who was never warned (because the channel was previously not shared) will be warned automatically by the diff logic in §10 the next time a message arrives post-transition.

The stored flag is a debugging/observability snapshot; the runtime decision always uses the cached `isChannelShared()` result.

### 7. Knowledge-log format

In [appendSlackMessage()](src/tasks/persistence.ts#L178-L205), extend the signature to take the `SlackThreadMessage` (or an equivalent shape carrying the new flags) rather than unpacking only `userInfo/message/files`. Three format variants:

- **Normal:** unchanged — `@<U123:Real Name> in slack:#C:thread` + text.
- **External redacted:** source stays `@<U123:external> in slack:#C:thread`; message body is a short fixed placeholder indicating it was filtered (exact wording decided at implementation time and kept out of the PM prompt so the two can evolve independently). No file info.
- **Forwarded from external:** source is the internal forwarder (unchanged); message body prefixed with `[forwarded from @<Uext:team T>]` followed by the forwarded text. Provenance is kept so the agent can treat forwarded-external content with appropriate skepticism.

Rationale: the agent sees who spoke (user ID + timestamp) so it can count distinct speakers and notice conversational shape, but sees no external-authored text — except where an internal user explicitly chose to forward it, in which case provenance is preserved.

### 8. Bail out of the handler on external-authored events

In [handleSlackEvent()](src/connectors/slack/events.ts#L272-L364), as the very first step (before the eyes-reaction at L287), resolve the event author's external status (`getUserInfo` + `isExternalUser`). If external:

- Return immediately. No `fetchSlackThread`, no `task.append`, no agent spawn, no `addReaction`, no task creation, no unmute.

Rationale: redacted external messages carry no useful signal for the agent to act on, so spawning an agent turn on them is pure waste. When an *internal* user next triggers the handler, `fetchSlackThread` re-reads the full thread history and redacts externals inline at that point — so no external message is ever lost to the log; it just lands in the log lazily at the next internal event.

DMs: a DM from an external-classified user hits this same bail-out (DMs aren't "shared channels" but the external classification still applies to the author), so a guest DMing Archie silently does nothing.

### 9. Skip file downloads from external authors

In [Task.append()](src/tasks/task.ts#L210-L246), the two `downloadMessageFiles(...)` calls must short-circuit when `msg.externalAuthor === true` (files are already stripped in §4, so this is defence-in-depth). The attachment note in the knowledge log becomes `[Attachments: <filtered>]` if `redacted`.

### 10. Ephemeral warnings

New helper in [src/connectors/slack/client.ts](src/connectors/slack/client.ts):

```ts
export async function postEphemeral(
  channel: string,
  user: string,
  text: string,
): Promise<void>;
```

Thin wrapper around `chat.postEphemeral({ channel, user, text, thread_ts? })`. Respect `dryRun` flag (same as `postToThread`).

**Warning A — shared-channel awareness (per thread × user):**

On every inbound message handled by [handleSlackEvent](src/connectors/slack/events.ts#L272), after the external-author bail-out (§8) and after confirming the channel is shared and a task exists (or is being created), compute the thread participants from the already-fetched `thread.messages`. Filter to internal-only (skip externals — they presumably know they're external — and skip the bot). Diff against `channel.warnedUsers`. For each new user in the delta, post an ephemeral (`thread_ts = channel.thread_id`) with text roughly:

> ⚠️ Heads up: this thread is in a shared channel with external org(s). Archie filters messages from external participants — if you need Archie to see something an external person said, re-say it yourself. Also be aware: anything Archie posts here (including on your behalf) is visible to the external org, so mind what you ask Archie to share.

Union the delta into `warnedUsers` and persist.

**Warning B — forward awareness (per thread × internal forwarder):**

When §5 detection flags the event as forwarded-from-external, if the forwarder's ID is not in `channel.forwardNotifiedUsers`, post an ephemeral:

> ℹ️ You forwarded a message from an external user. Archie will process its contents — just making sure you're aware.

Add the forwarder to `forwardNotifiedUsers`. (No "Continue" button — pre-send interception isn't possible with Slack events anyway.)

Both warnings are additive: a single message can trigger both.

### 11. PM prompt: shared-channel notice

In [src/agents/pm.ts](src/agents/pm.ts) (or wherever per-task system-prompt assembly happens — to confirm during implementation since Phase-1 only confirmed `prompts.ts` has the generic `newTask`/`existingTask` constants), inject a short notice when *any* of the task's Slack channels has `isShared === true`:

> NOTE: This task is active in a Slack channel shared with an external organisation. Messages from external participants are filtered before they reach you. Be mindful that anything you post will be visible to the external org. Do not share repository contents, credentials, internal URLs, or task history with external parties.

The prompt deliberately does not quote the exact redaction placeholder so the two can evolve independently. Recompute on each turn (cheap — already iterating channels for other reasons).

### 12. External user handling in DMs

DMs short-circuit §2's `isChannelShared` check to `false`, but the §8 bail-out is author-based, not channel-based, so an external-classified user (incl. guests) DMing Archie triggers the same bail-out and Archie does nothing. No task created, no reply. This matches "guests = externals, same rules" — externals shouldn't be able to privately drive Archie.

## Critical Files

- [src/connectors/slack/client.ts](src/connectors/slack/client.ts) — `initSlackClient` (L33), `SlackUserInfo` (L863), `getUserInfo` (L652), `listWorkspaceUsers` (L882), `fetchSlackThread` (L795), `fetchThreadHistory` (L341), `postToThread` (L86); new `isChannelShared`, `isExternalUser`, `postEphemeral`, `getHomeTeamId`.
- [src/connectors/slack/events.ts](src/connectors/slack/events.ts) — `app_mention` handler (L78), `message` handler (L101), `handleSlackEvent` (L272).
- [src/types/task.ts](src/types/task.ts) — `SlackChannel` (L47), `SlackThreadMessage` (L23).
- [src/tasks/persistence.ts](src/tasks/persistence.ts) — `appendSlackMessage` (L178).
- [src/tasks/task.ts](src/tasks/task.ts) — `Task.append` (L210), `registerSlackChannel` (L413), `downloadMessageFiles` call sites.
- [src/agents/pm.ts](src/agents/pm.ts) / [src/agents/prompts.ts](src/agents/prompts.ts) — shared-channel notice injection.

## Reused Utilities

- `conversations.info` call pattern already exists at [client.ts:284-286](src/connectors/slack/client.ts#L284) — extend, don't duplicate.
- `userCache` pattern at [client.ts:882](src/connectors/slack/client.ts#L882) — mirror its TTL-cache shape for `channelSharedCache`.
- `dryRun` guard pattern in `postToThread`/`postNewMessage` — reuse in `postEphemeral`.
- `restoreMentions` + `slackifyMarkdown` pipeline — reuse when building ephemeral text.

## Verification

Manual end-to-end tests (no existing test suite covers Slack flows):

1. **Home-org message, non-shared channel:** `npm run dev`, have an internal user DM / @mention Archie. Confirm unchanged behaviour: knowledge.log shows full name+text, no ephemeral sent.
2. **External user in shared channel (no internal user yet):** set up a test shared channel; have an external user @mention Archie; confirm: (a) handler bails out — no task created, no knowledge.log entry yet, no `eyes` reaction, no agent spawn.
3. **Internal user in shared channel after external activity:** internal user @mentions Archie in the same thread; confirm: (a) task created with `isShared: true`, (b) knowledge.log now contains the *earlier* external message as a redacted entry (because `fetchSlackThread` re-reads history and redacts on read), (c) ephemeral Warning A posted to the internal user.
4. **Second internal user joins mid-thread:** have a different internal user reply; confirm Warning A is posted to the new user and not re-posted to the first.
5. **Forwarding:** internal user forwards an external message into the thread using Slack's native forward; confirm: (a) knowledge.log entry has `[forwarded from @<Uext:team T>]` prefix with content preserved, (b) Warning B ephemeral goes to the forwarder, (c) second forward by same user → no second Warning B.
6. **Channel becomes shared mid-task:** start a task in a non-shared channel, then add an external org; confirm next internal message triggers Warning A for all current thread participants (the thread had no shared history so nobody had been warned before).
7. **Guest DM:** have a single-channel guest DM Archie; confirm handler bails out (no task created, no reply, no log entry).
8. **Home team ID missing:** force `homeTeamId = null` by mocking `auth.test()` response; confirm fail-open (nothing filtered) and a startup warning log.
9. **Rate limit sanity:** send 30 messages in a minute across a single shared channel; confirm only 1 `conversations.info` call was issued (the 1-min TTL held).
10. **Type check:** `npm run typecheck` passes.
