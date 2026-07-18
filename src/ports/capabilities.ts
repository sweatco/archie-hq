/**
 * Capability descriptors: where a backend cannot match a capability, the gap is
 * declared here and degraded gracefully — never silent.
 */

export interface RepoHostCapabilities {
  /** true: distinct approved / changes_requested review states (GitHub). false: approvals+notes only (GitLab). */
  reviewStates: boolean;
  /** code-scanning / security alerts available (GitHub, GitLab Ultimate). */
  securityAlerts: boolean;
  /** host-native "merge when pipeline succeeds" (GitLab). Archie orchestrates merges itself when false. */
  nativeAutoMerge: boolean;
  /** can request re-review from prior reviewers. */
  reReviewRequest: boolean;
}

export const GITHUB_CAPABILITIES: RepoHostCapabilities = {
  reviewStates: true,
  securityAlerts: true,
  nativeAutoMerge: false,
  reReviewRequest: true,
};

/**
 * GitLab defaults — least-capable baseline. reviewStates is false: GitLab has
 * approvals + notes rather than distinct approved/changes_requested states, so
 * Archie synthesizes reviews from approvals and unresolved discussions (see
 * GitLabHost.getPRReviews). securityAlerts is fixed false: there is no boot-time
 * license probe in this PR, so code-scanning/vulnerability findings are never
 * surfaced for GitLab. nativeAutoMerge is declared true (GitLab's "merge when
 * pipeline succeeds") but this PR ships no webhook merge orchestration for GitLab,
 * so the flag currently has no consumer.
 */
export const GITLAB_CAPABILITIES_DEFAULT: RepoHostCapabilities = {
  reviewStates: false,
  securityAlerts: false,
  nativeAutoMerge: true,
  reReviewRequest: false,
};
