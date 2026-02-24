/**
 * Slack Events — Bolt app, event handlers, button handlers
 *
 * Owns: Slack Bolt app, app_mention/message handlers, button actions,
 * Slack triage processing. Does NOT own the HTTP server or GitHub endpoints.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { App, ExpressReceiver } = require('@slack/bolt');

import type { Application } from 'express';
import type { App as AppType } from '@slack/bolt';

import {
  initSlackClient,
  postToThreads,
  postInteractiveToThreads,
  updateMessage,
  getBotUserId,
  fetchThreadHistory,
  getUserInfo,
  getChannelInfo,
  cleanSlackText,
  getBotId,
} from './client.js';
import { setSlackCallbacks } from './callbacks.js';
import { Task } from '../../tasks/task.js';
import {
  appendSlackMessage,
  downloadMessageFiles,
} from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { triageSlackMessage } from '../../system/triage.js';
import type { SlackThread, SlackMessage } from '../../types/index.js';

/**
 * Slack configuration
 */
export interface SlackConfig {
  slackBotToken: string;
  slackSigningSecret: string;
}

let app: AppType | null = null;

/**
 * Mount Slack Bolt app on an existing Express app
 *
 * Creates an ExpressReceiver internally using the provided Express app,
 * registers Bolt event/action handlers, and initializes the Slack client.
 */
export async function mountSlackApp(
  expressApp: Application,
  config: SlackConfig
): Promise<void> {
  const receiver = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    endpoints: '/webhooks/slack',
    app: expressApp,
  });

  logger.plain('Slack webhook: POST /webhooks/slack');

  // Initialize Slack client for outgoing messages
  await initSlackClient(config.slackBotToken);

  // Set up Slack callbacks once globally (works for all tasks since it uses taskId parameter)
  setSlackCallbacks(
    async (taskId: string, slackMessage: string) => {
      const task = await Task.get(taskId);
      await postToThreads(task.metadata.slack_threads, slackMessage);
    },
    async (taskId: string, text: string, blocks: unknown[]) => {
      const task = await Task.get(taskId);
      await postInteractiveToThreads(task.metadata.slack_threads, text, blocks);
    }
  );

  // Create Bolt app with the shared receiver
  app = new App({
    token: config.slackBotToken,
    receiver,
  });

  // Handle app mentions - process inline
  app!.event('app_mention', async ({ event }) => {
    if (getIsShuttingDown()) {
      logger.system('Ignoring Slack event during shutdown');
      return;
    }

    const route = routeSlackEvent(event);
    if (route.action === 'discard') {
      return;
    }

    processSlackTriage({
      type: event.type,
      channel: event.channel,
      user: event.user ?? '',
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
    }).catch((err) => logger.error('Server', 'Error processing Slack event', err));
  });

  // Handle thread messages (replies without @mention)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.event('message', async ({ event }: { event: any }) => {
    if (
      event.type === 'message' &&
      !event.subtype &&
      event.thread_ts &&
      event.thread_ts !== event.ts
    ) {
      const botUserId = getBotUserId();
      if (botUserId && event.text?.includes(`<@${botUserId}>`)) {
        return;
      }

      if (getIsShuttingDown()) {
        logger.system('Ignoring Slack event during shutdown');
        return;
      }

      const route = routeSlackEvent(event);
      if (route.action === 'discard') {
        return;
      }

      processSlackTriage({
        type: event.type,
        channel: event.channel,
        user: event.user || '',
        text: event.text || '',
        ts: event.ts,
        thread_ts: event.thread_ts,
      }).catch((err) => logger.error('Server', 'Error processing Slack event', err));
    }
  });

  // Handle edit mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Edit mode approved by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Edit mode approved* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleEditModeApproval();
    } catch (error) {
      logger.error('Server', 'Error handling edit mode approval', error);
    }
  });

  // Handle edit mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Edit mode denied by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Edit mode denied* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleEditModeDenial();
    } catch (error) {
      logger.error('Server', 'Error handling edit mode denial', error);
    }
  });

  // Handle research budget approval button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_research_budget', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Research budget approved by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Research budget extended* by <@${userId}> (+5 requests)`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleResearchBudgetApproval();
    } catch (error) {
      logger.error('Server', 'Error handling research budget approval', error);
    }
  });

  // Handle research budget denial button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_research_budget', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Research budget denied by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Additional research denied* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleResearchBudgetDenial();
    } catch (error) {
      logger.error('Server', 'Error handling research budget denial', error);
    }
  });
}


// ============================================================================
// Slack Routing
// ============================================================================

type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };

function routeSlackEvent(event: {
  bot_id?: string;
  type: string;
}): SlackRouteResult {
  const ourBotId = getBotId();
  if (event.bot_id && ourBotId && event.bot_id === ourBotId) {
    return { action: 'discard', reason: 'Own bot message' };
  }

  return { action: 'triage' };
}

// ============================================================================
// Slack Triage
// ============================================================================

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

  const channelInfo = await getChannelInfo(event.channel);
  const cleanText = await cleanSlackText(event.text, event.channel);

  logger.system(`Processing #${channelInfo.name} (thread: ${threadId}): "${cleanText}"`);

  const threadHistory = await fetchThreadHistory(event.channel, threadId);

  const message: SlackMessage = {
    type: event.type,
    channel: event.channel,
    user: event.user,
    text: cleanText,
    ts: event.ts,
    thread_ts: event.thread_ts,
  };

  const triageResult = await triageSlackMessage(message, threadHistory);

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
        await handleCancelTask(triageResult.task_id);
      }
      break;

    case 'noop':
      logger.system('Triage: No action needed (acknowledgment)');
      break;
  }
}

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

  const task = await Task.createFromSlackThread(slackThread);

  for (const msg of threadHistory) {
    const msgUserInfo = await getUserInfo(msg.user);
    const downloadedFiles = msg.files ? await downloadMessageFiles(task.taskId, msg.files) : undefined;
    await appendSlackMessage(task.taskId, channelInfo, threadId, {
      id: msg.user,
      username: msgUserInfo.name,
      realName: msgUserInfo.realName,
    }, msg.text, downloadedFiles);
  }

  await task.sendMessage(AGENT_PROMPTS.newTask, 'pm-agent');
}

async function handleExistingTask(
  taskId: string,
  message: SlackMessage,
  threadId: string,
  threadHistory: SlackMessage[],
  channelInfo: { id: string; name: string }
): Promise<void> {
  const task = await Task.get(taskId);

  const existingThread = task.metadata.slack_threads.find((t: SlackThread) => t.thread_id === threadId);

  if (!existingThread) {
    const newThread: SlackThread = {
      thread_id: threadId,
      channel_id: message.channel,
      last_processed_ts: message.ts,
    };
    task.metadata.slack_threads.push(newThread);

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

    await postToThreads([newThread], 'Got it, I\'ve linked this to the ongoing investigation.');
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

    existingThread.last_processed_ts = message.ts;
  }

  task.debouncedSave();
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

async function handleCancelTask(taskId: string): Promise<void> {
  const task = await Task.get(taskId);
  const threads = [...task.metadata.slack_threads];

  await task.stop();

  await postToThreads(
    threads,
    'Work stopped. All progress has been saved and can be resumed if needed.'
  );
}
