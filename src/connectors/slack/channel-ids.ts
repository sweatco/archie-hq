/**
 * Slack channel-id classification helpers.
 *
 * Kept dependency-free so the explore/post tools (and their tests) can guard
 * against DM targets without importing the whole Slack client.
 */
import type { Channel, SlackChannel } from '../../types/task.js';

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

/**
 * The muted Slack channel an outbound post to `target` would land in, or null
 * when nothing blocks it. `target` is either a channel key
 * (`slack:C123:456.789`) or a bare channel id (`C123`).
 *
 * A bare id matches ANY muted thread in that channel. That's deliberate: a mute
 * means someone in that channel asked Archie to step back, and opening a fresh
 * thread beside the muted one lands on the same audience — so blocking the key
 * alone would leave `post_to_channel` as an obvious way around the request.
 */
export function findMutedTarget(
  channels: Record<string, Channel>,
  target: string,
): SlackChannel | null {
  const byKey = channels[target];
  if (byKey?.type === 'slack') return byKey.muted ? byKey : null;
  for (const ch of Object.values(channels)) {
    if (ch.type === 'slack' && ch.channel_id === target && ch.muted) return ch;
  }
  return null;
}
