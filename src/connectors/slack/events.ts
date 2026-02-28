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
  updateMessage,
  getBotUserId,
  fetchSlackThread,
  getBotId,
} from './client.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { triageSlackMessage } from '../../system/triage.js';

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

    handleSlackEvent({
      type: event.type,
      channel: event.channel,
      user: event.user ?? '',
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
    }).catch((err: unknown) => logger.error('Server', 'Error processing Slack event', err));
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

      handleSlackEvent({
        type: event.type,
        channel: event.channel,
        user: event.user || '',
        text: event.text || '',
        ts: event.ts,
        thread_ts: event.thread_ts,
      }).catch((err: unknown) => logger.error('Server', 'Error processing Slack event', err));
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
// Slack Event Handler
// ============================================================================

async function handleSlackEvent(event: {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  const thread = await fetchSlackThread(event.channel, threadId, event.ts);

  logger.system(`Processing #${thread.channel.name} (thread: ${threadId})`);

  const triageResult = await triageSlackMessage(thread);

  switch (triageResult.action) {
    case 'new_task': {
      const task = await Task.create();
      await task.append(thread);
      await task.sendMessage(AGENT_PROMPTS.newTask);
      break;
    }
    case 'existing_task': {
      if (!triageResult.task_id) break;
      const task = await Task.get(triageResult.task_id);
      const { linkedNewThread } = await task.append(thread);
      if (linkedNewThread) {
        await postToThreads(
          [{ thread_id: thread.threadId, channel_id: thread.channel.id, last_processed_ts: thread.currentMessageTs }],
          'Got it, I\'ve linked this to the ongoing investigation.',
        );
      }
      await task.sendMessage(AGENT_PROMPTS.existingTask);
      break;
    }
    case 'cancel_task': {
      if (!triageResult.task_id) break;
      const task = await Task.get(triageResult.task_id);
      await task.postToUser('Work stopped. All progress has been saved and can be resumed if needed.');
      await task.stop();
      break;
    }
    case 'noop':
      logger.system('Triage: noop');
      break;
  }
}
