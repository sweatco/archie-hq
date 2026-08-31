import type { TaskMetadata } from '../types/task.js';
import type { UserRef } from './types.js';
import { isMemoryHumanUserId } from './paths.js';

export function getAuthorizedMemoryAuthors(metadata: TaskMetadata): UserRef[] | null {
  const scope = metadata.memory_scope;
  if (!scope || scope.kind === 'unclassified' || scope.kind === 'none') return null;
  return Object.entries(metadata.memory_authors ?? {})
    .filter(([userId]) => isMemoryHumanUserId(userId))
    .map(([userId, displayName]) => ({ userId, displayName }));
}
