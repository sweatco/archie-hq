import type { TaskMetadata } from '../types/task.js';
import type { UserRef } from './types.js';
import { isMemoryHumanUserId } from './paths.js';

export function getAuthorizedMemoryAuthors(metadata: TaskMetadata): UserRef[] | null {
  const authors = Object.entries(metadata.memory_authors ?? {})
    .filter(([userId]) => isMemoryHumanUserId(userId))
    .map(([userId, displayName]) => ({ userId, displayName }));
  return authors.length > 0 ? authors : null;
}
