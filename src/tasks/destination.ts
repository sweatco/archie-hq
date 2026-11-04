// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SlackChannel, TaskMetadata } from '../types/task.js';

export function approvedReplyConversation(metadata: TaskMetadata): { key: string; channel: SlackChannel } | undefined {
  if (!metadata.approved_start) return;
  const key = metadata.default_channel;
  const channels = metadata.channels ?? {};
  const channel = key ? channels[key] : undefined;
  if (!key || channel?.type !== 'slack' || typeof channel.channel_id !== 'string' || !channel.channel_id.startsWith('D')
    || typeof channel.thread_id !== 'string' || !/^\d+\.\d+$/.test(channel.thread_id)
    || key !== `slack:${channel.channel_id}:${channel.thread_id}` || Object.keys(channels).length !== 1
    || metadata.home_channel || metadata.memory_destination?.channel_id !== channel.channel_id) {
    throw new Error('Approved task has no consistent owner reply conversation');
  }
  return { key, channel };
}

export function deriveTaskDestination(
  channels: Record<string, { type: string; channel_id?: string }>,
  defaultChannelKey?: string | null,
  homeChannelId?: string,
): { channel_id: string } | undefined {
  if (homeChannelId) return { channel_id: homeChannelId };
  if (defaultChannelKey) {
    const channel = channels[defaultChannelKey];
    if (channel?.type === 'slack' && channel.channel_id) {
      return { channel_id: channel.channel_id };
    }
  }
  const ids = new Set<string>();
  for (const channel of Object.values(channels)) {
    if (channel.type === 'slack' && channel.channel_id) ids.add(channel.channel_id);
  }
  return ids.size === 1 ? { channel_id: [...ids][0]! } : undefined;
}

