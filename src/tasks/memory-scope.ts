import type { SlackMemoryClassification, TaskMemoryDestination, TaskMemoryScope } from '../types/task.js';

export function scopeForSlackChannel(
  scope: SlackMemoryClassification,
  channelId: string,
): TaskMemoryScope {
  switch (scope.kind) {
    case 'user': return { kind: 'user', user_id: scope.user_id, channel_id: channelId };
    case 'channel': return { kind: 'channel', channel_id: channelId };
    case 'public': return { kind: 'public', channel_id: channelId };
    case 'none': return { kind: 'none', channel_id: channelId };
  }
}

export function deriveMemoryDestination(
  channels: Record<string, { type: string; channel_id?: string }>,
  defaultChannelKey?: string | null,
  homeChannelId?: string,
): TaskMemoryDestination | undefined {
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

export function isAuthorizedMemoryScope(
  destination: TaskMemoryDestination | undefined,
  scope: TaskMemoryScope,
): boolean {
  return !!destination
    && scope.kind !== 'none'
    && scope.channel_id === destination.channel_id;
}
