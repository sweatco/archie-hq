/**
 * RepoHostEventSource — inbound webhook seam (spec §3.2). Signature verification
 * and payload parsing stay per-host; the normalized context + routing decision
 * are host-agnostic (see src/connectors/shared/cr-router.ts).
 */

/** Host-neutral normalized event, produced by each host's payload parser. */
export interface NormalizedEventContext {
  /** canonical (GitHub-semantic) event type — each host's parser maps its native
   *  events into this vocabulary ('pull_request', 'pull_request_review',
   *  'pull_request_review_comment', 'issue_comment', 'push', 'workflow_run', …). */
  eventType: string;
  action?: string;
  /** repo identifier "owner/name" (GitHub) / "group/project" (GitLab). */
  repo: string;
  prNumber?: number;
  branch?: string;
  user: string;
  body?: string;
  state?: string;
  commentId?: number;
}

/** Internal routing semantic — host-agnostic. */
export type InternalRouteAction = 'merge_check' | 'existing_task' | 'checks_ready' | 'noop';

/** Routing decision, consumed by the HTTP dispatcher. */
export type RouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string }
  | { action: 'direct'; handler: 'checks_ready'; taskId: string; repo: string; prNumber: number };

export interface RepoHostEventSource {
  readonly kind: 'github' | 'gitlab';
  /** constant-time signature/token check over the raw body. */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean;
  /** parse a raw payload into the host-neutral context. */
  parseEvent(eventType: string, payload: unknown): NormalizedEventContext;
  /** true when the event originated from our own bot (loop guard); machine events exempt. */
  isSelfEvent(context: NormalizedEventContext): boolean;
}
