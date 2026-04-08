/**
 * GitHub Webhook Utilities
 *
 * Contains utility functions for GitHub webhook handling:
 * - Signature verification
 * - Payload context extraction
 * - Event message formatting
 * - Merge check debouncing
 */

import crypto from 'crypto';
import { checkAndMergeLinkedPRs } from './merge.js';
import { findTaskByPRNumber, loadMetadata } from '../../tasks/persistence.js';
import { logger } from '../../system/logger.js';

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify GitHub webhook signature
 * Should be called before processing any webhook
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature =
    'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// ============================================================================
// Event Context Extraction
// ============================================================================

/**
 * GitHub webhook event context
 */
export interface GitHubEventContext {
  eventType: string;
  action: string;
  githubRepo: string;
  prNumber?: number;
  branch?: string;
  user: string;
  body?: string;
  state?: string;
  commentId?: number;
}

/**
 * Extract context from a GitHub webhook payload
 */
export function formatGitHubContext(
  eventType: string,
  payload: Record<string, unknown>
): GitHubEventContext {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const githubRepo = repository?.full_name as string || 'unknown/unknown';
  const sender = payload.sender as Record<string, unknown> | undefined;
  const user = (sender?.login as string) || 'unknown';
  const action = (payload.action as string) || '';

  const context: GitHubEventContext = {
    eventType,
    action,
    githubRepo,
    user,
  };

  // Extract PR-specific info based on event type
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;

  if (eventType === 'pull_request_review') {
    const review = payload.review as Record<string, unknown> | undefined;
    context.prNumber = pullRequest?.number as number | undefined;
    context.body = review?.body as string | undefined;
    context.state = review?.state as string | undefined;
    context.branch = (pullRequest?.head as Record<string, unknown>)?.ref as string | undefined;
  } else if (eventType === 'pull_request_review_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    context.prNumber = pullRequest?.number as number | undefined;
    context.body = comment?.body as string | undefined;
    context.branch = (pullRequest?.head as Record<string, unknown>)?.ref as string | undefined;
  } else if (eventType === 'pull_request') {
    context.prNumber = pullRequest?.number as number | undefined;
    context.state = pullRequest?.merged as boolean ? 'merged' : 'closed';
    context.branch = (pullRequest?.head as Record<string, unknown>)?.ref as string | undefined;
  } else if (eventType === 'issue_comment') {
    const issue = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (issue?.pull_request) {
      context.prNumber = issue?.number as number | undefined;
      context.body = comment?.body as string | undefined;
      context.commentId = comment?.id as number | undefined;
    }
  } else if (eventType === 'push') {
    const ref = payload.ref as string | undefined;
    context.branch = ref?.replace('refs/heads/', '');
  } else if (eventType === 'workflow_run') {
    const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
    context.branch = workflowRun?.head_branch as string | undefined;
    context.state = workflowRun?.conclusion as string | undefined;
  }

  return context;
}

/**
 * Extract branch name from GitHub payload
 */
export function extractBranchFromPayload(
  eventType: string,
  payload: Record<string, unknown>
): string | undefined {
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  if (pullRequest) {
    return (pullRequest.head as Record<string, unknown>)?.ref as string | undefined;
  }

  if (eventType === 'push') {
    const ref = payload.ref as string | undefined;
    return ref?.replace('refs/heads/', '');
  }

  if (eventType === 'workflow_run') {
    const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
    return workflowRun?.head_branch as string | undefined;
  }

  return undefined;
}

/**
 * Extract task ID from branch name
 * Branch format: feature/{taskId} or feature/{taskId}-{N} (multi-branch suffix)
 * Task ID format: task-YYYYMMDD-HHMM-random
 */
export function extractTaskIdFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const match = branch.match(/^feature\/(task-\d{8}-\d{4}-[a-z0-9]+)(?:-\d+)?$/i);
  return match ? match[1] : undefined;
}

// ============================================================================
// Event Message Formatting
// ============================================================================

/**
 * Format a GitHub event for the knowledge log
 */
export function formatGitHubEventMessage(context: GitHubEventContext): string {
  const { eventType, action, user, prNumber, body, state } = context;

  switch (eventType) {
    case 'pull_request_review':
      if (state === 'approved') {
        return `PR #${prNumber} approved by ${user}`;
      } else if (state === 'changes_requested') {
        return `PR #${prNumber}: ${user} requested changes${body ? `: ${body}` : ''}`;
      } else {
        return `PR #${prNumber}: ${user} commented${body ? `: ${body}` : ''}`;
      }

    case 'pull_request_review_comment':
      return `PR #${prNumber}: ${user} commented on code${body ? `: ${body}` : ''}`;

    case 'pull_request':
      if (action === 'closed') {
        return `PR #${prNumber} ${state === 'merged' ? 'merged' : 'closed'} by ${user}`;
      }
      return `PR #${prNumber}: ${action} by ${user}`;

    case 'push':
      return `Push to ${context.branch || 'branch'} by ${user}`;

    case 'workflow_run':
      const conclusion = state || 'completed';
      return `CI workflow ${conclusion} for ${context.branch || 'branch'}`;

    default:
      return `GitHub event: ${eventType}/${action} by ${user}`;
  }
}

