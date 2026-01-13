/**
 * Triage Worker
 *
 * Processes events from the triage queue:
 * - Classifies messages using LLM (triageSlackMessage, triageGitHubComment)
 * - Appends messages to shared-knowledge.log (durable storage)
 * - Routes based on local state:
 *   - activeTasks.has() → notifyNewInput()
 *   - pendingSpawns.has() → skip (spawn already queued)
 *   - else → queue spawn job
 *
 * Completes quickly (~2 seconds per job) to keep the queue moving.
 */

import { Worker, type ReservedJob } from 'groupmq';
import { getTriageQueue, getSpawnQueue, type TriageJobData } from '../system/queues.js';
import { triageSlackMessage, triageGitHubComment, type GitHubComment } from '../agents/triage.js';
import {
  createTask,
  appendSlackMessage,
  appendGitHubEvent,
  addThreadToTask,
  loadMetadata,
  updateThreadTimestamp,
  updatePRCommentTimestamp,
} from '../system/task-manager.js';
import { notifyNewInput, stopTask } from '../system/task-runtime.js';
import { isTaskActive } from '../system/active-tasks.js';
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
import { logger } from '../system/logger.js';
import type { SlackThread, SlackMessage } from '../types/index.js';

// ============================================================================
// Local State (per pod, in-memory)
// ============================================================================

/**
 * Set of task IDs with pending spawn jobs (queued but not yet started)
 */
export const pendingSpawns = new Set<string>();

/**
 * Map of task IDs to PM status (running on this pod)
 * Note: The actual PM handle is managed by task-runtime.ts via activeTasks
 */
export const localActiveTasks = new Set<string>();

// Configuration
let backendRepoPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
let mobileRepoPath = process.env.MOBILE_REPO_PATH || '/repos/mobile';

/**
 * Set repository paths (called from server startup)
 */
export function setRepoPaths(backend: string, mobile: string): void {
  backendRepoPath = backend;
  mobileRepoPath = mobile;
}

// ============================================================================
// Worker Instance
// ============================================================================

let triageWorker: Worker<TriageJobData> | null = null;

/**
 * Start the triage worker
 */
export function startTriageWorker(): Worker<TriageJobData> {
  if (triageWorker) {
    return triageWorker;
  }

  const queue = getTriageQueue();

  triageWorker = new Worker<TriageJobData>({
    queue,
    name: 'triage-worker',
    concurrency: 5, // Process up to 5 jobs in parallel
    handler: processTriageJob,
    onError: (err, job) => {
      logger.error('triage-worker', `Error processing job ${job?.id}`, err);
    },
    // Fast processing - 60 second timeout
    heartbeatMs: 15000,
    maxAttempts: 3,
    // Enable cleanup and scheduler
    enableCleanup: true,
    cleanupIntervalMs: 300000, // 5 minutes
    schedulerIntervalMs: 5000,
  });

  triageWorker.on('completed', (job) => {
    logger.triageQueue(`Job ${job.id} completed`);
  });

  triageWorker.on('failed', (job) => {
    logger.error('triage-worker', `Triage job ${job.id} failed: ${job.failedReason}`);
  });

  triageWorker.run().catch((err) => {
    logger.error('triage-worker', 'Worker failed to start', err);
  });

  logger.system('Triage worker started');
  return triageWorker;
}

/**
 * Stop the triage worker
 */
export async function stopTriageWorker(): Promise<void> {
  if (triageWorker) {
    await triageWorker.close(30000); // 30 second graceful timeout
    triageWorker = null;
    logger.system('Triage worker stopped');
  }
}

// ============================================================================
// Job Handler
// ============================================================================

/**
 * Process a triage job
 */
