/**
 * Unit tests for repo-agent branch naming and task-ID extraction.
 *
 * These lock in the migration contract: new branches use the `archie/` prefix,
 * while the webhook parser keeps attributing branches with the legacy `feature/`
 * prefix so historical PRs continue routing to their task.
 */

import { describe, it, expect } from 'vitest';
import {
  BRANCH_PREFIX,
  taskBranchName,
  extractTaskIdFromBranch,
  invalidRefReason,
} from '../branch-naming.js';

const TASK_ID = 'task-20260101-1823-abc123';

describe('taskBranchName', () => {
  it('uses the archie prefix for the first branch', () => {
    expect(taskBranchName(TASK_ID)).toBe(`archie/${TASK_ID}`);
    expect(BRANCH_PREFIX).toBe('archie');
  });

  it('auto-numbers additional branches', () => {
    expect(taskBranchName(TASK_ID, 1)).toBe(`archie/${TASK_ID}-2`);
    expect(taskBranchName(TASK_ID, 2)).toBe(`archie/${TASK_ID}-3`);
  });
});

describe('extractTaskIdFromBranch', () => {
  it('extracts the task ID from a new archie/ branch', () => {
    expect(extractTaskIdFromBranch(`archie/${TASK_ID}`)).toBe(TASK_ID);
  });

  it('extracts the task ID from a legacy feature/ branch (backward compat)', () => {
    expect(extractTaskIdFromBranch(`feature/${TASK_ID}`)).toBe(TASK_ID);
  });

  it('handles the multi-branch suffix for both prefixes', () => {
    expect(extractTaskIdFromBranch(`archie/${TASK_ID}-2`)).toBe(TASK_ID);
    expect(extractTaskIdFromBranch(`feature/${TASK_ID}-3`)).toBe(TASK_ID);
  });

  it('round-trips generated branch names', () => {
    expect(extractTaskIdFromBranch(taskBranchName(TASK_ID))).toBe(TASK_ID);
    expect(extractTaskIdFromBranch(taskBranchName(TASK_ID, 4))).toBe(TASK_ID);
  });

  it('returns undefined for unrelated or malformed branches', () => {
    expect(extractTaskIdFromBranch(undefined)).toBeUndefined();
    expect(extractTaskIdFromBranch('main')).toBeUndefined();
    expect(extractTaskIdFromBranch('archie/not-a-task')).toBeUndefined();
    expect(extractTaskIdFromBranch(`release/${TASK_ID}`)).toBeUndefined();
  });
});

describe('invalidRefReason', () => {
  it('accepts ordinary branch names', () => {
    for (const name of [
      'main',
      `archie/${TASK_ID}-2`,
      'feature/login.fix',
      'release/1.2.x',
      'dependabot/npm_and_yarn/@types/node-20.1.0',
      'c++-bindings',
    ]) {
      expect(invalidRefReason(name, 'branch'), name).toBeUndefined();
    }
  });

  it('accepts commit-ish revisions as a base', () => {
    for (const rev of ['HEAD', 'HEAD~2', 'main^', 'origin/main', 'v1.2.3', 'a1b2c3d4']) {
      expect(invalidRefReason(rev, 'revision'), rev).toBeUndefined();
    }
  });

  it('refuses an empty value', () => {
    expect(invalidRefReason('', 'branch')).toMatch(/empty/);
    expect(invalidRefReason('', 'revision')).toMatch(/empty/);
  });

  it('refuses option-like values', () => {
    expect(invalidRefReason('-b', 'branch')).toMatch(/option/);
    expect(invalidRefReason('--upload-pack=x', 'revision')).toMatch(/option/);
  });

  it('refuses characters outside a plausible ref name', () => {
    for (const value of ['a;b', 'a$(b)', 'a`b`', 'a&&b', 'a"b', "a'b", 'a b', 'a:b', 'a\nb']) {
      expect(invalidRefReason(value, 'revision'), value).toMatch(/may contain only/);
    }
    expect(invalidRefReason('HEAD~1', 'branch')).toMatch(/may contain only/);
  });

  it('refuses values that do not start with a letter or digit', () => {
    expect(invalidRefReason('.hidden', 'branch')).toMatch(/start with a letter or digit/);
    expect(invalidRefReason('/main', 'branch')).toMatch(/start with a letter or digit/);
  });

  it('refuses ranges and parent traversal', () => {
    expect(invalidRefReason('main..feature', 'revision')).toMatch(/\.\./);
    expect(invalidRefReason('feature/../main', 'branch')).toMatch(/\.\./);
  });
});
