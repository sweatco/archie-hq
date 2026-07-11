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
  type GitHubMentionEvent,
} from './webhooks.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent, findTaskByPRNumber, findTaskByBranch, findTaskByIssueChannel } from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { findBranchStateByPR } from './branch-state.js';
import { extractTaskIdFromBranch } from './branch-naming.js';
import { getGitHubClient } from './client.js';
import { findAgentDefsContainingRepo } from '../../agents/registry.js';
import type { GitHubChannel } from '../../types/task.js';
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
    } else if (route.handler === 'new_task') {
      await handleGitHubMentionDirect(route.mention);
    }
  }
}

// ============================================================================
// Mention → new task
// ============================================================================

/**
 * Per-thread decline dedup: `repo#issue` → last-declined timestamp. Caps an
 * authorized user's mention burst on an uncovered repo at one decline comment
 * per thread per window. Process-local; lost on restart (worst case: one
 * duplicate decline).
 */
const DECLINE_DEDUP_WINDOW_MS = 10 * 60_000;
const recentDeclines = new Map<string, number>();

/**
 * True when a decline was already posted for this thread within the window.
 * Lazily evicts expired entries on every access so the map cannot grow
 * unboundedly across threads.
 */
function shouldSkipDecline(threadRef: string, now = Date.now()): boolean {
  for (const [key, at] of recentDeclines) {
    if (now - at >= DECLINE_DEDUP_WINDOW_MS) recentDeclines.delete(key);
  }
  return recentDeclines.has(threadRef);
}

/** Canonical URL of the issue/PR thread itself (mention.htmlUrl may point at the comment). */
function threadUrl(mention: GitHubMentionEvent): string {
  return `https://github.com/${mention.githubRepo}/${mention.isPr ? 'pull' : 'issues'}/${mention.issueNumber}`;
}

/**
 * Handle a summoning mention: authorization gate (fail closed), repo-coverage
 * gate (polite decline, deduped), race re-check, then create → link → flush →
 * seed → ack → wake PM. Exported for tests.
 *
 * All Archie-authored text on this path (decline, ack) is mention-free so the
 * self-filter is never load-bearing against our own output (loop safety).
 */
