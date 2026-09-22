/**
 * Which branch a task's clone belongs on.
 *
 * `decideCloneCheckout` is the single source of that answer: `mount_repo` and
 * the edit-mode approval path both go through it, so the branch a repo is
 * checked out on cannot depend on which one got there first. These lock in the
 * three states — read-only on base, first edit-mode mount cutting the task
 * branch, and a re-created clone restoring the branch the task was working on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { decideCloneCheckout, recordedBaseBranch, ensureTaskClone } from '../repo-clone.js';
import type { AttachedRepo } from '../../../types/task.js';

const execFileAsync = promisify(execFile);

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

/**
 * The reuse path has to leave the clone in the same state the create path
 * does. Git identity is the half that used to be skipped: only the create path
 * configured it, so a clone left behind by an interrupted mount — or one
 * predating the current attribution account — committed as whatever git fell
 * back to.
 */
describe('ensureTaskClone — reusing an existing clone', () => {
  let tmpDir: string;
  let clonePath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'ARCHIE_WORKDIR', 'ARCHIE_GITHUB_LOGIN', 'ARCHIE_GITHUB_USER_ID', 'ARCHIE_GITHUB_NAME']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ARCHIE_GITHUB_LOGIN = 'archie-hq';
    process.env.ARCHIE_GITHUB_USER_ID = '302249786';
    process.env.ARCHIE_GITHUB_NAME = 'Archie HQ';

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-task-clone-'));
    process.env.ARCHIE_WORKDIR = tmpDir;
    clonePath = path.join(tmpDir, 'clone');
    await fs.mkdir(clonePath);
    await execFileAsync('git', ['init', '-q'], { cwd: clonePath });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('configures the git identity on the clone it hands back', async () => {
    const attached = {
      github: 'org/backend',
      clone_path: clonePath,
      current_branch: 'main',
    } as AttachedRepo;

    const result = await ensureTaskClone({
      attached,
      clonePath,
      baseRepoPath: path.join(tmpDir, 'base'),
      editAllowed: false,
      taskBranch: TASK_BRANCH,
    });

    expect(result).toMatchObject({ clone_path: clonePath, branch: 'main', created: false });
    const { stdout } = await execFileAsync('git', ['config', '--local', '--get', 'user.name'], { cwd: clonePath });
    expect(stdout.trim()).toBe('Archie HQ');
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