// ============================================================================
// Merge Check Handling
// ============================================================================

/**
 * Debounce timers for merge checks (per task)
 */
const mergeCheckTimers = new Map<string, NodeJS.Timeout>();
const MERGE_CHECK_DEBOUNCE_MS = 5000;

/**
 * Handle merge check with debouncing
 *
 * Called for: PR approval, push, CI success
 * Debounces to avoid redundant checks when webhooks arrive in bursts.
 */
export function handleMergeCheckDirect(taskId: string): void {
  // Cancel any pending merge check for this task
  const existingTimer = mergeCheckTimers.get(taskId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logger.system(`GitHub: Debouncing merge check for task ${taskId}`);
  }

  // Schedule new merge check after debounce delay
  const timer = setTimeout(async () => {
    mergeCheckTimers.delete(taskId);
    logger.system(`GitHub: Running merge check for task ${taskId}`);
    await checkAndMergeLinkedPRs(taskId);
  }, MERGE_CHECK_DEBOUNCE_MS);

  mergeCheckTimers.set(taskId, timer);
}

// ============================================================================
// GitHub Routing (merged from system/webhook-router.ts)
// ============================================================================

/**
 * Route result for GitHub events
 */
export type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage'; taskId: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string };

/**
 * Internal route action
 */
type InternalRouteAction = 'merge_check' | 'existing_task' | 'triage_comment' | 'noop';

/**
 * Deterministic routing based on event type
 */
function determineRouteAction(context: GitHubEventContext): InternalRouteAction {
  const { eventType, action, state } = context;

  switch (eventType) {
    case 'pull_request_review':
      if (state === 'approved') return 'merge_check';
      if (state === 'changes_requested') return 'existing_task';
      if (state === 'commented') return 'existing_task';
      return 'noop';

    case 'pull_request_review_comment':
      return 'existing_task';

    case 'issue_comment':
      if (action !== 'created') return 'noop';
      return 'triage_comment';

    case 'pull_request':
      if (action === 'closed') return 'noop';
      if (action === 'opened' || action === 'synchronize') return 'merge_check';
      return 'noop';

    case 'push':
      return 'merge_check';

    case 'workflow_run':
      if (action === 'completed') {
        if (state === 'failure') return 'existing_task';
        return 'merge_check';
      }
      return 'noop';

    default:
      return 'noop';
  }
}

/**
 * Get our GitHub App bot username (e.g., "archie-hq[bot]")
 */
function getGitHubAppBotUsername(): string | null {
  const appSlug = process.env.GITHUB_APP_SLUG;
  return appSlug ? `${appSlug}[bot]` : null;
}

/**
 * Route a GitHub event
 *
 * Determines:
 * 1. If event should be discarded (not our branch, no task found, or our own bot)
 * 2. If event needs triage (issue_comment - to filter conversational noise)
 * 3. If event can be handled directly (approval, push, CI - deterministic)
 */
export async function routeGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<GitHubRouteResult> {
  const context = formatGitHubContext(eventType, payload);

  // Discard events from our own bot to avoid infinite loops
  const ourBotUsername = getGitHubAppBotUsername();
  if (ourBotUsername && context.user === ourBotUsername) {
    return { action: 'discard', reason: 'Own bot event' };
  }

  // Extract branch and task ID
  const branch = extractBranchFromPayload(eventType, payload);
  let taskId = extractTaskIdFromBranch(branch);

  // For issue_comment, branch isn't in payload - find task by PR number
  if (!taskId && eventType === 'issue_comment' && context.prNumber) {
    taskId = await findTaskByPRNumber(context.githubRepo, context.prNumber) ?? undefined;
  }

  // No task found - discard
  if (!taskId) {
    return { action: 'discard', reason: 'Not our branch pattern' };
  }

  // Verify task exists
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    return { action: 'discard', reason: `Task ${taskId} not found` };
  }

  // Determine route action
  const routeAction = determineRouteAction(context);

  switch (routeAction) {
    case 'triage_comment':
      // issue_comment needs triage to filter conversational noise
      return { action: 'triage', taskId };

    case 'existing_task':
      // Deterministic routing to existing task handler
      return { action: 'direct', handler: 'existing_task', taskId };

    case 'merge_check':
      // Deterministic routing to merge check
      return { action: 'direct', handler: 'merge_check', taskId };

    case 'noop':
    default:
      return { action: 'discard', reason: `No action needed for ${eventType}/${context.action}` };
  }
}