async function processTriageJob(job: ReservedJob<TriageJobData>): Promise<void> {
  const { source, payload } = job.data;

  if (source === 'slack') {
    // Log the trigger content with resolved mentions
    const event = payload as { user?: string; text?: string; thread_ts?: string; ts?: string; channel?: string };
    const threadId = event.thread_ts || event.ts || 'unknown';
    const channelInfo = event.channel ? await getChannelInfo(event.channel) : { name: 'unknown' };
    const cleanText = event.text ? await cleanSlackText(event.text, event.channel) : '';
    logger.triageQueue(`Processing #${channelInfo.name} (thread: ${threadId}): "${cleanText}"`);

    await processSlackTriage(payload);
  } else if (source === 'github') {
    const taskId = job.data.taskId;
    if (!taskId) {
      logger.warn('triage-worker', 'GitHub triage job missing taskId');
      return;
    }

    // Log the trigger content
    const comment = payload.comment as Record<string, unknown> | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;
    const prNumber = issue?.number || 'unknown';
    const user = (comment?.user as Record<string, unknown>)?.login as string || 'unknown';
    const body = (comment?.body as string) || '';
    logger.triageQueue(`Processing GitHub PR #${prNumber} comment by ${user}: "${body}"`);

    await processGitHubTriage(taskId, payload);
  }
}

// ============================================================================
// Slack Triage
// ============================================================================

/**
 * Process Slack triage job
 */
async function processSlackTriage(payload: Record<string, unknown>): Promise<void> {
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

  // Create the Slack thread info
  const slackThread: SlackThread = {
    thread_id: threadId,
    channel_id: message.channel,
    last_processed_ts: message.ts,
  };

  // Create the task
  const metadata = await createTask(slackThread, backendRepoPath, mobileRepoPath);
  const taskId = metadata.task_id;

  logger.system(`Created task ${taskId}`);

  // Append all thread history to shared knowledge log
  for (const msg of threadHistory) {
    const msgUserInfo = await getUserInfo(msg.user);
    await appendSlackMessage(taskId, channelInfo, threadId, {
      id: msg.user,
      username: msgUserInfo.name,
      realName: msgUserInfo.realName,
    }, msg.text);
  }

  // Queue spawn job for new task
  await queueSpawnJob(taskId, 'new_task');
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
    logger.error('triage-worker', `Task ${taskId} not found`);
    return;
  }

  // Check if this thread is already tracked
  const existingThread = metadata.slack_threads.find((t) => t.thread_id === threadId);

  if (!existingThread) {
    // New thread joining the task - append all history from this thread
    const newThread: SlackThread = {
      thread_id: threadId,
      channel_id: message.channel,
      last_processed_ts: message.ts,
    };

    await addThreadToTask(taskId, newThread);

    // Append thread history, filtering out bot messages
    for (const msg of threadHistory) {
      if (!msg.user || msg.user === 'unknown' || msg.user === getBotUserId()) continue;
      const userInfo = await getUserInfo(msg.user);
      await appendSlackMessage(taskId, channelInfo, threadId, {
        id: msg.user,
        username: userInfo.name,
        realName: userInfo.realName,
      }, msg.text);
    }

    // Acknowledge the link
    await postToThreads([newThread], "Got it, I've linked this to the ongoing investigation.");
  } else {
    // Same thread, append only new messages
    const lastProcessedTs = existingThread.last_processed_ts;

    for (const msg of threadHistory) {
      if (!msg.ts || msg.ts <= lastProcessedTs) continue;
      if (!msg.user || msg.user === 'unknown' || msg.user === getBotUserId()) continue;
      const userInfo = await getUserInfo(msg.user);
      await appendSlackMessage(taskId, channelInfo, threadId, {
        id: msg.user,
        username: userInfo.name,
        realName: userInfo.realName,
      }, msg.text);
    }

    await updateThreadTimestamp(taskId, threadId, message.ts);
  }

  // Route based on local state
  await routeToSpawnOrNotify(taskId);
}

/**
 * Handle task cancellation
 */
