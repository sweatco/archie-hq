/**
 * GitLab webhook utilities. Per-host payload parsing + token verification;
 * GitLab hooks are translated into the canonical GitHub-semantic
 * NormalizedEventContext vocabulary. The routing decision is self-contained
 * here (no shared cr-router / merge-on-green orchestrator): events either wake
 * the existing task or are discarded, with no automatic merge check.
 */

import crypto from 'crypto';
import { extractTaskIdFromBranch } from '../github/branch-naming.js';
import { findTaskByPRNumber, loadMetadata } from '../../tasks/persistence.js';
import type { NormalizedEventContext, RepoHostEventSource } from '../../ports/repo-host-events.js';

/**
 * Constant-time compare of the X-Gitlab-Token header against the configured
 * secret. Compares UTF-8 **byte** length before calling `timingSafeEqual` —
 * comparing JS string `.length` (UTF-16 code units) first would let a
 * multibyte token reach `timingSafeEqual` with a byte length that differs
 * from the secret's, which throws `RangeError` instead of returning false.
 */
export function verifyGitLabToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);

/** GitLab object_kind → canonical NormalizedEventContext (GitHub-semantic vocabulary). */
export function formatGitLabContext(objectKind: string, payload: Obj): NormalizedEventContext {
  const project = asObj(payload.project);
  const repo = (project?.path_with_namespace as string) || 'unknown/unknown';
  const user =
    (asObj(payload.user)?.username as string) ||
    (payload.user_username as string) ||
    'unknown';
  const attrs = asObj(payload.object_attributes) ?? {};
  const mr = asObj(payload.merge_request);

  const base: NormalizedEventContext = { eventType: 'unknown', repo, user };

  if (objectKind === 'merge_request') {
    const action = attrs.action as string | undefined;
    base.prNumber = attrs.iid as number | undefined;
    base.branch = attrs.source_branch as string | undefined;
    switch (action) {
      case 'open':
      case 'reopen':
        return { ...base, eventType: 'pull_request', action: 'opened' };
      case 'update':
        // GitLab's `update` action fires both for new commits pushed to the
        // source branch AND for metadata-only edits (label/title/description/
        // assignee/reviewer/milestone). GitHub's `synchronize` fires ONLY on
        // new commits, so gate on `oldrev` (a commit SHA present only when the
        // source branch actually received new commits) to avoid needless
        // merge checks / card refreshes on trivial metadata edits.
        return attrs.oldrev
          ? { ...base, eventType: 'pull_request', action: 'synchronize' }
          : { ...base, eventType: 'pull_request', action: 'update' };
      case 'close':
        return { ...base, eventType: 'pull_request', action: 'closed', state: 'closed' };
      case 'merge':
        return { ...base, eventType: 'pull_request', action: 'closed', state: 'merged' };
      case 'approved':
        return { ...base, eventType: 'pull_request_review', action: 'submitted', state: 'approved' };
      default:
        // unapproved / unknown MR actions → no routing action (changes-requested
        // is surfaced via unresolved discussions on note events).
        return { ...base, eventType: 'pull_request', action: action ?? '' };
    }
  }

  if (objectKind === 'note') {
    base.prNumber = mr?.iid as number | undefined;
    base.branch = mr?.source_branch as string | undefined;
    base.body = attrs.note as string | undefined;
    base.commentId = attrs.id as number | undefined;
    const noteType = attrs.type as string | undefined; // 'DiffNote' | 'DiscussionNote' | null
    if (noteType === 'DiffNote') {
      return { ...base, eventType: 'pull_request_review_comment', action: 'created' };
    }
    return { ...base, eventType: 'issue_comment', action: 'created' };
  }

  if (objectKind === 'push') {
    const ref = payload.ref as string | undefined;
    return { ...base, eventType: 'push', branch: ref?.replace('refs/heads/', '') };
  }

  if (objectKind === 'pipeline') {
    const status = attrs.status as string | undefined; // success | failed | running | ...
    base.branch = attrs.ref as string | undefined;
    base.prNumber = mr?.iid as number | undefined;
    if (status === 'success') return { ...base, eventType: 'workflow_run', action: 'completed', state: 'success' };
    if (status === 'failed') return { ...base, eventType: 'workflow_run', action: 'completed', state: 'failure' };
    return { ...base, eventType: 'workflow_run', action: status ?? '' }; // running/pending → noop
  }

  return base; // unknown kind → noop
}

/** Branch used for task-id derivation. */
export function extractBranchFromPayload(objectKind: string, payload: Obj): string | undefined {
  const attrs = asObj(payload.object_attributes) ?? {};
  const mr = asObj(payload.merge_request);
  if (objectKind === 'merge_request') return attrs.source_branch as string | undefined;
  if (objectKind === 'note') return mr?.source_branch as string | undefined;
  if (objectKind === 'push') return (payload.ref as string | undefined)?.replace('refs/heads/', '');
  if (objectKind === 'pipeline') return attrs.ref as string | undefined;
  return undefined;
}

