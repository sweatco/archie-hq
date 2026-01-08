/**
 * GitHub Event Handlers
 *
 * Handles incoming GitHub webhooks (PR reviews, comments, pushes, CI status).
 * Uses deterministic routing for most events, but issue_comment uses triage.
 * Branch pattern matching filters events to only process feature/task-* branches.
 */

import crypto from 'crypto';
import {
  appendGitHubEvent,
  loadMetadata,
  findTaskByPRNumber,
  updatePRCommentTimestamp,
} from '../system/task-manager.js';
import {
  notifyNewInput,
  isTaskActive,
  reactivateTask,
} from '../system/task-runtime.js';
import { checkAndMergeLinkedPRs } from './merge-orchestrator.js';
import { createGitHubClient } from './client.js';
import { triageGitHubComment } from '../agents/triage.js';
import { getRepoConfigByGithubRepo } from '../agents/repo-configs.js';
import { logger } from '../system/logger.js';

/**
 * Debounce timers for merge checks (per task)
 * Prevents multiple simultaneous merge checks when webhooks arrive in bursts
 */
const mergeCheckTimers = new Map<string, NodeJS.Timeout>();
const MERGE_CHECK_DEBOUNCE_MS = 5000;

/**
 * Route action for GitHub events
 */
type GitHubRouteAction = 'merge_check' | 'existing_task' | 'triage_comment' | 'noop';

/**
 * GitHub webhook event context extracted from payload
 */
