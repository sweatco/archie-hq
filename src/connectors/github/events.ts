/**
 * GitHub Events — Webhook HTTP handler and event processing
 *
 * Handles GitHub webhook requests: signature verification, routing, and
 * direct dispatch to the existing-task handler or merge check.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import type { Application, Request, Response } from 'express';

import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';

import {
  routeGitHubEvent,
  handleMergeCheckDirect,
  handleChecksReadyDirect,
  formatGitHubContext,
  formatGitHubEvent,
  verifyWebhookSignature,
} from './webhooks.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent } from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { getAgentDefByGithubRepo } from '../../agents/registry.js';
import { findBranchStateByPR } from './branch-state.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { WORKDIR } from '../../system/workdir.js';

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
        await maybeDumpRawPayload(eventType, parsedPayload);
        await handleGitHubWebhook(eventType, parsedPayload);
      } catch (error) {
        logger.error('Server', 'Error processing GitHub webhook', error);
      }
    }
  );
}

/**
 * When ARCHIE_DEBUG_GITHUB_WEBHOOKS=1, persist the raw payload to
 * `${WORKDIR}/logs/github-webhooks/` so the exact shape can be inspected
 * offline. Used for capturing sample payloads (e.g. check_suite) before
 * extending parsing logic.
 */
async function maybeDumpRawPayload(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (process.env.ARCHIE_DEBUG_GITHUB_WEBHOOKS !== '1') return;
  try {
    const dir = join(WORKDIR, 'logs', 'github-webhooks');
    await mkdir(dir, { recursive: true });
    const action = (payload.action as string | undefined) || 'noaction';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${ts}-${eventType}-${action}.json`;
    await writeFile(join(dir, fname), JSON.stringify(payload, null, 2));
    logger.system(`GitHub webhook: dumped raw payload to ${fname}`);
  } catch (error) {
    logger.warn('Server', `Failed to dump webhook payload: ${error instanceof Error ? error.message : error}`);
  }
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

  if (route.action === 'direct') {
    if (route.handler === 'merge_check') {
      handleMergeCheckDirect(route.taskId);
    } else if (route.handler === 'existing_task') {
      await handleExistingTaskDirect(route.taskId, context);
    } else if (route.handler === 'checks_ready') {
      handleChecksReadyDirect(route.taskId, route.githubRepo, route.prNumber);
    }
  }
}

/**
 * Handle an existing-task event: log to shared knowledge, update PR bookkeeping
 * (for issue_comment), and wake the PM agent.
 *
 * The issue_comment branch preserves `last_processed_comment_id` on both
 * branch_states and legacy repoInfo so future features (e.g. backfill from
 * external PR tracking) can resume mid-conversation. The same field doubles
 * as a dedup guard against webhook redelivery.
 */
async function handleExistingTaskDirect(
  taskId: string,
  context: ReturnType<typeof formatGitHubContext>
): Promise<void> {
  const repoDef = getAgentDefByGithubRepo(context.githubRepo);
  const repoKey = repoDef?.repo?.repoKey || 'unknown';
  const task = await Task.get(taskId);

  if (context.eventType === 'issue_comment' && context.prNumber && context.commentId) {
    const repoInfo = task.metadata.repositories[repoKey];
    const branchMatch = repoInfo ? findBranchStateByPR(repoInfo, context.prNumber) : undefined;
    const lastProcessedId = branchMatch?.state.last_processed_comment_id
      ?? repoInfo?.last_processed_comment_id
      ?? 0;

    if (context.commentId <= lastProcessedId) {
      logger.system(`GitHub: Skipping already-processed comment ${context.commentId} on PR #${context.prNumber}`);
      return;
    }

    if (branchMatch) {
      branchMatch.state.last_processed_comment_id = context.commentId;
    }
    if (repoInfo) {
      repoInfo.last_processed_comment_id = context.commentId;
    }
    task.debouncedSave();
  }

  await appendGitHubEvent(taskId, context.githubRepo, formatGitHubEvent(context));
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