async function handleCancelTask(taskId: string, message: SlackMessage): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('triage-worker', `Task ${taskId} not found`);
    return;
  }

  // Check if task is active locally
  if (localActiveTasks.has(taskId)) {
    await stopTask(taskId);
    localActiveTasks.delete(taskId);
  }

  // Post cancellation message
  await postToThreads(
    metadata.slack_threads,
    "Work stopped. All progress has been saved and can be resumed if needed."
  );
}

// ============================================================================
// GitHub Triage
// ============================================================================

/**
 * Process GitHub triage job (issue_comment)
 */
async function processGitHubTriage(taskId: string, payload: Record<string, unknown>): Promise<void> {
  const issue = payload.issue as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;

  if (!issue?.pull_request || !comment || !repository) {
    logger.warn('triage-worker', 'GitHub payload missing required fields');
    return;
  }

  const prNumber = issue.number as number;
  const commentId = comment.id as number;
  const githubRepo = repository.full_name as string;

  // Get GitHub client
  const githubClient = createGitHubClient();
  if (!githubClient) {
    logger.warn('triage-worker', 'GitHub client not configured');
    // Fall back to direct handling
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Find repo config
  const repoConfig = getRepoConfigByGithubRepo(githubRepo);
  if (!repoConfig) {
    logger.warn('triage-worker', `Unknown repo ${githubRepo}`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Fetch PR comment history
  let commentHistory: GitHubComment[];
  try {
    commentHistory = await githubClient.getPRComments(githubRepo, prNumber);
  } catch (error) {
    logger.error('triage-worker', 'Failed to fetch PR comments', error);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Find current comment in history
  const currentComment = commentHistory.find((c) => c.id === commentId);
  if (!currentComment) {
    logger.warn('triage-worker', `Comment ${commentId} not found in PR #${prNumber} history`);
    await handleGitHubCommentDirect(taskId, githubRepo, prNumber, comment);
    return;
  }

  // Run triage
  const triageResult = await triageGitHubComment(currentComment, commentHistory, prNumber, githubRepo);

  // Get metadata for last processed comment
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('triage-worker', `Task ${taskId} not found`);
    return;
  }

  const repoInfo = metadata.repositories[repoConfig.repoKey];
  const lastProcessedId = repoInfo?.last_processed_comment_id || 0;

  if (triageResult.action === 'existing_task') {
    // Log all new comments since last processed
    const newComments = commentHistory.filter((c) => c.id > lastProcessedId);

    for (const c of newComments) {
      const message = `PR #${prNumber}: ${c.user} commented: ${c.body}`;
      await appendGitHubEvent(taskId, repoConfig.repoKey, message);
    }

    // Update last processed
    await updatePRCommentTimestamp(taskId, repoConfig.repoKey, commentId);

    // Route based on local state
    await routeToSpawnOrNotify(taskId);
  } else {
    // noop - don't update last processed, don't notify
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
  await routeToSpawnOrNotify(taskId);
}

// ============================================================================
// Spawn Queue Integration
// ============================================================================

/**
 * Queue a spawn job for a task
 */
async function queueSpawnJob(taskId: string, reason: 'new_task' | 'existing_task'): Promise<void> {
  pendingSpawns.add(taskId);

  const spawnQueue = getSpawnQueue();
  await spawnQueue.add({
    groupId: taskId,
    data: { taskId, reason },
  });

  logger.spawnQueue(`Queued task ${taskId} (reason: ${reason})`);
}

/**
 * Route to spawn or notify based on local state
 */
export async function routeToSpawnOrNotify(taskId: string): Promise<void> {
  if (isTaskActive(taskId)) {
    // PM running locally - notify it
    await notifyNewInput(taskId);
  } else if (localActiveTasks.has(taskId) || pendingSpawns.has(taskId)) {
    // Spawn job running or queued - PM will read log when ready
    logger.spawnQueue(`Task ${taskId} has pending/active spawn, skipping notification`);
  } else {
    // No local PM, no pending spawn - queue one (continuation)
    await queueSpawnJob(taskId, 'existing_task');
  }
}
