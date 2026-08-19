/**
 * Inbound Slack event → task routing decision (the part worth testing in
 * isolation). Kept dependency-free so it can be unit-tested without the Bolt /
 * Task machinery in events.ts.
 */

/**
 * DENYLIST of `message` subtypes that carry no human-authored content worth routing. Slack ships roughly thirty subtypes and keeps adding them, so this is deliberately a denylist and not an allowlist: anything NOT listed here is forwarded, including a subtype Slack introduces after this code was written. The previous allowlist (empty / `file_share` / `thread_broadcast`) silently dropped every subtype nobody had thought to enumerate — that is the defect this inversion fixes.
 *
 * Every entry earns its place for one of four reasons: it is auto-generated text with no human author (the `channel_join`/`channel_leave`/`group_join`/`group_leave` family, the `channel_archive`/`channel_unarchive`/`group_archive`/`group_unarchive` family, the `channel_convert_to_private`/`channel_convert_to_public`/`channel_posting_permissions` family, and the `pinned_item`/`unpinned_item` notices); it is a body-less marker rather than a message (`message_deleted`, `message_replied`); it is content Slack deliberately withholds (`ekm_access_denied`); or it is already handled on a dedicated path (`message_changed`, which routes to the edit handler before this gate is ever consulted).
 *
 * Deliberately ABSENT — and therefore forwarded: `bot_message`, `me_message`, `huddle_thread`, `assistant_app_thread`, `file_comment`, `channel_topic`, `channel_purpose`, `channel_name` and `reminder_add`. `channel_topic`/`channel_purpose`/`channel_name` carry the author's own words, which is why they count as content rather than as channel noise.
 */
const MESSAGE_NOISE_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'message_replied',
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_archive',
  'channel_unarchive',
  'group_archive',
  'group_unarchive',
  'channel_convert_to_private',
  'channel_convert_to_public',
  'channel_posting_permissions',
  'pinned_item',
  'unpinned_item',
  'ekm_access_denied',
]);

/**
 * Whether an inbound event that has NO existing task should start a new one.
 *
 * True when:
 *  - the bot was @mentioned (`app_mention`), or
 *  - the message is a DM (channel id starts with `D`), or
 *  - it's a reply to a thread the bot itself started (`rootAuthorWasBot`).
 *
 * A plain reply inside a human-started thread the bot wasn't part of returns
 * false → the event is ignored. (Events for threads that already have a task
 * never reach this — they're appended to that task upstream.)
 */
export function shouldCreateNewTask(
  eventType: string,
  channelId: string,
  rootAuthorWasBot: boolean,
): boolean {
  return eventType === 'app_mention' || channelId.startsWith('D') || rootAuthorWasBot;
}

/**
 * Whether an inbound event should be instantly acknowledged (👀 reaction) before
 * any LLM processing. Verbatim extraction of the `isAckable` expression at
 * events.ts:690 — true for `app_mention` (anywhere) or any DM (channel id starts
 * with `D`).
 *
 * A group-DM (`G…`) `app_mention` is ackable only via the `app_mention` arm,
 * never via the `D` prefix — so a non-mention ambient message in a group DM is
 * correctly NOT ackable, preserving the strict D-only DM posture.
 */
export function isAckableEvent(eventType: string, channelId: string): boolean {
  return eventType === 'app_mention' || channelId.startsWith('D');
}

/** The parts of an inbound `message` event the routing predicates below read. `type` is checked one level up, in `shouldForwardMessageEvent`, so the two question-specific predicates don't require it. */
interface MessageEventShape {
  subtype?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  /** Slack-assigned bot identity, present on ANY app-authored post. This is the reliable bot signal, not `subtype`: Slack only sets `subtype: 'bot_message'` for incoming-webhook and `as_user: false` posts, while an app calling `chat.postMessage` with a bot token emits `bot_id` and no subtype at all. The rest of the codebase keys bot-ness on this field too (client.ts, events.ts). */
  bot_id?: string;
}

/**
 * Whether a `message` subtype carries content worth routing at all — i.e. whether it is absent from the noise denylist above. A missing subtype is a plain message and always content-bearing.
 *
 * `bot_message` passes THIS predicate purely by not being on the denylist — the denylist has no special case for it, and adding one would defeat the point of inverting the list. `mayWakeTask` does test it separately, for a different reason: an app post is content worth showing a trigger but not worth spending a PM turn on.
 */
export function isContentBearingSubtype(subtype?: string): boolean {
  return !subtype || !MESSAGE_NOISE_SUBTYPES.has(subtype);
}

/**
 * Whether this event may reach a task Archie is already working in — and nothing else. That is the only question this predicate answers: true for a content-bearing thread reply or DM, regardless of what any trigger is watching.
 *
 * A group-DM (`G…`) message qualifies only via the thread-reply arm, never via the `D`-prefix DM arm — so an ambient top-level `G…` post stays channel-like.
 */
export function mayWakeTask(event: MessageEventShape): boolean {
  const isDm = event.channel.startsWith('D');
  const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
  // An app post DOES wake a task, deliberately. A bot reply lands here only when it is a reply in a thread
  // Archie is already working in — bots do not DM, and a top-level bot post never reaches this arm — so the
  // population is small and high-signal: CI reporting a failed build in the very thread Archie is fixing is
  // exactly what the PM should see. This mirrors the line thread ingestion already draws (`fetchSlackThread`
  // keeps internal bots such as bug-tracker integrations and drops only bots from another workspace), rather
  // than inventing a stricter one.
  //
  // Our own posts never get here: `routeSlackEvent` discards them by `bot_id` and by our bot user id, which is
  // what closes the feedback loop — not this predicate.
  //
  // A bot from a FOREIGN workspace is not filtered here. On the trigger path it is refused explicitly at the
  // call site (deciding it needs the home team id, and this module is deliberately import-free). On this path it
  // needs no guard: `fetchSlackThread` already drops a foreign bot's message from the thread, so its content
  // never reaches an agent. The residue is that such a reply can still wake the task to find nothing new —
  // a wasted turn in a Slack Connect channel, not a leak.
  return isContentBearingSubtype(event.subtype) && (isThreadReply || isDm);
}

/**
 * Whether a channel-message trigger may see this event — and nothing else. That is the only question this predicate answers: true for a content-bearing top-level channel post in a channel some enabled trigger is watching.
 *
 * `hasWatchingTrigger` is consulted only once the post is known to be a top-level channel message, so the trigger-index lookup never runs for a DM or a thread reply.
 */
export function mayReachTriggers(
  event: MessageEventShape,
  hasWatchingTrigger: (channel: string) => boolean,
): boolean {
  const isDm = event.channel.startsWith('D');
  const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
  const isTopLevelChannelMsg = !isDm && !isThreadReply && !event.thread_ts;
  return (
    isContentBearingSubtype(event.subtype) && isTopLevelChannelMsg && hasWatchingTrigger(event.channel)
  );
}

/**
 * Whether an inbound `message` event should be forwarded into task routing — the disjunction of the two independent questions above, which is what the single call site in events.ts needs. The `type === 'message'` check stays here so that call site keeps its shape.
 *
 * `mayWakeTask` is evaluated first and short-circuits the `||`, which is what keeps `hasWatchingTrigger` lazy: the trigger index is never consulted for a DM or a thread reply. Do not hoist the predicate call out of the disjunction.
 */
export function shouldForwardMessageEvent(
  event: MessageEventShape & { type: string },
  hasWatchingTrigger: (channel: string) => boolean,
): boolean {
  return (
    event.type === 'message' && (mayWakeTask(event) || mayReachTriggers(event, hasWatchingTrigger))
  );
}
