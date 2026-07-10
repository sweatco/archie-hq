/**
 * Trigger visibility — pure decision logic for which triggers are visible from
 * a given Slack context. Kept dependency-free (no Slack client) so it can be
 * unit-tested directly; the live channel-privacy lookup is injected as
 * `resolvePrivacy`.
 *
 * Rules (the "tier of the space the request comes from"):
 *  - Public-channel triggers are visible from every tier.
 *  - Private-channel triggers are visible only from that exact channel.
 *  - DM triggers are visible only from that user's DM.
 *  - Operator context (the CLI) sees everything.
 */

import type { Trigger } from '../types/trigger.js';

export interface TriggerOrigin {
  kind: 'channel' | 'dm' | 'operator';
  /** For channel origin: the originating Slack channel ID. */
  channelId?: string;
  /** For dm origin: the DM partner's Slack user ID. */
  userId?: string;
}

/**
 * Is `trigger` visible from `origin`? `resolvePrivacy(channelId)` must return
 * the channel's CURRENT public/private state (true = private) — resolving it
 * live is what makes a public→private conversion immediately drop the trigger
 * from public/DM listings.
 */
export async function triggerVisibleFrom(
  trigger: Trigger,
  origin: TriggerOrigin,
  resolvePrivacy: (channelId: string) => Promise<boolean>,
): Promise<boolean> {
  if (origin.kind === 'operator') return true;

  if (trigger.binding.type === 'user') {
    return origin.kind === 'dm' && origin.userId === trigger.binding.user_id;
  }

  const isPrivate = await resolvePrivacy(trigger.binding.channel_id);
  if (!isPrivate) return true; // public-channel trigger — visible from any tier
  return origin.kind === 'channel' && origin.channelId === trigger.binding.channel_id;
}
