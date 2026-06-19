/**
 * Branch naming for repo-agent feature branches.
 *
 * New branches use the `archie/` prefix (e.g. `archie/task-20260101-1823-abc123`).
 * The legacy `feature/` prefix is still recognized when attributing webhooks so
 * that pull requests opened before the migration keep routing to their task.
 *
 * Single source of truth for both branch generation (spawn, create_branch tool,
 * PR head fallback) and branch parsing (webhook → task attribution).
 */

/** Prefix used for newly created repo-agent branches. */
export const BRANCH_PREFIX = 'archie';

/**
 * Prefixes accepted when parsing a task ID out of a branch name, beyond the
 * current {@link BRANCH_PREFIX}. Kept so historical PRs (and any in-flight task
 * whose branch was created before the migration) keep attributing correctly.
 */
export const LEGACY_BRANCH_PREFIXES = ['feature'] as const;

/**
 * Build the branch name for a task.
 *
 * The first branch is `archie/{taskId}`. Additional branches are auto-numbered
 * `archie/{taskId}-2`, `archie/{taskId}-3`, ... — `existingCount` is the number
 * of branches already created for the task (0 for the first).
 */
export function taskBranchName(taskId: string, existingCount = 0): string {
  return existingCount === 0
    ? `${BRANCH_PREFIX}/${taskId}`
    : `${BRANCH_PREFIX}/${taskId}-${existingCount + 1}`;
}

/** Regex matching `{prefix}/{taskId}` for any accepted prefix, capturing the task ID. */
const BRANCH_TASK_ID_RE = new RegExp(
  `^(?:${[BRANCH_PREFIX, ...LEGACY_BRANCH_PREFIXES].join('|')})\\/(task-\\d{8}-\\d{4}-[a-z0-9]+)(?:-\\d+)?$`,
  'i',
);

/**
 * Extract the task ID from a branch name.
 *
 * Branch format: `{prefix}/{taskId}` or `{prefix}/{taskId}-{N}` (multi-branch
 * suffix), where prefix is the current `archie` prefix or a legacy prefix.
 * Task ID format: `task-YYYYMMDD-HHMM-random`.
 */
export function extractTaskIdFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const match = branch.match(BRANCH_TASK_ID_RE);
  return match ? match[1] : undefined;
}
