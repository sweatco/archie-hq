/**
 * Event Handler
 *
 * Processes webhook events inline (no queues).
 * Consolidates business logic from the former triage-worker and spawn-worker.
 *
 * Flow: webhook → processSlackTriage / processGitHubTriage → spawnTaskIfNeeded
 */

import { triageSlackMessage, triageGitHubComment, type GitHubComment } from '../agents/triage.js';
import {
  createTask,
  appendSlackMessage,
  appendGitHubEvent,
  addThreadToTask,
  loadMetadata,
  updateThreadTimestamp,
  updatePRCommentTimestamp,
  downloadMessageFiles,
} from './task-manager.js';
import { notifyNewInput, stopTask, initializeTaskRuntime, startTask } from './task-runtime.js';
import { isTaskActive } from './active-tasks.js';
import {
  fetchThreadHistory,
  getUserInfo,
  getChannelInfo,
  getBotUserId,
  cleanSlackText,
  postToThreads,
} from '../slack/client.js';
import { createGitHubClient } from '../github/client.js';
import { getRepoConfigByGithubRepo } from '../agents/repo-configs.js';
import { logger } from './logger.js';
import type { SlackThread, SlackMessage } from '../types/index.js';

// ============================================================================
// Spawn Guard
// ============================================================================

/**
 * Guard against concurrent spawn race.
 * Between the synchronous isTaskActive() check and the async initializeTaskRuntime(),
 * two concurrent webhook calls could both pass the check. This Set prevents that.
 */
const spawningTasks = new Set<string>();

/**
 * Spawn a task if not already active or spawning
 */
async function spawnTaskIfNeeded(taskId: string, reason: 'new_task' | 'existing_task'): Promise<void> {
  if (isTaskActive(taskId)) {
    await notifyNewInput(taskId);
    return;
  }
  if (spawningTasks.has(taskId)) return;
  spawningTasks.add(taskId);
  try {
    await initializeTaskRuntime(taskId);
    await startTask(taskId, reason);
  } finally {
    spawningTasks.delete(taskId);
  }
}

// ============================================================================
// Slack Triage
// ============================================================================

/**
 * Process a Slack event inline (replaces triage queue for Slack)
 */
export async function processSlackTriage(payload: Record<string, unknown>): Promise<void> {
  const event = payload as {
    type: string;
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
  };

  const threadId = event.thread_ts || event.ts;

  // Fetch context
  const channelInfo = await getChannelInfo(event.channel);
  const cleanText = await cleanSlackText(event.text, event.channel);

  // Log the trigger
  logger.system(`Processing #${channelInfo.name} (thread: ${threadId}): "${cleanText}"`);

  // Fetch thread history
  const threadHistory = await fetchThreadHistory(event.channel, threadId);

  // Convert to SlackMessage format
  const message: SlackMessage = {
    type: event.type,
    channel: event.channel,
    user: event.user,
    text: cleanText,
    ts: event.ts,
    thread_ts: event.thread_ts,
  };

  // Run triage
  const triageResult = await triageSlackMessage(message, threadHistory);

  // Route based on triage result
  switch (triageResult.action) {
    case 'new_task':
      await handleNewTask(message, threadHistory, channelInfo);
      break;

    case 'existing_task':
      if (triageResult.task_id) {
        await handleExistingTask(triageResult.task_id, message, threadId, threadHistory, channelInfo);
      }
      break;

    case 'cancel_task':
      if (triageResult.task_id) {
        await handleCancelTask(triageResult.task_id, message);
      }
      break;

    case 'noop':
      logger.system('Triage: No action needed (acknowledgment)');
      break;
  }
}

/**
 * Handle new task creation
 */
async function handleNewTask(
  message: SlackMessage,
  threadHistory: SlackMessage[],
  channelInfo: { id: string; name: string }
): Promise<void> {
  const threadId = message.thread_ts || message.ts;

  const slackThread: SlackThread = {
    thread_id: threadId,
    channel_id: message.channel,
    last_processed_ts: message.ts,
  };

  const metadata = await createTask(slackThread);
  const taskId = metadata.task_id;

  logger.system(`Created task ${taskId}`);

  // Append all thread history to shared knowledge log
  for (const msg of threadHistory) {
    const msgUserInfo = await getUserInfo(msg.user);
    const downloadedFiles = msg.files ? await downloadMessageFiles(taskId, msg.files) : undefined;
    await appendSlackMessage(taskId, channelInfo, threadId, {
      id: msg.user,
      username: msgUserInfo.name,
      realName: msgUserInfo.realName,
    }, msg.text, downloadedFiles);
  }

  // Spawn PM directly
  await spawnTaskIfNeeded(taskId, 'new_task');
}

/**
 * Handle existing task message
 */
