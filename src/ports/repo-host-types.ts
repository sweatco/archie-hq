/**
 * Host-neutral repo-host domain types.
 *
 * These describe change-requests, reviews, and CI in a vendor-agnostic shape.
 * They were extracted verbatim from src/agents/tools.ts as part of the RepoHost
 * seam. GitHub and GitLab hosts both produce these shapes.
 */

export type MergeableState = 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'unknown';

export interface PRStatus {
  state: 'open' | 'merged' | 'closed';
  mergeable: boolean;
  mergeableState: MergeableState;
  approved: boolean;
}

export interface PRReview {
  id: string;
  user: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  submittedAt: string;
}

export interface ReviewThreadComment {
  commentId: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'neutral'
  | 'action_required'
  | 'skipped'
  | 'stale'
  | null;

export interface PRCheckEntry {
  source: 'check_run' | 'status';
  name: string;
  app: string;
  status: string;
  conclusion: CheckConclusion;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
}

export interface PRChecksReport {
  headSha: string;
  entries: PRCheckEntry[];
}

/*
 * Canonical result/report shapes for the RepoHost seam.
 *
 * These were originally declared in src/connectors/github/client.ts. They are
 * plain data shapes (no vendor types embedded) and serve as the canonical
 * internal schema for every repo host: GitHub produces them directly, and a
 * later GitLab host maps its API responses into the same shapes (adapter /
 * anti-corruption pattern, GitHub schema as the lingua franca). Names stay
 * PR/GitHub-oriented for now; a host-neutral change-request renaming is left for
 * later. client.ts re-exports these so its existing importers are unaffected.
 */

export interface CreatePRResult {
  pr_number: number;
  pr_url: string;
}

export interface PRListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  author: string;
  updated_at: string;
  url: string;
}

export interface PRListFilters {
  state?: 'open' | 'closed' | 'all';
  base?: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
  per_page?: number;
}

export interface PRDetails {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'merged' | 'closed';
  head: string;
  base: string;
  diff: string;
  url: string;
}

export interface CheckRunAnnotation {
  path: string;
  startLine: number | null;
  level: string;
  message: string;
  title?: string;
}

export interface CheckRunReport {
  id: number;
  name: string;
  app: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  url: string | null;
  headSha: string | null;
  startedAt: string | null;
  completedAt: string | null;
  output?: { title?: string; summary?: string; text?: string };
  annotations?: CheckRunAnnotation[];
  logTail?: string;
}

export interface WorkflowJobEntry {
  id: number;
  name: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  url: string | null;
  logTail?: string;
}

export interface WorkflowRunReport {
  id: number;
  name: string;
  status: string;
  conclusion: PRCheckEntry['conclusion'];
  headSha: string | null;
  headBranch: string | null;
  url: string | null;
  jobs: WorkflowJobEntry[];
}

export interface CodeScanningAlertInstance {
  /** Git ref the instance was seen on, e.g. `refs/heads/main`. */
  ref: string | null;
  state: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** The alert message text for this instance. */
  message: string | null;
}

export interface CodeScanningAlert {
  number: number;
  /** open / dismissed / fixed (GitHub may add others). */
  state: string;
  /** Analysis tool that produced the alert, e.g. `CodeQL`. */
  tool: string;
  ruleId: string | null;
  ruleName: string | null;
  ruleDescription: string | null;
  /** Rule severity: none / note / warning / error. */
  severity: string | null;
  /** Security severity: low / medium / high / critical (when classified). */
  securitySeverity: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dismissedReason: string | null;
  dismissedComment: string | null;
  mostRecentInstance: CodeScanningAlertInstance | null;
}

export interface CodeScanningAlertFilters {
  /** Alert state filter. Defaults to `open` at the call site. */
  state?: 'open' | 'dismissed' | 'fixed';
  /** Git ref filter, e.g. `refs/heads/main` or a branch name. */
  ref?: string;
  /** Limit to a single tool, e.g. `CodeQL`. */
  toolName?: string;
  /** Severity filter (critical/high/medium/low or note/warning/error). */
  severity?: string;
  per_page?: number;
}
