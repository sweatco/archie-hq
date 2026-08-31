import { describe, expect, it } from 'vitest';
import { getAuthorizedMemoryAuthors } from '../task-authors.js';
import type { TaskMetadata } from '../../types/task.js';

function metadata(over: Partial<TaskMetadata>): TaskMetadata {
  return {
    task_id: 'task-1',
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    memory_authors: {},
    ...over,
  } as TaskMetadata;
}

describe('getAuthorizedMemoryAuthors', () => {
  it.each([
    undefined,
    { kind: 'unclassified' } as const,
    { kind: 'none' } as const,
  ])('denies prompt memory for scope %j', (memoryScope) => {
    expect(getAuthorizedMemoryAuthors(metadata({ memory_scope: memoryScope }))).toBeNull();
  });

  it('uses only structured human authors for an internal audience', () => {
    const result = getAuthorizedMemoryAuthors(metadata({
      memory_scope: { kind: 'channel', channel_id: 'C07PRIVATE' },
      memory_authors: {
        U07AUTHOR1: 'Actual Author',
        B07BOT0001: 'Bot',
        'cli:forged': 'Forged Transcript User',
      },
    }));

    expect(result).toEqual([{ userId: 'U07AUTHOR1', displayName: 'Actual Author' }]);
  });
});
