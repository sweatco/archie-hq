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
import { handleGitHubWebhook, verifyWebhookSignature } from '../github/events.js';
import { setSlackCallbacks, handleEditModeApproval, handleEditModeDenial } from './task-runtime.js';
import { loadMetadata } from './task-manager.js';
import { logger } from './logger.js';
import type { Request, Response } from 'express';

/**
 * Server configuration
 */
export interface ServerConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  port: number;
  backendRepoPath: string;
  mobileRepoPath: string;
  githubWebhookSecret?: string; // Optional - GitHub webhooks disabled if not set
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
  receiver.router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Add GitHub webhook endpoint (if configured)
  if (config.githubWebhookSecret) {
    // Parse raw body for signature verification
    receiver.router.post(
      '/github/webhooks',
      require('express').raw({ type: 'application/json' }),
      async (req: Request, res: Response) => {
        const signature = req.headers['x-hub-signature-256'] as string;
        const eventType = req.headers['x-github-event'] as string;

        if (!signature || !eventType) {
          res.status(400).json({ error: 'Missing required headers' });
          return;
        }

        // Verify webhook signature
        const payload = req.body.toString();
        if (!verifyWebhookSignature(payload, signature, config.githubWebhookSecret!)) {
          logger.warn('Server', 'Invalid GitHub webhook signature');
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }

        // Acknowledge receipt immediately
        res.status(200).json({ received: true });

        // Process the webhook asynchronously
        try {
          const parsedPayload = JSON.parse(payload);
          await handleGitHubWebhook(eventType, parsedPayload);
        } catch (error) {
          logger.error('Server', 'Error processing GitHub webhook', error);
        }
      }
    );

    logger.system('GitHub webhooks enabled');
  } else {
    logger.system('GitHub webhooks disabled (GITHUB_WEBHOOK_SECRET not set)');
  }

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
      logger.error('Server', 'Error handling message', error);
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
        logger.error('Server', 'Error handling message', error);
      }
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

    try{
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
      logger.error('Server', 'Error handling edit mode denial', error);
    }
  });

  // Start the app
  await app!.start(config.port);

  logger.plain(`AI Engineer server is running on port ${config.port}`);
  logger.plain(`Slack webhook: POST /slack/events`);
  logger.plain(`GitHub webhook: POST /github/webhooks`);
  logger.plain(`Health check: GET /health`);
}

/**
 * Graceful shutdown
 */
export async function stopServer(): Promise<void> {
  logger.plain('Shutting down AI Engineer server...');

  if (app) {
    await app.stop();
    logger.plain('Server closed');
  }
}
