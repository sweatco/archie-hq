/**
 * Webhook Router
 *
 * Fast, code-only routing logic for webhooks.
 * Determines whether events should be queued, handled directly, or discarded.
 *
 * GitHub-specific utilities (context extraction, message formatting, merge checks)
 * are in src/github/webhook-utils.ts
 */

import { findTaskByPRNumber, loadMetadata } from './task-manager.js';
import {
  formatGitHubContext,
  extractBranchFromPayload,
  extractTaskIdFromBranch,
  type GitHubEventContext,
} from '../github/webhook-utils.js';
import { getBotId } from '../slack/client.js';

// Re-export GitHub utilities for convenience
export {
  formatGitHubContext,
  formatGitHubEventMessage,
  handleMergeCheckDirect,
  type GitHubEventContext,
} from '../github/webhook-utils.js';

// ============================================================================
// Slack Routing
// ============================================================================

/**
 * Route result for Slack events
 */
export type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };

/**
 * Route a Slack event
 *
 * Slack events always need triage (to classify as new_task, existing_task, etc.)
 * unless they're our own bot's messages which are discarded.
 */
export function routeSlackEvent(event: {
  bot_id?: string;
  type: string;
}): SlackRouteResult {
  // Discard our own bot's messages to avoid infinite loops
  const ourBotId = getBotId();
  if (event.bot_id && ourBotId && event.bot_id === ourBotId) {
    return { action: 'discard', reason: 'Own bot message' };
  }

  // All other messages (including from other bots) need triage
  return { action: 'triage' };
}

// ============================================================================
// GitHub Routing
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
