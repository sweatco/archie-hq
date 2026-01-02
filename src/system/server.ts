/**
 * Main Server
 *
 * Entry point for the AI Engineer system.
 * Uses Slack Bolt in HTTP mode for webhook events.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { App, ExpressReceiver } = require('@slack/bolt');

// Import types separately for type safety
import type { App as AppType } from '@slack/bolt';
import type { ExpressReceiver as ExpressReceiverType } from '@slack/bolt';

import { initSlackClient, postToThreads, postInteractiveToThreads, updateMessage } from '../slack/client.js';
import { handleSlackMessage, setRepoPaths } from '../slack/events.js';
import { setSlackCallbacks, handleEditModeApproval, handleEditModeDenial } from './task-runtime.js';
import { loadMetadata } from './task-manager.js';

/**
 * Server configuration
 */
export interface ServerConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  port: number;
  backendRepoPath: string;
  mobileRepoPath: string;
}

let app: AppType | null = null;

/**
 * Create and start the server
 */
export async function startServer(config: ServerConfig): Promise<void> {
  // Initialize Slack client for outgoing messages
  await initSlackClient(config.slackBotToken);

  // Set repository paths
  setRepoPaths(config.backendRepoPath, config.mobileRepoPath);

  // Set up Slack callbacks once globally (works for all tasks since it uses taskId parameter)
  setSlackCallbacks(
    // Regular message callback
    async (taskId: string, slackMessage: string) => {
      const taskMetadata = await loadMetadata(taskId);
      if (taskMetadata) {
        await postToThreads(taskMetadata.slack_threads, slackMessage);
      }
    },
    // Interactive message callback (for buttons)
    async (taskId: string, text: string, blocks: unknown[]) => {
      const taskMetadata = await loadMetadata(taskId);
      if (taskMetadata) {
        await postInteractiveToThreads(taskMetadata.slack_threads, text, blocks);
      }
    }
  );

  // Create Express receiver for HTTP mode
  const receiver: ExpressReceiverType = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
  });

  // Add health check endpoint
  receiver.router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Create Bolt app with HTTP receiver
  app = new App({
    token: config.slackBotToken,
    receiver,
  });

  // Handle app mentions
  app!.event('app_mention', async ({ event }) => {
    // Ignore bot messages
    if ('bot_id' in event && event.bot_id) {
      return;
    }

    try {
      await handleSlackMessage({
        type: event.type,
        channel: event.channel,
        user: event.user ?? '',
        text: event.text,
        ts: event.ts,
        thread_ts: event.thread_ts,
      });
    } catch (error) {
      console.error('[Server] Error handling message:', error);
    }
  });

  // Handle thread messages (replies without @mention)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.event('message', async ({ event }: { event: any }) => {
    // Only handle thread replies
    if (
      event.type === 'message' &&
      !event.subtype &&
      event.thread_ts &&
      event.thread_ts !== event.ts
    ) {
      // Ignore bot messages
      if (event.bot_id) {
        return;
      }

      try {
        await handleSlackMessage({
          type: event.type,
          channel: event.channel,
          user: event.user || '',
          text: event.text || '',
          ts: event.ts,
          thread_ts: event.thread_ts,
        });
      } catch (error) {
        console.error('[Server] Error handling message:', error);
      }
    }
  });

  // Handle edit mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    console.log(`[Server] Edit mode approved by ${userId} for task ${taskId}`);

    try {
      // Update the original message to show approval
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Edit mode approved* by <@${userId}>`,
          [] // Remove buttons
        );
      }

      // Handle the approval
      await handleEditModeApproval(taskId);
    } catch (error) {
      console.error('[Server] Error handling edit mode approval:', error);
    }
  });

  // Handle edit mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    console.log(`[Server] Edit mode denied by ${userId} for task ${taskId}`);

    try {
      // Update the original message to show denial
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Edit mode denied* by <@${userId}>`,
          [] // Remove buttons
        );
      }

      // Handle the denial
      await handleEditModeDenial(taskId);
    } catch (error) {
      console.error('[Server] Error handling edit mode denial:', error);
    }
  });

  // Start the app
  await app!.start(config.port);

  console.log(`AI Engineer server is running on port ${config.port}`);
  console.log(`Webhook endpoint: POST /slack/events`);
  console.log(`Health check: GET /health`);
}

/**
 * Graceful shutdown
 */
export async function stopServer(): Promise<void> {
  console.log('Shutting down AI Engineer server...');

  if (app) {
    await app.stop();
    console.log('Server closed');
  }
}
