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
  extractBranchFromPayload,
} from './webhooks.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent, findTaskByPRNumber, findTaskByBranch, loadMetadata } from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { findBranchStateByPR } from './branch-state.js';
import { extractTaskIdFromBranch } from './branch-naming.js';
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

  // Keep PR cards fresh on CI completion and PR close, independent of the
  // merge/checks routing decision (CI-success check_suites route to noop).
  await maybeRefreshPrCards(eventType, payload, context);

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
 * Per-(repo+branch) debounce for CI-driven PR-card refreshes. A single PR
 * completion fans out into many webhooks (one check_run per job, plus the
 * check_suite and workflow_run), each of which would otherwise trigger its own
 * card refresh + GitHub fetch. Coalesce them into one refresh shortly after the
 * burst settles; the refresh re-reads all checks, so the final count is correct.
 */
const cardRefreshTimers = new Map<string, NodeJS.Timeout>();
const CARD_REFRESH_DEBOUNCE_MS = 2500;

/**
 * Resolve the task that owns this event's branch/PR, but only if it already has
 * a posted PR card (the first card is posted at the PM turn-end, not here).
 * Resolution order: `archie/{taskId}` branch pattern → branch lookup (handles
 * semantically-named branches and PR-number-less events like workflow_run) →
 * PR number. Returns null (with a debug log) when nothing resolves.
 */
async function resolveCardTask(
  eventType: string,
  payload: Record<string, unknown>,
  context: ReturnType<typeof formatGitHubContext>
): Promise<Task | null> {
  const branch = extractBranchFromPayload(eventType, payload);
  let taskId = extractTaskIdFromBranch(branch);
  if (!taskId && branch) taskId = (await findTaskByBranch(context.githubRepo, branch)) ?? undefined;
  if (!taskId && context.prNumber) {
    taskId = (await findTaskByPRNumber(context.githubRepo, context.prNumber)) ?? undefined;
  }
  if (!taskId) {
    logger.system(`PR card: ${eventType}/${context.action} on ${context.githubRepo} (branch=${branch ?? '?'}, pr=${context.prNumber ?? '?'}) — no task resolved`);
    return null;
  }

  // Cheap pre-check: skip the (heavy) Task.get unless a card has been posted.
  const meta = await loadMetadata(taskId);
  const hasCard = !!meta && Object.values(meta.repositories ?? {}).some(
    (attachments) =>
      Array.isArray(attachments) &&
      attachments.some((a) => Object.values(a.branch_states ?? {}).some((s) => s.pr_card)),
  );
  if (!hasCard) return null;

  try {
    return await Task.get(taskId);
  } catch {
    return null; // task not found / unreadable
  }
}

/**
 * Update PR cards in place for events that change a card without an accompanying
 * PM message: CI completion (check_run / check_suite / workflow_run completed)
 * and PR close/merge. Routing-independent so it also catches CI *successes*,
 * which route to noop. CI refreshes are debounced; PR close is immediate.
 */
async function maybeRefreshPrCards(
  eventType: string,
  payload: Record<string, unknown>,
  context: ReturnType<typeof formatGitHubContext>
): Promise<void> {
  const isCiDone =
    (eventType === 'check_run' || eventType === 'check_suite' || eventType === 'workflow_run') &&
    context.action === 'completed';
  const isPrClosed = eventType === 'pull_request' && context.action === 'closed';
  if (!isCiDone && !isPrClosed) return;

  if (isPrClosed) {
    const task = await resolveCardTask(eventType, payload, context);
    if (task && context.prNumber) {
      try {
        await task.refreshPrCardInPlace(context.githubRepo, context.prNumber);
      } catch (error) {
        logger.warn('Server', `PR card refresh failed on PR close`, error);
      }
    }
    return;
  }

  // CI: debounce the burst (per repo+branch) into a single refresh.
  const branch = extractBranchFromPayload(eventType, payload);
  const key = `${context.githubRepo}:${branch ?? context.prNumber ?? '?'}`;
  const existing = cardRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  cardRefreshTimers.set(key, setTimeout(() => {
    cardRefreshTimers.delete(key);
    void (async () => {
      try {
        const task = await resolveCardTask(eventType, payload, context);
        if (task) await task.refreshAllPrCards();
      } catch (error) {
        logger.warn('Server', `PR card CI refresh failed (${key})`, error);
      }
    })();
  }, CARD_REFRESH_DEBOUNCE_MS));
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
  const task = await Task.get(taskId);

  if (context.eventType === 'issue_comment' && context.prNumber && context.commentId) {
    // Walk every attached repo across every agent looking for a branch state
    // matching this PR. Update `last_processed_comment_id` on every match
    // (two agents on the same PR should both dedup against the same id).
    let lastProcessedId = 0;
    const matches: Array<{ state: { last_processed_comment_id?: number } }> = [];
    for (const attachments of Object.values(task.metadata.repositories)) {
      if (!Array.isArray(attachments)) continue;
      for (const attached of attachments) {
        if (attached.github !== context.githubRepo) continue;
        const branchMatch = findBranchStateByPR(attached, context.prNumber);
        if (!branchMatch) continue;
        matches.push(branchMatch);
        const seen = branchMatch.state.last_processed_comment_id ?? 0;
        if (seen > lastProcessedId) lastProcessedId = seen;
      }
    }

    if (context.commentId <= lastProcessedId) {
      logger.system(`GitHub: Skipping already-processed comment ${context.commentId} on PR #${context.prNumber}`);
      return;
    }

    for (const m of matches) {
      m.state.last_processed_comment_id = context.commentId;
    }
    task.debouncedSave();
  }

  await appendGitHubEvent(taskId, context.githubRepo, formatGitHubEvent(context));
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
