/**
 * Which branch a task's clone belongs on.
 *
 * `decideCloneCheckout` is the single source of that answer: `mount_repo` and
 * the edit-mode approval path both go through it, so the branch a repo is
 * checked out on cannot depend on which one got there first. These lock in the
 * three states — read-only on base, first edit-mode mount cutting the task
 * branch, and a re-created clone restoring the branch the task was working on.
 */

import { describe, it, expect } from 'vitest';
import { decideCloneCheckout, recordedBaseBranch } from '../repo-clone.js';
import type { AttachedRepo } from '../../../types/task.js';

const TASK_BRANCH = 'archie/task-123';

describe('decideCloneCheckout', () => {
  it('read-only tasks sit on the base branch', () => {
    expect(decideCloneCheckout({ editAllowed: false, taskBranch: TASK_BRANCH }))
      .toEqual({ type: 'base' });
  });

  it('stays on base in read-only mode even when the task once had a branch', () => {
    // Edit mode is one-way, so this cannot happen in practice — but the answer
    // must come from edit mode, not from leftover state.
    expect(decideCloneCheckout({
      editAllowed: false,
      taskBranch: TASK_BRANCH,
      currentBranch: TASK_BRANCH,
      branchStates: { [TASK_BRANCH]: { base_branch: 'main' } },
    })).toEqual({ type: 'base' });
  });

  it('cuts the task branch on the first mount in edit mode', () => {
    expect(decideCloneCheckout({ editAllowed: true, taskBranch: TASK_BRANCH }))
      .toEqual({ type: 'new_branch', name: TASK_BRANCH });
  });

  it('cuts the task branch when the clone was parked on base', () => {
    // A base-branch checkout records `current_branch` but no branch_states
    // entry — that absence is what says "never branched", not the name.
    expect(decideCloneCheckout({
      editAllowed: true,
      taskBranch: TASK_BRANCH,
      currentBranch: 'main',
    })).toEqual({ type: 'new_branch', name: TASK_BRANCH });
  });

  it('restores the branch the task was working on', () => {
    expect(decideCloneCheckout({
      editAllowed: true,
      taskBranch: TASK_BRANCH,
      currentBranch: 'archie/task-123-2',
      branchStates: { 'archie/task-123-2': { base_branch: 'release' } },
    })).toEqual({ type: 'branch', name: 'archie/task-123-2' });
  });
});

describe('recordedBaseBranch', () => {
  it('is unknown for a repo the task has never checked out', () => {
    expect(recordedBaseBranch({ github: 'org/backend' } as AttachedRepo)).toBeUndefined();
  });

  it('is the current branch when the clone sits on base', () => {
    expect(recordedBaseBranch({ github: 'org/backend', current_branch: 'trunk' } as AttachedRepo))
      .toBe('trunk');
  });

  it('is what a feature branch forked from, not the feature branch', () => {
    expect(recordedBaseBranch({
      github: 'org/backend',
      current_branch: TASK_BRANCH,
      branch_states: { [TASK_BRANCH]: { base_branch: 'release' } },
    } as AttachedRepo)).toBe('release');
  });

  it('is unknown for a tracked branch with no recorded base', () => {
    // Better undefined than the feature branch's own name: callers fall back to
    // asking GitHub, and a PR opened against its own head branch is not a PR.
    expect(recordedBaseBranch({
      github: 'org/backend',
      current_branch: TASK_BRANCH,
      branch_states: { [TASK_BRANCH]: {} },
    } as AttachedRepo)).toBeUndefined();
  });
});
