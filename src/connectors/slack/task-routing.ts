/**
 * Inbound Slack event → task routing decision (the part worth testing in
 * isolation). Kept dependency-free so it can be unit-tested without the Bolt /
 * Task machinery in events.ts.
 */

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

/**
 * Whether an inbound `message` event should be forwarded into task routing.
 * Verbatim extraction of the inline filter at events.ts:167-180.
 *
 * Returns false unless `type === 'message'` and the subtype is empty or one of
 * `file_share` / `thread_broadcast`. Otherwise forwards when the message is a
 * thread reply, a DM, or a watched top-level channel post.
 *
 * `hasWatchingTrigger` is a lazy predicate: it is only consulted for top-level
 * channel posts, so the trigger-index lookup still never runs for DMs or thread
 * replies — preserving the exact lookup timing of the original inline code.
 *
 * A group-DM (`G…`) message is forwarded only via the thread-reply or watched-
 * trigger arms, never via the `D`-prefix DM arm — so an ambient top-level `G…`
 * post with no watching trigger is treated channel-like and ignored.
 */
export function shouldForwardMessageEvent(
  event: {
    type: string;
    subtype?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  },
  hasWatchingTrigger: (channel: string) => boolean,
): boolean {
  if (event.type !== 'message') {
    return false;
  }
  if (event.subtype && !['file_share', 'thread_broadcast'].includes(event.subtype)) {
    return false;
  }
  const isDm = event.channel.startsWith('D');
  const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
  const isTopLevelChannelMsg = !isDm && !isThreadReply && !event.thread_ts;
  const watchedByTrigger = isTopLevelChannelMsg && hasWatchingTrigger(event.channel);
  return isThreadReply || isDm || watchedByTrigger;
}
