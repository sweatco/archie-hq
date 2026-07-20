import { describe, expect, it } from 'vitest';
import type { TaskMetadata } from '../../types/task.js';
import { migrateTaskVisibility } from '../task.js';

function metadata(visibility?: unknown): TaskMetadata {
  return {
    task_id: 'task-test',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...(visibility === undefined ? {} : { visibility }),
  } as TaskMetadata;
}

describe('migrateTaskVisibility', () => {
  it.each(['public', 'private'] as const)('preserves valid %s visibility', (visibility) => {
    const value = metadata(visibility);

    expect(migrateTaskVisibility(value)).toBe(false);
    expect(value.visibility).toBe(visibility);
  });

  it('fails closed for legacy metadata without visibility and is idempotent', () => {
    const value = metadata();

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
    expect(migrateTaskVisibility(value)).toBe(false);
  });

  it('fails closed for an unrecognized runtime value', () => {
    const value = metadata('shared');

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
  });
});
