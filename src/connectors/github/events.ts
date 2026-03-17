/**
 * GitHub Events — Webhook HTTP handler and event processing
 *
 * Handles GitHub webhook requests: signature verification, routing,
 * triage for issue comments, and direct event handling.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import type { Application, Request, Response } from 'express';

import {
  routeGitHubEvent,
  handleMergeCheckDirect,
  formatGitHubContext,
  formatGitHubEventMessage,
  verifyWebhookSignature,
} from './webhooks.js';
import { createGitHubClient } from './client.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent } from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { getAgentDefByGithubRepo } from '../../agents/registry.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { triageGitHubComment, type GitHubComment } from '../../system/triage.js';

/**
 * Mount the GitHub webhook endpoint on an Express router
 */
export function mountGitHubWebhook(app: Application, secret: string): void {
  logger.plain('GitHub webhook: POST /webhooks/github');
  app.post(
    '/webhooks/github',
    require('express').raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      if (getIsShuttingDown()) {
        res.status(503).json({ error: 'Server is shutting down' });
        return;
      }

      const signature = req.headers['x-hub-signature-256'] as string;
      const eventType = req.headers['x-github-event'] as string;

      if (!signature || !eventType) {
        res.status(400).json({ error: 'Missing required headers' });
        return;
      }

      const payload = req.body.toString();
      if (!verifyWebhookSignature(payload, signature, secret)) {
        logger.warn('Server', 'Invalid GitHub webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Acknowledge receipt immediately
      res.status(200).json({ received: true });

      // Process inline (fire-and-forget)
      try {
        const parsedPayload = JSON.parse(payload);
        await handleGitHubWebhook(eventType, parsedPayload);
      } catch (error) {
        logger.error('Server', 'Error processing GitHub webhook', error);
      }
    }
  );
}

/**
 * Handle GitHub webhook with inline routing
 */
async function handleGitHubWebhook(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const context = formatGitHubContext(eventType, payload);

  logger.system(
    `GitHub webhook: ${context.eventType}/${context.action}` +
      ` repo=${context.githubRepo}` +
      (context.prNumber ? ` pr=#${context.prNumber}` : '') +
      (context.branch ? ` branch=${context.branch}` : '') +
      ` user=${context.user}` +
      (context.state ? ` state=${context.state}` : '')
  );

  const route = await routeGitHubEvent(eventType, payload);

  if (route.action === 'discard') {
    logger.system(`GitHub: ${route.reason}`);
    return;
  }

  if (route.action === 'triage') {
    processGitHubTriage(route.taskId, payload).catch((err) =>
      logger.error('Server', 'Error processing GitHub triage', err)
    );
  } else if (route.action === 'direct') {
    if (route.handler === 'merge_check') {
      handleMergeCheckDirect(route.taskId);
    } else if (route.handler === 'existing_task') {
      await handleExistingTaskDirect(route.taskId, context);
    }
  }
}

/**
 * Handle existing task event directly (for deterministic events)
 * Logs the event and reactivates the task
 */
async function handleExistingTaskDirect(
  taskId: string,
  context: ReturnType<typeof formatGitHubContext>
): Promise<void> {
  const eventMessage = formatGitHubEventMessage(context);
  const repoDef = getAgentDefByGithubRepo(context.githubRepo);
  const repoKey = repoDef?.repo?.repoKey || 'unknown';

  const task = await Task.get(taskId);
  await appendGitHubEvent(taskId, repoKey, eventMessage);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

/**
 * Process GitHub triage inline (replaces triage queue for GitHub issue_comment)
 */
async function processGitHubTriage(taskId: string, payload: Record<string, unknown>): Promise<void> {
  const issue = payload.issue as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;

  if (!issue?.pull_request || !comment || !repository) {
    logger.warn('event-handler', 'GitHub payload missing required fields');
    return;
  }

  const prNumber = issue.number as number;
  const commentId = comment.id as number;
  const githubRepo = repository.full_name as string;

  const user = (comment.user as Record<string, unknown>)?.login as string || 'unknown';
  const body = comment.body as string || '';
  logger.system(`Processing GitHub PR #${prNumber} comment by ${user}: "${body}"`);

  const githubClient = createGitHubClient();
  if (!githubClient) {
    logger.warn('event-handler', 'GitHub client not configured');
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  const repoDef = getAgentDefByGithubRepo(githubRepo);
  if (!repoDef) {
    logger.warn('event-handler', `Unknown repo ${githubRepo}`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  let commentHistory: GitHubComment[];
  try {
    commentHistory = await githubClient.getPRComments(githubRepo, prNumber);
  } catch (error) {
    logger.error('event-handler', 'Failed to fetch PR comments', error);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  const currentComment = commentHistory.find((c) => c.id === commentId);
  if (!currentComment) {
    logger.warn('event-handler', `Comment ${commentId} not found in PR #${prNumber} history`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  const triageResult = await triageGitHubComment(currentComment, commentHistory, prNumber, githubRepo);

  if (triageResult.action === 'existing_task') {
    const task = await Task.get(taskId);
    const repoKey = repoDef.repo!.repoKey;
    const repoInfo = task.metadata.repositories[repoKey];
    const lastProcessedId = repoInfo?.last_processed_comment_id || 0;

    const newComments = commentHistory.filter((c) => c.id > lastProcessedId);

    for (const c of newComments) {
      const msg = `PR #${prNumber}: ${c.user} commented: ${c.body}`;
      await appendGitHubEvent(taskId, repoKey, msg);
    }

    if (repoInfo) {
      repoInfo.last_processed_comment_id = commentId;
    }

    task.debouncedSave();
    await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  } else {
    logger.system(`GitHub: Ignoring conversational comment on PR #${prNumber}`);
  }
}

/**
 * Fallback: Handle GitHub comment directly without triage
 */
async function handleGitHubCommentDirect(
  taskId: string,
  githubRepo: string,
  prNumber: number,
  comment: Record<string, unknown>
): Promise<void> {
  const repoDef = getAgentDefByGithubRepo(githubRepo);
  const repoKey = repoDef?.repo?.repoKey || 'unknown';

  const user = (comment.user as Record<string, unknown>)?.login as string || 'unknown';
  const body = comment.body as string || '';

  const task = await Task.get(taskId);
  await appendGitHubEvent(taskId, repoKey, `PR #${prNumber}: ${user} commented: ${body}`);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
