/**
 * Shared GitHub mergeability predicate.
 *
 * One definition for both merge paths (the orchestrator's webhook-driven check
 * and the `merge_pull_request` tool) so they can't drift apart. Callers add
 * their own `state === 'open'` (and, on the auto path only, `approved`) checks.
 *
 * The `blocked`-but-`mergeable` tolerance covers a known GitHub Rulesets quirk
 * where the API reports 'blocked' while the UI shows a green merge button
 * (https://github.com/runatlantis/atlantis/issues/4116). When mergeable=true,
 * GitHub has determined the PR CAN be merged, so we attempt it; the merge API
 * call fails gracefully if it's truly blocked.
 */

import type { PRStatus } from '../../agents/tools.js';

export function isMergeReadyPerGithub(status: PRStatus): boolean {
  return status.mergeableState === 'clean' ||
    (status.mergeable === true && status.mergeableState === 'blocked');
}
