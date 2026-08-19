/**
 * Slack channel-id classification helpers.
 *
 * Kept dependency-free so the explore/post tools (and their tests) can guard
 * against DM targets without importing the whole Slack client.
 */
import type { Channel, SlackChannel, TaskMetadata } from '../../types/task.js';

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

/**
 * Slack channel id → display label for every channel this task's standing context covers, in link order.
 *
 * One derivation, shared by the channel-canvas and pinned-message prompt blocks, so the two cannot drift on which channels they consider: a task that gets a channel's canvas brief is a task that gets that channel's pin index, and vice versa.
 *
 * It is inclusive of `metadata.home_channel` because a trigger-fired task has no thread yet, so `metadata.channels` is empty when its FIRST agent — the one that actually does the work — spawns. Deriving coverage from links alone would hand that agent no brief and no pin index, and only supply them on some later wake, once its own thread exists.
 *
 * Linked channels are walked first and first-link-wins, so a channel that is both linked and the home channel keeps the label it already had and is never listed twice.
 */
export function taskSlackChannelLabels(metadata: TaskMetadata): Map<string, string> {
  const labels = new Map<string, string>();
  for (const ch of Object.values(metadata.channels)) {
    if (ch.type === 'slack' && !labels.has(ch.channel_id)) {
      labels.set(ch.channel_id, ch.channel_name ? `#${ch.channel_name}` : ch.channel_id);
    }
  }
  const home = metadata.home_channel;
  if (home && !labels.has(home.channel_id)) {
    labels.set(home.channel_id, home.channel_name ? `#${home.channel_name}` : home.channel_id);
  }
  return labels;
}

/**
 * The Slack channel ids this task covers — the keys of {@link taskSlackChannelLabels}, so exactly the channels whose standing context the task is given.
 *
 * Prompt and capability must be derived from the SAME set. When they were not, a threadless trigger-fired task was handed its home channel's canvas brief and pin index while every capability those blocks tell it to use — `fetch_slack_reference` on a referenced file, `read_channel_history` on the channel itself — still resolved from linked channels alone, so the first turn's instructions pointed at tools that refused. Sharing one derivation is what keeps the two in step.
 */
export function taskSlackChannelIds(metadata: TaskMetadata): Set<string> {
  return new Set(taskSlackChannelLabels(metadata).keys());
}
