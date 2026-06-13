/**
 * v30 migration: legacy `metadata.repositories` (Record<repoKey, RepositoryInfo>)
 * → new shape (Record<agentId, AttachedRepo[]>).
 *
 * This runs against real production task metadata on Task.get, so the round-trip
 * must preserve everything that drives in-flight work: clone paths (so RW tasks
 * reuse their existing working tree), branch state, PR numbers, and the
 * comment-dedup cursor. These tests feed representative legacy shapes through
 * the migration and assert nothing is lost.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';
import { __setRegistryForTesting } from '../../agents/registry.js';
import { migrateRepositoriesShape } from '../task.js';

function repoDef(key: string, github: string): AgentDef {
  return {
    id: `${key}-agent`,
    key,
    role: `${key} role`,
    expertise: `${key} expertise`,
    pluginName: 'engineering',
    visibility: 'global',
    repo: { repos: [{ github, baseBranch: 'main' }], primary: github },
  } as AgentDef;
}

/** Minimal metadata wrapper — only `repositories` matters for these tests. */
function meta(repositories: any): TaskMetadata {
  return {
    task_id: 'task-test',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories,
    status: 'in_progress',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as TaskMetadata;
}

beforeEach(() => {
  __setRegistryForTesting([
    repoDef('backend', 'sweatco/backend'),
    repoDef('mobile', 'sweatco/mobile'),
  ]);
});

describe('migrateRepositoriesShape', () => {
  it('migrates a legacy entry with branch_states, preserving clone path + PR state', () => {
    // Shape a real in-flight RW task would have on disk pre-v30.
    const m = meta({
      backend: {
        path: '/workdir/repos/backend',
        clone_path: '/sessions/task-test/repos/backend',
        current_branch: 'feature/task-test',
        branch_states: {
          'feature/task-test': {
            base_branch: 'main',
            pr_number: 42,
            last_processed_comment_id: 1001,
          },
        },
      },
    });

    migrateRepositoriesShape(m);

    // Re-keyed by agentId, value is an array.
    expect(Object.keys(m.repositories)).toEqual(['backend-agent']);
    const entries = m.repositories['backend-agent'];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);

    const att = entries[0];
    expect(att.github).toBe('sweatco/backend');
    // clone_path preserved → RW task reuses its existing working tree, no re-clone.
    expect(att.clone_path).toBe('/sessions/task-test/repos/backend');
    // base_path preserved → sandbox grants read access to the OLD base cache
    // (pre-v30 short-key layout), which is what this clone's alternates points
    // at. Without this, every git read through alternates would hit EACCES.
    expect(att.base_path).toBe('/workdir/repos/backend');
    expect(att.current_branch).toBe('feature/task-test');
    // Branch/PR/comment-dedup state survives intact.
    expect(att.branch_states!['feature/task-test']).toEqual({
      base_branch: 'main',
      pr_number: 42,
      last_processed_comment_id: 1001,
    });
  });

  it('lifts legacy top-level fields (feature_branch/pr_number) into branch_states', () => {
    // Older shape: no branch_states map, just the flat legacy fields.
    const m = meta({
      backend: {
        path: '/workdir/repos/backend',
        clone_path: '/sessions/task-test/repos/backend',
        feature_branch: 'feature/old',
        base_branch: 'develop',
        pr_number: 7,
        last_processed_comment_id: 500,
      },
    });

    migrateRepositoriesShape(m);

    const att = m.repositories['backend-agent'][0];
    expect(att.github).toBe('sweatco/backend');
    expect(att.current_branch).toBe('feature/old');
    expect(att.branch_states!['feature/old']).toEqual({
      base_branch: 'develop',
      pr_number: 7,
      last_processed_comment_id: 500,
    });
  });

  it('lifts top-level PR state when a legacy task sits on current_branch with no feature_branch', () => {
    // Post-v17 shape: the task tracks current_branch (not feature_branch) and
    // carries top-level pr_number/last_processed_comment_id but has no
    // branch_states map yet. The lift must key off current_branch or the PR
    // linkage is lost on migration.
    const m = meta({
      backend: {
        path: '/workdir/repos/backend',
        clone_path: '/sessions/task-test/repos/backend',
        current_branch: 'feature/task-test',
        base_branch: 'main',
        pr_number: 314,
        last_processed_comment_id: 900,
      },
    });

    migrateRepositoriesShape(m);

    const att = m.repositories['backend-agent'][0];
    expect(att.current_branch).toBe('feature/task-test');
    expect(att.branch_states!['feature/task-test']).toEqual({
      base_branch: 'main',
      pr_number: 314,
      last_processed_comment_id: 900,
    });
  });

  it('does not duplicate a repo when a legacy key and its v30 agentId key coexist', () => {
    // Mid-rollout: a v30 spawn already wrote the new agentId-keyed array entry,
    // but the legacy repoKey entry is still on disk. The migration must not
    // append a second AttachedRepo for the same github.
    const m = meta({
      'backend-agent': [
        {
          github: 'sweatco/backend',
          clone_path: '/sessions/task-test/repos/backend-agent/sweatco/backend',
          current_branch: 'feature/new',
          branch_states: { 'feature/new': { base_branch: 'main', pr_number: 42 } },
        },
      ],
      backend: {
        clone_path: '/sessions/task-test/repos/backend',
        current_branch: 'feature/old',
        branch_states: { 'feature/old': { base_branch: 'main', pr_number: 41 } },
      },
    });

    migrateRepositoriesShape(m);

    const entries = m.repositories['backend-agent'];
    expect(entries).toHaveLength(1);
    // The already-migrated array entry wins; the stale legacy duplicate is dropped.
    expect(entries[0].current_branch).toBe('feature/new');
    expect(entries[0].branch_states!['feature/new'].pr_number).toBe(42);
  });

  it('leaves clone_path undefined (not "") when a legacy entry had no clone', () => {
    const m = meta({
      backend: { current_branch: 'main', branch_states: {} },
    });

    migrateRepositoriesShape(m);

    expect(m.repositories['backend-agent'][0].clone_path).toBeUndefined();
  });

  it('migrates multiple repos and keys each by its own agent', () => {
    const m = meta({
      backend: { clone_path: '/c/backend', current_branch: 'main', branch_states: {} },
      mobile: { clone_path: '/c/mobile', current_branch: 'main', branch_states: {} },
    });

    migrateRepositoriesShape(m);

    expect(Object.keys(m.repositories).sort()).toEqual(['backend-agent', 'mobile-agent']);
    expect(m.repositories['backend-agent'][0].github).toBe('sweatco/backend');
    expect(m.repositories['mobile-agent'][0].github).toBe('sweatco/mobile');
  });

  it('drops entries whose agent is no longer registered (plugin removed)', () => {
    const m = meta({
      backend: { clone_path: '/c/backend', current_branch: 'main', branch_states: {} },
      legacyghost: { clone_path: '/c/ghost', current_branch: 'main', branch_states: {} },
    });

    migrateRepositoriesShape(m);

    // backend survives; the orphan is dropped rather than crashing the load.
    expect(Object.keys(m.repositories)).toEqual(['backend-agent']);
  });

  it('is a no-op on already-migrated (array) shape — idempotent', () => {
    const alreadyNew = {
      'backend-agent': [
        {
          github: 'sweatco/backend',
          clone_path: '/sessions/task-test/repos/backend-agent/sweatco/backend',
          current_branch: 'feature/task-test',
          branch_states: { 'feature/task-test': { base_branch: 'main', pr_number: 42 } },
        },
      ],
    };
    const m = meta(alreadyNew);

    migrateRepositoriesShape(m);

    // Untouched — same reference contents, no double-migration.
    expect(m.repositories).toEqual(alreadyNew);
  });

  it('running twice produces the same result (migration then no-op)', () => {
    const m = meta({
      backend: {
        clone_path: '/c/backend',
        current_branch: 'feature/x',
        branch_states: { 'feature/x': { base_branch: 'main', pr_number: 9 } },
      },
    });

    migrateRepositoriesShape(m);
    const afterFirst = JSON.parse(JSON.stringify(m.repositories));
    migrateRepositoriesShape(m);
    expect(m.repositories).toEqual(afterFirst);
  });

  it('handles a mixed map (one already-migrated, one legacy)', () => {
    const m = meta({
      // already new
      'mobile-agent': [
        { github: 'sweatco/mobile', clone_path: '/c/mobile', current_branch: 'main', branch_states: {} },
      ],
      // still legacy
      backend: { clone_path: '/c/backend', current_branch: 'main', branch_states: {} },
    });

    migrateRepositoriesShape(m);

    expect(Object.keys(m.repositories).sort()).toEqual(['backend-agent', 'mobile-agent']);
    expect(m.repositories['mobile-agent'][0].github).toBe('sweatco/mobile');
    expect(m.repositories['backend-agent'][0].github).toBe('sweatco/backend');
  });

  it('no-ops on an empty repositories map', () => {
    const m = meta({});
    migrateRepositoriesShape(m);
    expect(m.repositories).toEqual({});
  });
});
