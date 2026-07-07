/**
 * Branch state helpers for AttachedRepo.
 *
 * Pure functions that operate on branch_states metadata.
 * Used by tools, spawn, events, and merge modules.
 */

import type { AttachedRepo, BranchState } from '../../types/task.js';

/**
 * Assign (or reassign) a PR number to a BranchState, resetting the PR-specific
 * lifecycle markers whenever the PR changes (which includes the first
 * assignment, where `pr_number` starts `undefined`).
 *
 * `merge_armed` and `merge_ready_notified` are per-PR markers, but a branch's
 * `pr_number` outlives any single PR: when a PR is closed unmerged the branch
 * survives and `create_pull_request` reuses the same BranchState for the next
 * PR. Carrying the old PR's arm forward would let the orchestrator's armed
 * bucket auto-merge the new PR with no fresh approval (a fail-open). Clearing
 * on reassignment keeps arming/notification bound to the PR the user actually
 * acted on. The close/merge webhook does clear `merge_armed` too, but it routes
 * to the task lifecycle rather than a merge check, so it cannot be relied on —
 * this reset is the authoritative one.
 */
export function assignPrNumber(state: BranchState, prNumber: number): void {
  if (state.pr_number !== prNumber) {
    delete state.merge_armed;
    delete state.merge_ready_notified;
  }
  state.pr_number = prNumber;
}

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