export async function handleGitHubMentionDirect(mention: GitHubMentionEvent): Promise<void> {
  const { githubRepo, issueNumber, author } = mention;
  const threadRef = `${githubRepo}#${issueNumber}`;
  const destination = `${mention.isPr ? 'PR' : 'issue'} #${issueNumber}`;

  const client = getGitHubClient();
  if (!client) {
    logger.warn('Server', `GitHub mention on ${threadRef} by ${author} discarded — GitHub client not configured (fail closed)`);
    return;
  }

  // Authorization: write/maintain/admin only (legacy permission values map
  // maintain→write and triage→read). Unauthorized and lookup failures discard
  // silently — no task, no reply, no probing surface.
  let permission: string;
  try {
    permission = await client.getCollaboratorPermission(githubRepo, author);
  } catch (error) {
    logger.warn('Server', `GitHub mention on ${threadRef} by ${author} discarded — permission lookup failed (fail closed)`, error);
    return;
  }
  if (permission !== 'admin' && permission !== 'write') {
    logger.system(`GitHub: mention on ${threadRef} by ${author} discarded — permission '${permission}' (write/admin required)`);
    return;
  }

  // Coverage: repos no plugin declares get a polite decline (authorized
  // authors only — this runs after the permission gate), deduped per thread.
  if (findAgentDefsContainingRepo(githubRepo).length === 0) {
    if (shouldSkipDecline(threadRef)) {
      logger.system(`GitHub: decline on ${threadRef} suppressed — already declined within the window`);
      return;
    }
    try {
      await client.addPRComment(
        githubRepo,
        issueNumber,
        "Thanks for the mention! I don't currently cover this repository — ask an Archie admin to add it to my plugin configuration.",
      );
      recentDeclines.set(threadRef, Date.now());
    } catch (error) {
      logger.warn('Server', `Failed to post uncovered-repo decline on ${threadRef}`, error);
    }
    return;
  }

  // Race re-check: a near-simultaneous mention may have mapped this thread
  // while the gates ran (the mapping is a lockless fs scan). Fall through to
  // existing-task delivery instead of minting a duplicate.
  const existingTaskId = await findTaskByIssueChannel(githubRepo, issueNumber);
  if (existingTaskId) {
    logger.system(`GitHub: mention on ${threadRef} resolved to existing task ${existingTaskId} — delivering there`);
    await handleExistingTaskDirect(existingTaskId, {
      eventType: mention.commentId !== undefined ? 'issue_comment' : 'issues',
      action: mention.commentId !== undefined ? 'created' : 'opened',
      githubRepo,
      issueNumber,
      prNumber: mention.isPr ? issueNumber : undefined,
      user: author,
      body: mention.commentBody ?? mention.issueBody,
      commentId: mention.commentId,
    });
    return;
  }

  try {
    const task = await Task.create();
    const channelKey = task.linkGitHubChannel(githubRepo, issueNumber, mention.isPr);
    if (mention.commentId !== undefined) {
      // The seed below consumes the triggering comment — set the watermark so a
      // webhook redelivery (which now resolves via the mapping) dedups to a no-op.
      (task.metadata.channels[channelKey] as GitHubChannel).last_processed_comment_id = mention.commentId;
    }
    task.metadata.title ??= mention.issueTitle || undefined;
    // Synchronous flush: the channel entry is the GitHub-born readonly marker —
    // it must never sit in the 500ms debounce window (a crash there would leave
    // a task the guards don't recognize).
    await task.save(true);

    const contextEntry = [
      `opened "${mention.issueTitle}"`,
      mention.issueBody,
      threadUrl(mention),
    ].filter(Boolean).join('\n\n');
    await appendGitHubEvent(task.taskId, githubRepo, {
      from: mention.issueAuthor ?? author,
      destination,
      message: contextEntry,
    });
    if (mention.commentId !== undefined && mention.commentBody !== undefined) {
      await appendGitHubEvent(task.taskId, githubRepo, {
        from: author,
        destination,
        message: `${mention.commentBody} [comment_id=${mention.commentId}]\n\n${mention.htmlUrl}`,
      });
    }

    // Acknowledge in-thread: 👀 on the triggering comment (or the issue for
    // issue-born mentions) plus a short mention-free comment naming the task.
    // Ack failures warn and never abort — the task is the product.
    try {
      if (mention.commentId !== undefined) {
        await client.addCommentReaction(githubRepo, mention.commentId);
      } else {
        await client.addIssueReaction(githubRepo, issueNumber);
      }
    } catch (error) {
      logger.warn('Server', `Failed to add ack reaction on ${threadRef}`, error);
    }
    try {
      await client.addPRComment(githubRepo, issueNumber, `On it — created \`${task.taskId}\`. I'll follow up here.`);
    } catch (error) {
      logger.warn('Server', `Failed to post ack comment on ${threadRef}`, error);
    }

    logger.system(`GitHub: created ${task.taskId} from mention on ${threadRef} by ${author}`);
    await task.sendMessage(AGENT_PROMPTS.newTask, 'pm-agent');
  } catch (error) {
    // Fire-and-forget webhook semantics: the summoner sees nothing (no ack was
    // posted), the failure is operator-visible here, re-mentioning is the remedy.
    logger.error('Server', `Failed to create task from GitHub mention on ${threadRef}`, error);
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
  // Resolve the task *id* from the event: the `archie/{id}` branch pattern is a
  // pure regex (no disk); the branch / PR-number lookups are disk greps used
  // only as a fallback for non-archie branches (e.g. PR-number-less
  // workflow_run events). They locate the id — they don't read task state.
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

  // Task.get returns the live in-memory instance for an active task and loads
  // from disk only for an inactive one — so task state is always read from the
  // authoritative source. (The removed `hasCard` pre-check was a separate raw
  // disk read that could be stale against an active task; that was the bug.)
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
  // Re-sync the card from a broad set of received PR events, not just CI
  // completions. Two reasons: (1) a check *appearing* (check_run.created, a
  // commit `status` post like TeamCity's queued build, check_suite.requested)
  // bumps the total so the count tracks 0/2 → 0/3 → 0/4; (2) crucially, some CI
  // results only reach us indirectly — e.g. Danger reports a failure via a
  // commit status + an issue_comment, and depending on the GitHub App's event
  // subscriptions the only signal we reliably receive may be the comment. So
  // any PR-scoped event is a chance to re-fetch checks and refresh. The refresh
  // is always in-place (never moves the card), debounced per branch, and
  // fingerprint-gated, so broadening the triggers is cheap and safe. PR title/
  // description edits are deliberately excluded (the `edited` action isn't here,
  // and the fingerprint ignores title/body) so editing those never touches it.
  const isPrClosed = eventType === 'pull_request' && context.action === 'closed';
  const isCardRelevant =
    isPrClosed ||
    eventType === 'check_run' ||
    eventType === 'check_suite' ||
    eventType === 'workflow_run' ||
    eventType === 'status' ||
    eventType === 'push' ||
    eventType === 'issue_comment' ||
    eventType === 'pull_request_review' ||
    eventType === 'pull_request_review_comment' ||
    (eventType === 'pull_request' &&
      (context.action === 'synchronize' || context.action === 'opened' || context.action === 'reopened'));
  if (!isCardRelevant) return;

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