export interface GitHubEventContext {
  eventType: string; // pull_request, pull_request_review, pull_request_review_comment, push, workflow_run
  action: string; // submitted, created, completed, closed, synchronize, etc.
  githubRepo: string; // owner/repo format
  prNumber?: number;
  branch?: string;
  user: string;
  body?: string;
  state?: string; // For reviews: approved, changes_requested, commented
  commentId?: number; // For issue_comment events
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
    // issue_comment on a PR - issue contains PR number, comment contains body
    const issue = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    // Only PRs have pull_request field in issue
    if (issue?.pull_request) {
      context.prNumber = issue?.number as number | undefined;
      context.body = comment?.body as string | undefined;
      context.commentId = comment?.id as number | undefined;
      // Note: branch not available in issue_comment, will be looked up via PR number
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
 * Extract branch name from various GitHub event types
 */
function extractBranchFromPayload(
  eventType: string,
  payload: Record<string, unknown>
): string | undefined {
  // PR-related events have pull_request.head.ref
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  if (pullRequest) {
    return (pullRequest.head as Record<string, unknown>)?.ref as string | undefined;
  }

  // Push events have ref (e.g., refs/heads/feature/task-xxx)
  if (eventType === 'push') {
    const ref = payload.ref as string | undefined;
    return ref?.replace('refs/heads/', '');
  }

  // Workflow run events have workflow_run.head_branch
  if (eventType === 'workflow_run') {
    const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
    return workflowRun?.head_branch as string | undefined;
  }

  return undefined;
}

/**
 * Extract task ID from branch name
 * Branch format: feature/task-{taskId}
 * Returns undefined if branch doesn't match our pattern
 */
function extractTaskIdFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const match = branch.match(/^feature\/(task-[a-z0-9-]+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Deterministic routing for GitHub events
 * No LLM calls - routes based on event type and action
 */
function routeGitHubEvent(context: GitHubEventContext): GitHubRouteAction {
  const { eventType, action, state } = context;

  switch (eventType) {
    case 'pull_request_review':
      // Approval → check if ready to merge
      if (state === 'approved') return 'merge_check';
      // Changes requested or comments → PM needs to handle
      if (state === 'changes_requested') return 'existing_task';
      if (state === 'commented') return 'existing_task';
      return 'noop';

    case 'pull_request_review_comment':
      // Code comments always need PM attention
      return 'existing_task';

    case 'issue_comment':
      // Only handle new comments, ignore edits and deletions
      if (action !== 'created') return 'noop';
      // PR comments go through triage to filter noise
      return 'triage_comment';

    case 'pull_request':
      // PR closed/merged → no action needed
      if (action === 'closed') return 'noop';
      // PR opened/synchronized → check merge status
      if (action === 'opened' || action === 'synchronize') return 'merge_check';
      return 'noop';

    case 'push':
      // Push to branch → check if ready to merge
      return 'merge_check';

    case 'workflow_run':
      // CI completed → check merge status (success or failure)
      if (action === 'completed') {
        // CI failure → notify PM
        if (state === 'failure') return 'existing_task';
        // CI success → check if ready to merge
        return 'merge_check';
      }
      return 'noop';

    default:
      return 'noop';
  }
}

/**
 * Main GitHub webhook handler
 *
 * Flow:
 * 1. Log all incoming webhook events
 * 2. Extract branch name from payload (or PR number for issue_comment)
 * 3. Check if branch matches feature/task-* pattern (or find task by PR number)
 * 4. Route deterministically based on event type (no LLM)
 */
export async function handleGitHubWebhook(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Extract full context for logging
  const context = formatGitHubContext(eventType, payload);

  // Log all webhook events
  logger.system(
    `GitHub webhook: ${context.eventType}/${context.action}` +
      ` repo=${context.githubRepo}` +
      (context.prNumber ? ` pr=#${context.prNumber}` : '') +
      (context.branch ? ` branch=${context.branch}` : '') +
      ` user=${context.user}` +
      (context.state ? ` state=${context.state}` : '')
  );

  // Extract branch and task ID
  const branch = extractBranchFromPayload(eventType, payload);
  let taskId = extractTaskIdFromBranch(branch);

  // For issue_comment, branch isn't in payload - need to find task by PR number
  if (!taskId && eventType === 'issue_comment' && context.prNumber) {
    taskId = await findTaskByPRNumber(context.githubRepo, context.prNumber) ?? undefined;
  }

  // Early exit if not our branch pattern and couldn't find by PR
  if (!taskId) {
    logger.system(`GitHub: Ignoring (not our branch pattern)`);
    return;
  }

  // Verify task exists
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.warn('github/events', `Task ${taskId} not found for branch ${branch}`);
    return;
  }

  // Deterministic routing - no LLM call
  const routeAction = routeGitHubEvent(context);

  switch (routeAction) {
    case 'existing_task':
      await handleExistingTaskEvent(taskId, context);
      break;

    case 'triage_comment':
      await handleIssueCommentWithTriage(taskId, context, metadata);
      break;

    case 'merge_check':
      handleMergeCheck(taskId, context);
      break;

    case 'noop':
      logger.system(`GitHub: No action needed for ${eventType}/${context.action}`);
      break;
  }
}

/**
 * Handle a GitHub event for an existing task
 * This is for events that need PM attention (changes_requested, comments)
 */
async function handleExistingTaskEvent(
  taskId: string,
  context: GitHubEventContext
): Promise<void> {
  // Format the event for the knowledge log
  const eventMessage = formatEventMessage(context);

  // Get repoKey from githubRepo
  const repoConfig = getRepoConfigByGithubRepo(context.githubRepo);
  const repoKey = repoConfig?.repoKey || 'unknown';

  // Append to knowledge.log
  await appendGitHubEvent(taskId, repoKey, eventMessage);

  // Check if task needs reactivation
  if (!isTaskActive(taskId)) {
    await reactivateTask(taskId);
  }

  // Notify PM of new GitHub event
  await notifyNewInput(taskId);
}

/**
 * Handle issue_comment with triage to filter conversational noise
 *
 * Flow (mirrors Slack message handling):
 * 1. Fetch PR comment history from GitHub API
 * 2. Run triage to decide if actionable
 * 3. If existing_task: log all new comments since last processed, update timestamp, notify PM
 * 4. If noop: do nothing (comments will be logged when future comment triggers existing_task)
 */
async function handleIssueCommentWithTriage(
  taskId: string,
  context: GitHubEventContext,
  metadata: import('../types/index.js').TaskMetadata
): Promise<void> {
  const { githubRepo, prNumber, commentId } = context;

  if (!prNumber || !commentId) {
    logger.warn('github/events', 'issue_comment missing PR number or comment ID');
    return;
  }

  // Get GitHub client
  const githubClient = createGitHubClient();
  if (!githubClient) {
    // Fallback to deterministic routing if no client
    logger.warn('github/events', 'GitHub client not configured, falling back to direct routing');
    await handleExistingTaskEvent(taskId, context);
    return;
  }

  // Find the repoKey for this githubRepo
  const repoConfig = getRepoConfigByGithubRepo(githubRepo);

  if (!repoConfig) {
    logger.warn('github/events', `Unknown repo ${githubRepo}, falling back to direct routing`);
    await handleExistingTaskEvent(taskId, context);
    return;
  }

  // Fetch PR comment history
  let commentHistory;
  try {
    commentHistory = await githubClient.getPRComments(githubRepo, prNumber);
  } catch (error) {
    logger.error('github/events', 'Failed to fetch PR comments', error);
    await handleExistingTaskEvent(taskId, context);
    return;
  }

  // Find the current comment in history by ID
  const currentComment = commentHistory.find((c) => c.id === commentId);
  if (!currentComment) {
    // Comment not in history - might be deleted or API issue, fall back to direct routing
    logger.warn('github/events', `Comment ${commentId} not found in PR #${prNumber} history`);
    await handleExistingTaskEvent(taskId, context);
    return;
  }

  // Run triage
  const triageResult = await triageGitHubComment(
    currentComment,
    commentHistory,
    prNumber,
    githubRepo
  );

  // Get last processed comment ID
  const repoInfo = metadata.repositories[repoConfig.repoKey];
  const lastProcessedId = repoInfo?.last_processed_comment_id || 0;

  if (triageResult.action === 'existing_task') {
    // Log all new comments since last processed
    const newComments = commentHistory.filter((c) => c.id > lastProcessedId);

    for (const comment of newComments) {
      const message = `PR #${prNumber}: ${comment.user} commented: ${comment.body}`;
      await appendGitHubEvent(taskId, repoConfig.repoKey, message);
    }

    // Update last processed to the comment that triggered this event
    await updatePRCommentTimestamp(taskId, repoConfig.repoKey, commentId);

    // Check if task needs reactivation
    if (!isTaskActive(taskId)) {
      await reactivateTask(taskId);
    }

    // Notify PM of GitHub event
    await notifyNewInput(taskId);
  } else {
    // noop - don't update last processed, don't notify PM
    // This way, if a later comment triggers existing_task, we'll log all accumulated comments
    logger.system(`GitHub: Ignoring conversational comment on PR #${prNumber}`);
  }
}

/**
 * Handle a merge check trigger with debouncing
 * Called on: PR approval, push, CI success
 *
 * Debounces multiple webhooks arriving in quick succession (e.g., 3 CI checks
 * completing at once) to avoid running redundant merge checks.
 */
function handleMergeCheck(taskId: string, _context: GitHubEventContext): void {
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

/**
 * Format a GitHub event context into a human-readable message
 */
function formatEventMessage(context: GitHubEventContext): string {
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
