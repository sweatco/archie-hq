/**
 * Slack channel-id classification helpers.
 *
 * Kept dependency-free so the explore/post tools (and their tests) can guard
 * against DM targets without importing the whole Slack client.
 */

/**
 * True when `id` is a 1:1 DM channel (`D…`) or a user id (`U…`/`W…`) that Slack
 * would coerce into a DM if passed as a channel. The explore/post tools reject
 * these so they never read from or write to a DM.
 *
 * Note: this does NOT catch private channels or group DMs (whose ids start with
 * `C`/`G`) — for reads those are gated at the API layer via
 * `assertAccessibleChannel` (`is_private`/`is_mpim` flags), because the prefix
 * alone is ambiguous.
 */
export function isDmOrUserId(id: string): boolean {
  return /^[DUW]/.test(id);
}