async function handleExistingTask(
  taskId: string,
  message: SlackMessage,
  threadId: string,
  threadHistory: SlackMessage[],
  channelInfo: { id: string; name: string }
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('event-handler', `Task ${taskId} not found`);
    return;
  }

  const existingThread = metadata.slack_threads.find((t) => t.thread_id === threadId);

  if (!existingThread) {
    const newThread: SlackThread = {
      thread_id: threadId,
      channel_id: message.channel,
      last_processed_ts: message.ts,
    };

    await addThreadToTask(taskId, newThread);

    for (const msg of threadHistory) {
      if (!msg.user || msg.user === 'unknown' || msg.user === getBotUserId()) continue;
      const userInfo = await getUserInfo(msg.user);
      const downloadedFiles = msg.files ? await downloadMessageFiles(taskId, msg.files) : undefined;
      await appendSlackMessage(taskId, channelInfo, threadId, {
        id: msg.user,
        username: userInfo.name,
        realName: userInfo.realName,
      }, msg.text, downloadedFiles);
    }

    await postToThreads([newThread], "Got it, I've linked this to the ongoing investigation.");
  } else {
    const lastProcessedTs = existingThread.last_processed_ts;

    for (const msg of threadHistory) {
      if (!msg.ts || msg.ts <= lastProcessedTs) continue;
      if (!msg.user || msg.user === 'unknown' || msg.user === getBotUserId()) continue;
      const userInfo = await getUserInfo(msg.user);
      const downloadedFiles = msg.files ? await downloadMessageFiles(taskId, msg.files) : undefined;
      await appendSlackMessage(taskId, channelInfo, threadId, {
        id: msg.user,
        username: userInfo.name,
        realName: userInfo.realName,
      }, msg.text, downloadedFiles);
    }

    await updateThreadTimestamp(taskId, threadId, message.ts);
  }

  // Route: spawn or notify
  await spawnTaskIfNeeded(taskId, 'existing_task');
}

/**
 * Handle task cancellation
 */
async function handleCancelTask(taskId: string, _message: SlackMessage): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('event-handler', `Task ${taskId} not found`);
    return;
  }

  if (isTaskActive(taskId)) {
    await stopTask(taskId);
  }

  await postToThreads(
    metadata.slack_threads,
    "Work stopped. All progress has been saved and can be resumed if needed."
  );
}

// ============================================================================
// GitHub Triage
// ============================================================================

/**
 * Process GitHub triage inline (replaces triage queue for GitHub issue_comment)
 */
export async function processGitHubTriage(taskId: string, payload: Record<string, unknown>): Promise<void> {
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

  // Log the trigger
  const user = (comment.user as Record<string, unknown>)?.login as string || 'unknown';
  const body = comment.body as string || '';
  logger.system(`Processing GitHub PR #${prNumber} comment by ${user}: "${body}"`);

  // Get GitHub client
  const githubClient = createGitHubClient();
  if (!githubClient) {
    logger.warn('event-handler', 'GitHub client not configured');
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Find repo config
  const repoConfig = getRepoConfigByGithubRepo(githubRepo);
  if (!repoConfig) {
    logger.warn('event-handler', `Unknown repo ${githubRepo}`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Fetch PR comment history
  let commentHistory: GitHubComment[];
  try {
    commentHistory = await githubClient.getPRComments(githubRepo, prNumber);
  } catch (error) {
    logger.error('event-handler', 'Failed to fetch PR comments', error);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Find current comment in history
  const currentComment = commentHistory.find((c) => c.id === commentId);
  if (!currentComment) {
    logger.warn('event-handler', `Comment ${commentId} not found in PR #${prNumber} history`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Run triage
  const triageResult = await triageGitHubComment(currentComment, commentHistory, prNumber, githubRepo);

  // Get metadata for last processed comment
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('event-handler', `Task ${taskId} not found`);
    return;
  }

  const repoInfo = metadata.repositories[repoConfig.repoKey];
  const lastProcessedId = repoInfo?.last_processed_comment_id || 0;

  if (triageResult.action === 'existing_task') {
    const newComments = commentHistory.filter((c) => c.id > lastProcessedId);

    for (const c of newComments) {
      const message = `PR #${prNumber}: ${c.user} commented: ${c.body}`;
      await appendGitHubEvent(taskId, repoConfig.repoKey, message);
    }

    await updatePRCommentTimestamp(taskId, repoConfig.repoKey, commentId);

    // Route: spawn or notify
    await spawnTaskIfNeeded(taskId, 'existing_task');
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
  const repoConfig = getRepoConfigByGithubRepo(githubRepo);
  const repoKey = repoConfig?.repoKey || 'unknown';

  const user = (comment.user as Record<string, unknown>)?.login as string || 'unknown';
  const body = comment.body as string || '';

  await appendGitHubEvent(taskId, repoKey, `PR #${prNumber}: ${user} commented: ${body}`);
  await spawnTaskIfNeeded(taskId, 'existing_task');
}

/**
 * Reactivate a stopped/inactive task.
 * Used by merge-orchestrator, edit mode handlers, and other callsites
 * that need to wake up a PM for an existing task.
 */
export async function reactivateTask(taskId: string): Promise<void> {
  await spawnTaskIfNeeded(taskId, 'existing_task');
}
