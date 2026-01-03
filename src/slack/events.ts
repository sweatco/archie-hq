/**
 * Slack Event Handlers
 *
 * Handles incoming Slack events (mentions, messages in threads).
 */

import type { SlackMessage, SlackThread } from '../types/index.js';
import { triageMessage } from '../agents/index.js';
import {
  createTask,
  appendSlackMessage,
  addThreadToTask,
  loadMetadata,
  updateThreadTimestamp,
} from '../system/task-manager.js';
import {
  initializeTaskRuntime,
  startTask,
  notifyNewUserInput,
  handleStatusRequest,
  stopTask,
  isTaskActive,
  reactivateTask,
} from '../system/task-runtime.js';
import {
  fetchThreadHistory,
  postToThreads,
  getUserInfo, getBotUserId, getChannelInfo,
  extractMentionText,
  cleanSlackText,
} from './client.js';
import { logger } from '../system/logger.js';

// Configuration
let backendRepoPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
let mobileRepoPath = process.env.MOBILE_REPO_PATH || '/repos/mobile';

/**
 * Set repository paths
 */
export function setRepoPaths(backend: string, mobile: string): void {
  backendRepoPath = backend;
  mobileRepoPath = mobile;
}

/**
 * Unified message handler for both @mentions and thread replies
 * Always uses thread_ts as the canonical thread identifier
 */
export async function handleSlackMessage(event: {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}): Promise<void> {
  // Ignore bot messages
  if (event.bot_id) {
    return;
  }

  // Always use thread_ts as the canonical thread ID
  // If this is the first message, ts becomes the thread_ts
  const threadId = event.thread_ts || event.ts;

  // Get channel and user info for friendly logging
  const channelInfo = await getChannelInfo(event.channel);
  const userInfo = await getUserInfo(event.user);
  const cleanText = await cleanSlackText(event.text, event.channel);

  logger.slack(`#<${channelInfo.id}:${channelInfo.name}> @<${event.user}:${userInfo.realName}>: ${cleanText}`);

  // Fetch thread history (this also cleans up mentions)
  const threadHistory = await fetchThreadHistory(event.channel, threadId);

  // Convert to our SlackMessage format
  const message: SlackMessage = {
    type: event.type,
    channel: event.channel,
    user: event.user,
    text: cleanText,
    ts: event.ts,
    thread_ts: event.thread_ts,
  };

  // Always run triage to understand user intent
  const triageResult = await triageMessage(message, threadHistory);

  // Route based on intent
  switch (triageResult.action) {
    case 'new_task':
      await handleNewTask(message, threadHistory, channelInfo);
      break;

    case 'existing_task':
      if (triageResult.task_id) {
        await handleExistingTask(triageResult.task_id, message, threadId, threadHistory, channelInfo);
      }
      break;

    case 'status_request':
      if (triageResult.task_id) {
        await handleStatusRequest(triageResult.task_id);
      }
      break;

    case 'cancel_task':
      if (triageResult.task_id) {
        await handleCancelTask(triageResult.task_id, message);
      }
      break;

    case 'noop':
      logger.system('No action needed (acknowledgment)');
      break;
  }
}


/**
 * Handle creation of a new task
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

  logger.system(`Created task ${metadata.task_id}`);

  // Append all thread history to shared knowledge log
  for (const msg of threadHistory) {
    const userInfo = await getUserInfo(msg.user);
    await appendSlackMessage(metadata.task_id, channelInfo, threadId, {
      id: msg.user,
      username: userInfo.name,
      realName: userInfo.realName,
    }, msg.text);
  }

  // Initialize runtime
  await initializeTaskRuntime(metadata.task_id);

  // Start the task (spawns PM agent)
  // Note: Slack callbacks are set globally at server startup
  await startTask(metadata.task_id);
}

/**
 * Handle a message for an existing task
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
    logger.error('slack/events', `Task ${taskId} not found`);
    return;
  }

  // Check if task needs reactivation (was completed/stopped)
  if (!isTaskActive(taskId)) {
    // Reactivate the task (reinitialize runtime + restart PM)
    // Note: Slack callbacks are set globally at server startup
    await reactivateTask(taskId);
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

    // Use already-fetched thread history, filter out bot messages
    for (const msg of threadHistory) {
      // Skip bot messages to avoid duplicating our own responses
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
    // Same thread, append only new messages (after last_processed_ts)
    const lastProcessedTs = existingThread.last_processed_ts;

    for (const msg of threadHistory) {
      // Skip messages we've already processed and bot messages
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

  // Notify PM of new input
  await notifyNewUserInput(taskId);
}

/**
 * Handle task cancellation
 */
async function handleCancelTask(taskId: string, message: SlackMessage): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('slack/events', `Task ${taskId} not found`);
    return;
  }

  // Check if task is active before stopping
  if (!isTaskActive(taskId)) {
    logger.system(`Task ${taskId} is not active, nothing to cancel`);
    await postToThreads(metadata.slack_threads, "This task is already completed.");
    return;
  }

  // Stop the task
  await stopTask(taskId);

  // Post cancellation message
  await postToThreads(
    metadata.slack_threads,
    "Work stopped. All progress has been saved and can be resumed if needed."
  );
}

