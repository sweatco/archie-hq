/**
 * Branch state helpers for RepositoryInfo.
 *
 * Pure functions that operate on branch_states metadata.
 * Used by tools, spawn, events, and merge modules.
 */

import type { RepositoryInfo } from '../../types/task.js';

/**
 * Mirror current branch state to legacy top-level fields for rollback safety.
 * Called after any branch state change.
 */
export function mirrorLegacyFields(repoInfo: RepositoryInfo): void {
  const current = repoInfo.current_branch;
  const state = current ? repoInfo.branch_states?.[current] : undefined;
  if (state) {
    repoInfo.feature_branch = current;
    repoInfo.base_branch = state.base_branch;
    repoInfo.pr_number = state.pr_number;
    repoInfo.last_processed_comment_id = state.last_processed_comment_id;
  }
}

/**
 * Initialize branch_states from a newly created or legacy feature branch.
 */
export function hydrateBranchState(repoInfo: RepositoryInfo, branch: string, baseBranch?: string): void {
  repoInfo.branch_states ??= {};
  repoInfo.branch_states[branch] = {
    owned: true,
    head_sha: '',
    base_branch: baseBranch,
  };
  repoInfo.current_branch = branch;
  // Mirror to legacy fields
  repoInfo.feature_branch = branch;
  repoInfo.base_branch = baseBranch;
}

/**
 * Find a BranchState by its PR number (for webhook/event routing).
 */
export function findBranchStateByPR(repoInfo: RepositoryInfo, prNumber: number) {
  if (!repoInfo.branch_states) return undefined;
  for (const [branch, state] of Object.entries(repoInfo.branch_states)) {
    if (state.pr_number === prNumber) return { branch, state };
  }
  return undefined;
}
