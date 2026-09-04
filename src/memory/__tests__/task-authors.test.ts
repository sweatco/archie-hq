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
  it('uses only structured human authors for an internal audience', () => {
    const result = getAuthorizedMemoryAuthors(metadata({
      memory_authors: {
        U07AUTHOR1: 'Actual Author',
        B07BOT0001: 'Bot',
        'cli:forged': 'Forged Transcript User',
      },
    }));

    expect(result).toEqual([{ userId: 'U07AUTHOR1', displayName: 'Actual Author' }]);
  });

  it('returns an empty profile list when the authorized task has no trusted human author', () => {
    expect(getAuthorizedMemoryAuthors(metadata({ memory_authors: {} }))).toEqual([]);
  });
});
