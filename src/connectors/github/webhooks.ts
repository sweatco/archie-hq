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
import { findTaskByPRNumber, loadMetadata, appendGitHubEvent } from '../../tasks/persistence.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
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
    context.commentId = comment?.id as number | undefined;
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
  } else if (eventType === 'check_suite') {
    const checkSuite = payload.check_suite as Record<string, unknown> | undefined;
    context.branch = checkSuite?.head_branch as string | undefined;
    context.state = (checkSuite?.conclusion as string | undefined) ?? (checkSuite?.status as string | undefined);
    const prs = checkSuite?.pull_requests as Array<Record<string, unknown>> | undefined;
    const firstPr = prs && prs.length > 0 ? prs[0] : undefined;
    if (firstPr?.number !== undefined) {
      context.prNumber = firstPr.number as number;
    }
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

  if (eventType === 'check_suite') {
    const checkSuite = payload.check_suite as Record<string, unknown> | undefined;
    return checkSuite?.head_branch as string | undefined;
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
 * Structured GitHub event for the knowledge log and CLI rendering.
 * Mirrors the shape Slack and CLI emit so the CLI renders GitHub events
 * uniformly: `[from in destination] @pm-agent message`.
 */
export interface FormattedGitHubEvent {
  from: string;
  destination: string;
  message: string;
}

/**
 * Format a GitHub event into the structured Slack/CLI-compatible shape.
 */
export function formatGitHubEvent(context: GitHubEventContext): FormattedGitHubEvent {
  const { eventType, action, user, prNumber, body, state, commentId } = context;
  const prDest = prNumber ? `PR #${prNumber}` : 'PR';
  const branchDest = `branch:${context.branch || 'unknown'}`;
  const cidTag = commentId ? ` [comment_id=${commentId}]` : '';

  switch (eventType) {
    case 'pull_request_review':
      if (state === 'approved') {
        return { from: user, destination: prDest, message: 'approved' };
      } else if (state === 'changes_requested') {
        return { from: user, destination: prDest, message: body ? `requested changes: ${body}` : 'requested changes' };
      } else {
        return { from: user, destination: prDest, message: body ? `commented: ${body}` : 'commented' };
      }

    case 'pull_request_review_comment':
      return { from: user, destination: prDest, message: body ? `commented on code${cidTag}: ${body}` : `commented on code${cidTag}` };

    case 'issue_comment':
      return { from: user, destination: prDest, message: body ? `${body}${cidTag}` : `(empty)${cidTag}` };

    case 'pull_request':
      if (action === 'closed') {
        return { from: user, destination: prDest, message: state === 'merged' ? 'merged' : 'closed' };
      }
      return { from: user, destination: prDest, message: action };

    case 'push':
      return { from: user, destination: branchDest, message: 'pushed' };

    case 'workflow_run':
      return { from: 'ci', destination: branchDest, message: `workflow ${state || 'completed'}` };

    case 'check_suite':
      return {
        from: 'ci',
        destination: prNumber ? prDest : branchDest,
        message: `checks ${state || action}`,
      };

    default:
      return { from: user, destination: prDest, message: `${eventType}/${action}` };
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
// Checks-Ready Debouncing
// ============================================================================

/**
 * Per-PR debounce timers for check_suite.completed events. A push typically
 * triggers several check suites which complete within seconds of each other;
 * we coalesce them into a single PM ping so the agent inspects checks once.
 *
 * Key format: `${taskId}:${githubRepo}#${prNumber}` — per-PR, not per-task.
 */
const checksReadyTimers = new Map<string, NodeJS.Timeout>();
const CHECKS_READY_DEBOUNCE_MS = 20_000;

/**
 * Handle check_suite.completed with per-PR debouncing.
 *
 * Resets the timer on every event in the window; on fire, appends one
 * structured GitHub event to knowledge.log and wakes PM with the standard
 * `existingTask` prompt. PM is expected to call `get_pr_checks` to inspect.
 */
export function handleChecksReadyDirect(
  taskId: string,
  githubRepo: string,
  prNumber: number
): void {
  const key = `${taskId}:${githubRepo}#${prNumber}`;
  const existingTimer = checksReadyTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logger.system(`GitHub: Debouncing checks_ready for ${key}`);
  }

  const timer = setTimeout(async () => {
    checksReadyTimers.delete(key);
    logger.system(`GitHub: Firing checks_ready for ${key}`);
    try {
      await appendGitHubEvent(taskId, githubRepo, {
        from: 'ci',
        destination: `PR #${prNumber}`,
        message: `checks updated — call get_pr_checks(${prNumber}) to inspect`,
      });
      const task = await Task.get(taskId);
      await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
    } catch (error) {
      logger.error('checks-ready', `Failed to deliver checks_ready ping for ${key}`, error);
    }
  }, CHECKS_READY_DEBOUNCE_MS);

  checksReadyTimers.set(key, timer);
}

// ============================================================================
// GitHub Routing (merged from system/webhook-router.ts)
// ============================================================================

/**
 * Route result for GitHub events
 */
export type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string }
  | {
      action: 'direct';
      handler: 'checks_ready';
      taskId: string;
      githubRepo: string;
      prNumber: number;
    };

/**
 * Internal route action
 */
type InternalRouteAction = 'merge_check' | 'existing_task' | 'checks_ready' | 'noop';

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
      return 'existing_task';

    case 'pull_request':
      if (action === 'closed') return 'existing_task';
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

    case 'check_suite':
      if (action !== 'completed') return 'noop';
      // Only wake PM on failure-like conclusions. Success/neutral/skipped
      // are already covered by the pre-existing merge triggers
      // (workflow_run, push, pull_request_review) — no need to duplicate.
      if (
        state === 'failure' ||
        state === 'cancelled' ||
        state === 'timed_out' ||
        state === 'action_required'
      ) {
        return 'checks_ready';
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
 * 2. If event routes to a merge check (approval, push, CI success)
 * 3. If event routes to the existing-task handler (comments, reviews, CI failure, PR closed/merged)
 */
export async function routeGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<GitHubRouteResult> {
  const context = formatGitHubContext(eventType, payload);

  // Discard comment/review-style events from our own bot to avoid infinite loops
  // (bot posts → webhook → PM wake → bot posts again). Machine events
  // (check_suite, workflow_run, push) carry the bot as `sender` whenever the
  // bot pushed the triggering commit, but they're CI output — not a reply
  // loop — so we must process them.
  const ourBotUsername = getGitHubAppBotUsername();
  const isMachineEvent =
    eventType === 'check_suite' ||
    eventType === 'workflow_run' ||
    eventType === 'push';
  if (ourBotUsername && context.user === ourBotUsername && !isMachineEvent) {
    return { action: 'discard', reason: 'Own bot event' };
  }

  // Extract branch and task ID
  const branch = extractBranchFromPayload(eventType, payload);
  let taskId = extractTaskIdFromBranch(branch);

  // For issue_comment, branch isn't in payload - find task by PR number
  if (!taskId && eventType === 'issue_comment' && context.prNumber) {
    taskId = await findTaskByPRNumber(context.githubRepo, context.prNumber) ?? undefined;
  }

  // For check_suite events, fall back to PR-number lookup if the branch
  // doesn't match our feature/{taskId} pattern (e.g. suite attached to base).
  if (!taskId && eventType === 'check_suite' && context.prNumber) {
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
    case 'existing_task':
      return { action: 'direct', handler: 'existing_task', taskId };

    case 'merge_check':
      return { action: 'direct', handler: 'merge_check', taskId };

    case 'checks_ready':
      if (!context.prNumber) {
        return { action: 'discard', reason: 'check_suite without attached PR' };
      }
      return {
        action: 'direct',
        handler: 'checks_ready',
        taskId,
        githubRepo: context.githubRepo,
        prNumber: context.prNumber,
      };

    case 'noop':
    default:
      return { action: 'discard', reason: `No action needed for ${eventType}/${context.action}` };
  }
}
