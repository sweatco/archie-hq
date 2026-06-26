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
