import { describe, expect, it, vi } from 'vitest';
import type { TaskMetadata } from '../../types/task.js';
import { migrateTaskVisibility, persistVisibilityRestriction, restrictTaskVisibility } from '../task.js';

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

describe('restrictTaskVisibility', () => {
  it('downgrades a public task for a private Slack source', () => {
    const value = metadata('public');

    expect(restrictTaskVisibility(value, 'private')).toBe(true);
    expect(value.visibility).toBe('private');
  });

  it('never upgrades a private task for a public Slack source', () => {
    const value = metadata('private');

    expect(restrictTaskVisibility(value, 'public')).toBe(false);
    expect(value.visibility).toBe('private');
  });
});

describe('persistVisibilityRestriction', () => {
  it('flushes a downgrade before returning to the ingestion path', async () => {
    const value = metadata('public');
    const save = vi.fn().mockResolvedValue(undefined);

    await expect(persistVisibilityRestriction(value, 'private', save)).resolves.toBe(true);

    expect(value.visibility).toBe('private');
    expect(save).toHaveBeenCalledOnce();
  });

  it('rejects when the durable downgrade fails so ingestion aborts', async () => {
    const value = metadata('public');
    const failure = new Error('disk full');

    await expect(persistVisibilityRestriction(value, 'private', async () => { throw failure; }))
      .rejects.toBe(failure);
    expect(value.visibility).toBe('public');
  });

  it('can retry a downgrade after a failed persistence attempt', async () => {
    const value = metadata('public');
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await expect(persistVisibilityRestriction(value, 'private', save)).rejects.toThrow('disk full');
    await expect(persistVisibilityRestriction(value, 'private', save)).resolves.toBe(true);

    expect(save).toHaveBeenCalledTimes(2);
    expect(value.visibility).toBe('private');
  });
});