/** Structured event for the knowledge log (mirrors the GitHub connector's shape). */
export interface FormattedEvent { from: string; destination: string; message: string; }

export function formatGitLabEvent(context: NormalizedEventContext): FormattedEvent {
  const { eventType, action, user, prNumber, body, state, commentId } = context;
  const prDest = prNumber ? `MR !${prNumber}` : 'MR';
  const cidTag = commentId ? ` [comment_id=${commentId}]` : '';
  switch (eventType) {
    case 'pull_request_review':
      return { from: user, destination: prDest, message: state === 'approved' ? 'approved' : (body ? `reviewed: ${body}` : 'reviewed') };
    case 'pull_request_review_comment':
      return { from: user, destination: prDest, message: body ? `commented on code${cidTag}: ${body}` : `commented on code${cidTag}` };
    case 'issue_comment':
      return { from: user, destination: prDest, message: body ? `${body}${cidTag}` : `(empty)${cidTag}` };
    case 'pull_request':
      if (action === 'closed') return { from: user, destination: prDest, message: state === 'merged' ? 'merged' : 'closed' };
      return { from: user, destination: prDest, message: action ?? '' };
    case 'push':
      return { from: user, destination: `branch:${context.branch || 'unknown'}`, message: 'pushed' };
    case 'workflow_run':
      return { from: 'ci', destination: prNumber ? prDest : `branch:${context.branch || 'unknown'}`, message: `pipeline ${state || action}` };
    default:
      return { from: user, destination: prDest, message: `${eventType}/${action ?? ''}` };
  }
}

function getGitLabBotUsername(): string | null {
  return process.env.GITLAB_BOT_USERNAME || null;
}

/** Narrowed routing decision — no `merge_check` / `checks_ready` (deferred). */
export type RouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'existing_task'; taskId: string };

/**
 * Self-contained classification of a normalized GitLab event: does it need to
 * wake the owning task, or is it a no-op? There is no merge-on-green
 * orchestrator on this branch, so events that would have triggered an
 * automatic merge check (MR opened/synchronize, approval, CI success) now
 * simply wake the task like any other update.
 */
export function classifyGitLabEvent(context: NormalizedEventContext): 'existing_task' | 'discard' {
  const { eventType, action, state } = context;

  switch (eventType) {
    case 'pull_request':
      if (action === 'closed' || action === 'opened' || action === 'synchronize') return 'existing_task';
      return 'discard';

    case 'pull_request_review':
      if (state === 'approved' || state === 'changes_requested' || state === 'commented') return 'existing_task';
      return 'discard';

    case 'pull_request_review_comment':
      return 'existing_task';

    case 'issue_comment':
      return action === 'created' ? 'existing_task' : 'discard';

    case 'workflow_run':
      if (action === 'completed' && (state === 'success' || state === 'failure')) return 'existing_task';
      return 'discard';

    default:
      return 'discard';
  }
}

/** Route a GitLab event to the existing task, or discard it. */
export async function routeGitLabEvent(objectKind: string, payload: Obj): Promise<RouteResult> {
  const context = formatGitLabContext(objectKind, payload);

  // Loop guard: discard our own comment/review events; exempt machine events.
  const bot = getGitLabBotUsername();
  const isMachineEvent = objectKind === 'push' || objectKind === 'pipeline';
  if (bot && context.user === bot && !isMachineEvent) {
    return { action: 'discard', reason: 'Own bot event' };
  }

  const branch = extractBranchFromPayload(objectKind, payload);
  let taskId = extractTaskIdFromBranch(branch);
  if (!taskId && context.prNumber) {
    taskId = (await findTaskByPRNumber(context.repo, context.prNumber)) ?? undefined;
  }
  if (!taskId) return { action: 'discard', reason: 'Not our branch pattern' };
  // Defense-in-depth: taskId is derived from an externally-controlled webhook
  // branch name and flows into filesystem paths + git operations downstream.
  // Reject anything outside the known task-id shape before it is used.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    return { action: 'discard', reason: 'Malformed task id' };
  }

  const metadata = await loadMetadata(taskId);
  if (!metadata) return { action: 'discard', reason: `Task ${taskId} not found` };

  const classification = classifyGitLabEvent(context);
  if (classification === 'existing_task') {
    return { action: 'direct', handler: 'existing_task', taskId };
  }
  return { action: 'discard', reason: `No action needed for ${objectKind}` };
}

/** GitLab's RepoHostEventSource conformer. */
export const gitlabEventSource: RepoHostEventSource = {
  kind: 'gitlab',
  verifySignature(_rawBody, headers, secret) {
    const token = headers['x-gitlab-token'];
    return typeof token === 'string' && verifyGitLabToken(token, secret);
  },
  parseEvent(eventType, payload) {
    return formatGitLabContext(eventType, (payload as Obj) ?? {});
  },
  isSelfEvent(context) {
    return context.user === getGitLabBotUsername();
  },
};
