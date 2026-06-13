/**
 * Branch state helpers for AttachedRepo.
 *
 * Pure functions that operate on branch_states metadata.
 * Used by tools, spawn, events, and merge modules.
 */

import type { AttachedRepo } from '../../types/task.js';

/**
 * Initialize branch_states for a newly checked-out branch.
 */
export function hydrateBranchState(repo: AttachedRepo, branch: string, baseBranch?: string): void {
  repo.branch_states ??= {};
  repo.branch_states[branch] = {
    base_branch: baseBranch,
  };
  repo.current_branch = branch;
}

/**
 * Find a BranchState by its PR number (for webhook/event routing).
 */
export function findBranchStateByPR(repo: AttachedRepo, prNumber: number) {
  if (!repo.branch_states) return undefined;
  for (const [branch, state] of Object.entries(repo.branch_states)) {
    if (state.pr_number === prNumber) return { branch, state };
  }
  return undefined;
}
