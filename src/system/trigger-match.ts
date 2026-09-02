/**
 * Channel-message trigger matching — the pure predicate that decides whether an
 * inbound Slack message fires a trigger. Dependency-free (no Slack client, no
 * store) so the decision can be unit-asserted directly; the dispatch hook in
 * `connectors/slack/events.ts` supplies the rendered body and the author.
 *
 * The reason this is its own module rather than three lines inside the dispatch
 * hook is the defect it exists to prevent. A Slack message's author is **not
 * always a user id**: an app posting through an incoming webhook (or with
 * `as_user: false`) carries a `bot_id` and no `user` at all. Every other part of
 * this codebase already knows that — `fetchSlackThread` keeps `botId` and
 * renders the author line as `<@B…:Name>`, `dispatchChannelMessageTriggers`
 * gates foreign apps on `bot_id`, and `fireTrigger` takes
 * `event.user || raw.bot_id` as the author. The author FILTER was the one
 * consumer that compared against `event.user` alone, so a filter naming the
 * `B…` id the logs had shown the agent could never match, and the trigger
 * silently never fired.
 */

import type { Trigger, TriggerCondition } from '../types/trigger.js';

/**
 * Every identity Slack attaches to a message's author. At least one is present;
 * which one depends on how the message was posted, never on who posted it:
 *  - `userId` — `U…` (or `W…` on Enterprise Grid) for a human, and for an app
 *    posting as a user.
 *  - `botId` — `B…` on ANY app-authored post, and frequently the only id there
 *    is (incoming webhooks and `as_user: false` carry no `user`).
 */
export interface MessageAuthor {
  userId?: string;
  botId?: string;
}

/** The parts of an inbound message the match predicate reads. */
export interface MessageMatchInput {
  channelId: string;
  /** The RENDERED body — what an agent would be shown, not the raw `text` field. */
  body: string;
  author: MessageAuthor;
}

/**
 * Shape of a Slack author id usable as a `from_user` filter: a user (`U…`), an
 * Enterprise Grid user (`W…`), or an app/bot (`B…`).
 *
 * Validating the shape is what turns a mistyped or wrong-kind filter into a
 * refusal at creation time instead of a trigger that is accepted, announced,
 * listed as active, and then never fires. Slack ids are uppercase alphanumeric
 * and at least 9 characters in practice; the floor here is deliberately looser
 * than that so a future id length cannot make a legitimate filter unusable.
 */
const SLACK_AUTHOR_ID = /^[UWB][A-Z0-9]{2,}$/;

/** Is `id` shaped like an author id a message can actually carry? */
export function isSlackAuthorId(id: string): boolean {
  return SLACK_AUTHOR_ID.test(id);
}

/** Does `id` name an app rather than a person? (Only the id shape can tell.) */
export function isAppAuthorId(id: string): boolean {
  return id.startsWith('B');
}

/**
 * Does the author filter name this message's author?
 *
 * Compared against BOTH ids the payload can carry, because which one is present
 * is a property of how the message was posted rather than of the author. Empty
 * ids never match — `handleSlackEvent` normalizes a missing `user` to `''`, and
 * an `''` filter matching an authorless post would fire a trigger on everything.
 */
export function authorFilterMatches(filter: string, author: MessageAuthor): boolean {
  if (!filter) return false;
  return (!!author.userId && filter === author.userId) || (!!author.botId && filter === author.botId);
}

/** Does one condition fire on this message? */
function conditionMatches(c: TriggerCondition, input: MessageMatchInput): boolean {
  if (c.type !== 'channel_message' || c.channel_id !== input.channelId) return false;
  if (c.match?.contains && !input.body.toLowerCase().includes(c.match.contains.toLowerCase())) return false;
  if (c.match?.from_user && !authorFilterMatches(c.match.from_user, input.author)) return false;
  return true;
}

/** Does any of the trigger's conditions fire on this message? */
export function messageMatchesTrigger(trigger: Trigger, input: MessageMatchInput): boolean {
  return trigger.conditions.some((c) => conditionMatches(c, input));
}
