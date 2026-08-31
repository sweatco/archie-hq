import type { TaskMemoryExposureScope, TaskMemoryScope } from '../types/task.js';

export type ClassifiedMemoryScope = Exclude<TaskMemoryScope, { kind: 'unclassified' }>;

export function joinMemoryScope(
  current: TaskMemoryScope | undefined,
  incoming: ClassifiedMemoryScope,
): TaskMemoryScope {
  if (!current) return { kind: 'none' };
  if (current.kind === 'unclassified') return incoming;
  if (current.kind === 'none' || incoming.kind === 'none') return { kind: 'none' };

  if (current.kind === 'public' && incoming.kind === 'public') {
    return {
      kind: 'public',
      channel_id: current.channel_id === incoming.channel_id ? current.channel_id : null,
    };
  }

  if (current.kind === 'channel' && incoming.kind === 'channel') {
    return current.channel_id === incoming.channel_id ? current : { kind: 'none' };
  }

  if (current.kind === 'user' && incoming.kind === 'user') {
    return current.user_id === incoming.user_id ? current : { kind: 'none' };
  }

  if (current.kind === 'public' && incoming.kind === 'channel') {
    return current.channel_id === incoming.channel_id ? incoming : { kind: 'none' };
  }

  if (current.kind === 'channel' && incoming.kind === 'public') {
    return current.channel_id === incoming.channel_id ? current : { kind: 'none' };
  }

  return { kind: 'none' };
}

export function joinMemoryExposureScope(
  current: TaskMemoryExposureScope | undefined,
  incoming: TaskMemoryExposureScope,
): TaskMemoryExposureScope {
  if (!current) return incoming;
  if (current.kind === 'none' || incoming.kind === 'none') return { kind: 'none' };
  if (current.kind === 'internal') return incoming;
  if (incoming.kind === 'internal') return current;
  if (current.kind === 'channel' && incoming.kind === 'channel') {
    return current.channel_id === incoming.channel_id ? current : { kind: 'none' };
  }
  if (current.kind === 'user' && incoming.kind === 'user') {
    return current.user_id === incoming.user_id ? current : { kind: 'none' };
  }
  return { kind: 'none' };
}

export function isMemoryDeliveryCompatible(
  exposure: TaskMemoryExposureScope,
  destination: ClassifiedMemoryScope,
): boolean {
  if (destination.kind === 'none') return false;
  if (exposure.kind === 'internal') return true;
  if (exposure.kind === 'channel') {
    return destination.kind === 'channel' && destination.channel_id === exposure.channel_id;
  }
  if (exposure.kind === 'user') {
    return destination.kind === 'user' && destination.user_id === exposure.user_id;
  }
  return false;
}
