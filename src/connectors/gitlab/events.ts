/**
 * GitLab webhook HTTP handler. Verifies X-Gitlab-Token, parses the payload into
 * the canonical NormalizedEventContext, routes via the self-contained
 * classifier in webhooks.ts, and dispatches to the existing-task handler, plus
 * a debounced CR-card refresh. There is no merge-on-green orchestrator on this
 * branch (deferred — see the rescope plan), so no merge-check / checks-ready
 * dispatch here.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import type { Application, Request, Response } from 'express';
import {
  routeGitLabEvent, formatGitLabContext, formatGitLabEvent,
  verifyGitLabToken, extractBranchFromPayload,
} from './webhooks.js';
import type { NormalizedEventContext } from '../../ports/repo-host-events.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent, findTaskByBranch, findTaskByPRNumber } from '../../tasks/persistence.js';
import { findBranchStateByPR } from '../github/branch-state.js';
import { extractTaskIdFromBranch } from '../github/branch-naming.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';

export function mountGitLabWebhook(app: Application, secret: string): void {
  logger.plain('GitLab webhook: POST /webhooks/gitlab');
  app.post('/webhooks/gitlab', require('express').raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    if (getIsShuttingDown()) { res.status(503).json({ error: 'Server is shutting down' }); return; }

    const token = req.headers['x-gitlab-token'] as string | undefined;
    if (!verifyGitLabToken(token, secret)) {
      logger.warn('Server', 'Invalid GitLab webhook token');
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.status(200).json({ received: true });

    try {
      const payload = JSON.parse(req.body.toString()) as Record<string, unknown>;
      const objectKind = (payload.object_kind as string) || (req.headers['x-gitlab-event'] as string) || 'unknown';
      await handleGitLabWebhook(objectKind, payload);
    } catch (error) {
      logger.error('Server', 'Error processing GitLab webhook', error);
    }
  });
}

async function handleGitLabWebhook(objectKind: string, payload: Record<string, unknown>): Promise<void> {
  const context = formatGitLabContext(objectKind, payload);
  logger.system(
    `GitLab webhook: ${context.eventType}/${context.action ?? ''} repo=${context.repo}` +
    (context.prNumber ? ` mr=!${context.prNumber}` : '') +
    (context.branch ? ` branch=${context.branch}` : '') +
    ` user=${context.user}` + (context.state ? ` state=${context.state}` : '')
  );

  await maybeRefreshCrCards(objectKind, payload, context);

  const route = await routeGitLabEvent(objectKind, payload);
  if (route.action === 'discard') { logger.system(`GitLab: ${route.reason}`); return; }
  if (route.action === 'direct' && route.handler === 'existing_task') {
    await handleExistingTaskDirect(route.taskId, context);
  }
}

const cardRefreshTimers = new Map<string, NodeJS.Timeout>();
const CARD_REFRESH_DEBOUNCE_MS = 2500;

async function resolveCardTask(objectKind: string, payload: Record<string, unknown>, context: NormalizedEventContext): Promise<Task | null> {
  const branch = extractBranchFromPayload(objectKind, payload);
  let taskId = extractTaskIdFromBranch(branch);
  if (!taskId && branch) taskId = (await findTaskByBranch(context.repo, branch)) ?? undefined;
  if (!taskId && context.prNumber) taskId = (await findTaskByPRNumber(context.repo, context.prNumber)) ?? undefined;
  if (!taskId) return null;
  try { return await Task.get(taskId); } catch { return null; }
}

async function maybeRefreshCrCards(objectKind: string, payload: Record<string, unknown>, context: NormalizedEventContext): Promise<void> {
  const isClosed = context.eventType === 'pull_request' && context.action === 'closed';
  const relevant = isClosed || objectKind === 'pipeline' || objectKind === 'push' || objectKind === 'note' ||
    (context.eventType === 'pull_request' && (context.action === 'opened' || context.action === 'synchronize'));
  if (!relevant) return;

  if (isClosed) {
    const task = await resolveCardTask(objectKind, payload, context);
    if (task && context.prNumber) {
      try { await task.refreshPrCardInPlace(context.repo, context.prNumber); }
      catch (error) { logger.warn('Server', 'CR card refresh failed on MR close', error); }
    }
    return;
  }

  const branch = extractBranchFromPayload(objectKind, payload);
  const key = `${context.repo}:${branch ?? context.prNumber ?? '?'}`;
  const existing = cardRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  cardRefreshTimers.set(key, setTimeout(() => {
    cardRefreshTimers.delete(key);
    void (async () => {
      try { const task = await resolveCardTask(objectKind, payload, context); if (task) await task.refreshAllPrCards(); }
      catch (error) { logger.warn('Server', `CR card CI refresh failed (${key})`, error); }
    })();
  }, CARD_REFRESH_DEBOUNCE_MS));
}

async function handleExistingTaskDirect(taskId: string, context: NormalizedEventContext): Promise<void> {
  const task = await Task.get(taskId);

  // Comment dedup for note events (guard against webhook redelivery), mirroring
  // the GitHub connector's last_processed_comment_id bookkeeping.
  if (context.eventType === 'issue_comment' && context.prNumber && context.commentId) {
    let lastProcessedId = 0;
    const matches: Array<{ state: { last_processed_comment_id?: number } }> = [];
    for (const attachments of Object.values(task.metadata.repositories)) {
      if (!Array.isArray(attachments)) continue;
      for (const attached of attachments) {
        if (attached.github !== context.repo) continue;
        const branchMatch = findBranchStateByPR(attached, context.prNumber);
        if (!branchMatch) continue;
        matches.push(branchMatch);
        const seen = branchMatch.state.last_processed_comment_id ?? 0;
        if (seen > lastProcessedId) lastProcessedId = seen;
      }
    }
    if (context.commentId <= lastProcessedId) {
      logger.system(`GitLab: Skipping already-processed note ${context.commentId} on MR !${context.prNumber}`);
      return;
    }
    for (const m of matches) m.state.last_processed_comment_id = context.commentId;
    task.debouncedSave();
  }

  await appendGitHubEvent(taskId, context.repo, formatGitLabEvent(context));
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
