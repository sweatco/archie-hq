/**
 * `metadata.repositories` shape migration → the flat `AttachedRepo[]`.
 *
 * This runs against real production task metadata on Task.get, so the
 * round-trip must preserve everything that drives in-flight work: clone paths
 * (so an edit-mode task reuses its existing working tree), branch state, PR
 * numbers, and the comment-dedup cursor — those are what the GitHub webhook
 * lookups resolve a task by.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskMetadata } from '../../types/task.js';
import { migrateRepositoriesShape, readRepositories } from '../task.js';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../system/logger.js';

/** Minimal metadata wrapper — only `repositories` matters for these tests. */
function meta(repositories: any): TaskMetadata {
  return {
    task_id: 'task-test',
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories,
    status: 'in_progress',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as TaskMetadata;
}

describe('migrateRepositoriesShape', () => {
  it('flattens a per-agent map, preserving clone path + branch/PR state', () => {
    const m = meta({
      'backend-agent': [
        {
          github: 'acme/backend',
          base_path: '/workdir/repos/acme/backend',
          clone_path: '/sessions/task-test/repos/backend-agent/acme/backend',
          current_branch: 'archie/task-test',
          branch_states: {
            'archie/task-test': { base_branch: 'main', pr_number: 42, last_processed_comment_id: 1001 },
          },
        },
      ],
    });

    expect(migrateRepositoriesShape(m)).toBe(true);
    expect(m.repositories).toHaveLength(1);

    const att = m.repositories[0];
    expect(att.github).toBe('acme/backend');
    // clone_path preserved → an edit-mode task reuses its working tree.
    expect(att.clone_path).toBe('/sessions/task-test/repos/backend-agent/acme/backend');
    // base_path preserved → the sandbox grants read access to the base cache
    // this clone's alternates actually points at.
    expect(att.base_path).toBe('/workdir/repos/acme/backend');
    expect(att.current_branch).toBe('archie/task-test');
    // Branch/PR/comment-dedup state survives intact — this is what
    // findTaskByPRNumber / findTaskByBranch resolve on.
    expect(att.branch_states!['archie/task-test']).toEqual({
      base_branch: 'main',
      pr_number: 42,
      last_processed_comment_id: 1001,
    });
  });

  it('unions several agents into one list, keyed by github', () => {
    const m = meta({
      'backend-agent': [{ github: 'acme/backend', clone_path: '/c/backend' }],
      'mobile-agent': [{ github: 'acme/mobile', clone_path: '/c/mobile' }],
    });

    migrateRepositoriesShape(m);

    expect(m.repositories.map((r) => r.github).sort()).toEqual(['acme/backend', 'acme/mobile']);
  });

  it('dedupes a repo two agents both mounted, keeping the first entry', () => {
    const m = meta({
      'backend-agent': [
        {
          github: 'acme/backend',
          clone_path: '/c/backend',
          branch_states: { 'archie/task-test': { pr_number: 42 } },
        },
      ],
      'infra-agent': [
        { github: 'acme/backend', clone_path: '/c/infra/backend', branch_states: {} },
      ],
    });

    migrateRepositoriesShape(m);

    expect(m.repositories).toHaveLength(1);
    expect(m.repositories[0].clone_path).toBe('/c/backend');
    expect(m.repositories[0].branch_states!['archie/task-test'].pr_number).toBe(42);
  });

  it('drops pre-v30 entries, whose github identifier is no longer resolvable', () => {
    const m = meta({
      'backend-agent': [{ github: 'acme/backend', clone_path: '/c/backend' }],
      // Pre-v30 shape: keyed by a short repo name, no github field anywhere.
      mobile: { path: '/workdir/repos/mobile', clone_path: '/c/mobile', current_branch: 'main' },
    });

    migrateRepositoriesShape(m);

    expect(m.repositories.map((r) => r.github)).toEqual(['acme/backend']);
  });

  it('is a no-op on the already-flat shape — idempotent', () => {
    const alreadyFlat = [
      {
        github: 'acme/backend',
        clone_path: '/c/backend',
        current_branch: 'archie/task-test',
        branch_states: { 'archie/task-test': { base_branch: 'main', pr_number: 42 } },
      },
    ];
    const m = meta(alreadyFlat);

    expect(migrateRepositoriesShape(m)).toBe(false);
    expect(m.repositories).toBe(alreadyFlat);
  });

  it('running twice produces the same result (migration then no-op)', () => {
    const m = meta({
      'backend-agent': [
        { github: 'acme/backend', clone_path: '/c/backend', branch_states: { 'feature/x': { pr_number: 9 } } },
      ],
    });

    migrateRepositoriesShape(m);
    const afterFirst = JSON.parse(JSON.stringify(m.repositories));
    expect(migrateRepositoriesShape(m)).toBe(false);
    expect(m.repositories).toEqual(afterFirst);
  });

  it('turns an empty legacy map into an empty list', () => {
    const m = meta({});
    expect(migrateRepositoriesShape(m)).toBe(true);
    expect(m.repositories).toEqual([]);
  });

  it('turns a missing/garbage value into an empty list rather than throwing', () => {
    const m = meta(undefined);
    expect(migrateRepositoriesShape(m)).toBe(true);
    expect(m.repositories).toEqual([]);
  });
});

/**
 * The read-only half. Webhook routing walks every candidate a fleet-wide scan
 * turned up, so it needs the flat view of a legacy task without upgrading one:
 * same list, no write-back, no log line about a task nobody is running.
 */
describe('readRepositories', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('returns the same list the migration would, without touching the metadata', () => {
    const legacy = {
      'backend-agent': [{ github: 'acme/backend', clone_path: '/c/backend' }],
      'mobile-agent': [{ github: 'acme/mobile', clone_path: '/c/mobile' }],
    };
    const m = meta(legacy);

    expect(readRepositories(m).map((r) => r.github)).toEqual(['acme/backend', 'acme/mobile']);
    // Untouched: the on-disk shape is still what the previous engine wrote.
    expect(m.repositories).toBe(legacy as unknown as TaskMetadata['repositories']);
  });

  it('drops pre-v30 entries silently — a lookup must not log about a task it is only inspecting', () => {
    const m = meta({
      'backend-agent': [{ github: 'acme/backend', clone_path: '/c/backend' }],
      mobile: { path: '/workdir/repos/mobile', clone_path: '/c/mobile' },
    });

    expect(readRepositories(m).map((r) => r.github)).toEqual(['acme/backend']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns the flat list as-is, and an empty list for a missing value', () => {
    const flat = [{ github: 'acme/backend', clone_path: '/c/backend' }];
    expect(readRepositories(meta(flat))).toBe(flat);
    expect(readRepositories(meta(undefined))).toEqual([]);
  });
});
