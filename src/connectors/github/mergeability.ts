/**
 * Orchestrator-only GitHub mergeability predicate — **must be paired with an
 * `approved` check** (see `merge.ts`'s auto-merge bucket). The
 * `blocked`-but-`mergeable` tolerance is only safe under that pairing; used
 * bare it would treat a PR blocked on required human review with CI incomplete
 * (`mergeable:true` = no conflicts, `mergeableState:'blocked'`) as ready.
 *
 * Callers add their own `state === 'open'` check. Neither the
 * `merge_pull_request` tool nor the armed-PR merge path calls this: the tool
 * arms instead of interpreting mergeability, and both the tool's auto branch
 * and the armed orchestrator bucket gate on `mergeableState === 'clean'`
 * directly (no `blocked` tolerance).
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
