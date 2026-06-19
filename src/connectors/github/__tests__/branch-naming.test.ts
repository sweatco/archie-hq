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
