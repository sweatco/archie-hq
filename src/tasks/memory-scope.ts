import type { SlackMemoryClassification, TaskMemoryDestination, TaskMemoryScope } from '../types/task.js';

export function scopeForSlackChannel(
  scope: SlackMemoryClassification,
  channelId: string,
): TaskMemoryScope {
  switch (scope.kind) {
    case 'user': return { kind: 'user', user_id: scope.user_id, channel_id: channelId };
    case 'private_channel': return { kind: 'private_channel', channel_id: channelId };
    case 'public': return { kind: 'public', channel_id: channelId };
    case 'none': return { kind: 'none', channel_id: channelId };
  }
}

export { deriveTaskDestination as deriveMemoryDestination } from './destination.js';

export function isAuthorizedMemoryScope(
  destination: TaskMemoryDestination | undefined,
  scope: TaskMemoryScope,
): boolean {
  return !!destination
    && scope.kind !== 'none'
    && scope.channel_id === destination.channel_id;
}
