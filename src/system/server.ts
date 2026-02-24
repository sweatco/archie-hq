/**
 * Main Server
 *
 * Entry point for the Archie system.
 * Uses Slack Bolt in HTTP mode for webhook events.
 *
 * Direct processing: webhook events are handled inline (no queues).
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { App, ExpressReceiver } = require("@slack/bolt");

// Import types separately for type safety
import type { App as AppType } from "@slack/bolt";
import type { ExpressReceiver as ExpressReceiverType } from "@slack/bolt";

import {
  initSlackClient,
  postToThreads,
  postInteractiveToThreads,
  updateMessage,
  getBotUserId,
} from "../slack/client.js";
import { setSlackCallbacks } from '../slack/callbacks.js';
import { Task, getActiveTaskIds } from '../tasks/task.js';
import { appendGitHubEvent } from "./task-manager.js";
import { AGENT_PROMPTS } from "../agents/prompts.js";
import { logger } from "./logger.js";
import type { Request, Response } from "express";

import {
  routeSlackEvent,
  routeGitHubEvent,
  handleMergeCheckDirect,
  formatGitHubContext,
  formatGitHubEventMessage,
} from "./webhook-router.js";
import {
  processSlackTriage,
  processGitHubTriage,
} from "./event-handler.js";
import { getAgentDefByGithubRepo } from "../agents/registry.js";
import { verifyWebhookSignature } from "../github/webhook-utils.js";

/**
 * Server configuration
 */
export interface ServerConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  port: number;
  githubWebhookSecret?: string; // Optional - GitHub webhooks disabled if not set
}

let app: AppType | null = null;
let isShuttingDown = false;

/**
 * Check if the server is shutting down.
 * Used by agent state management to skip deactivation writes during shutdown.
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Create and start the server
 */
export async function startServer(config: ServerConfig): Promise<void> {
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

  // Create Express receiver for HTTP mode
  const receiver: ExpressReceiverType = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    endpoints: "/webhooks/slack",
  });

  // Add health check endpoint
  receiver.router.get("/health", (_req: Request, res: Response) => {
    const status = {
      status: isShuttingDown ? "shutting_down" : "ok",
      activeTasks: getActiveTaskIds().length,
    };
    res.status(isShuttingDown ? 503 : 200).json(status);
  });

  // Add GitHub webhook endpoint (if configured)
  if (config.githubWebhookSecret) {
    // Parse raw body for signature verification
    receiver.router.post(
      "/webhooks/github",
      require("express").raw({ type: "application/json" }),
      async (req: Request, res: Response) => {
        // Check if shutting down
        if (isShuttingDown) {
          res.status(503).json({ error: "Server is shutting down" });
          return;
        }

        const signature = req.headers["x-hub-signature-256"] as string;
        const eventType = req.headers["x-github-event"] as string;

        if (!signature || !eventType) {
          res.status(400).json({ error: "Missing required headers" });
          return;
        }

        // Verify webhook signature
        const payload = req.body.toString();
        if (
          !verifyWebhookSignature(
            payload,
            signature,
            config.githubWebhookSecret!
          )
        ) {
          logger.warn("Server", "Invalid GitHub webhook signature");
          res.status(401).json({ error: "Invalid signature" });
          return;
        }

        // Acknowledge receipt immediately
        res.status(200).json({ received: true });

        // Process inline (fire-and-forget)
        try {
          const parsedPayload = JSON.parse(payload);
          await handleGitHubWebhook(eventType, parsedPayload);
        } catch (error) {
          logger.error("Server", "Error processing GitHub webhook", error);
        }
      }
    );

  }

  // Create Bolt app with HTTP receiver
  app = new App({
    token: config.slackBotToken,
    receiver,
  });

  // Handle app mentions - process inline
  app!.event("app_mention", async ({ event }) => {
    // Check if shutting down
    if (isShuttingDown) {
      logger.system("Ignoring Slack event during shutdown");
      return;
    }

    // Route the event
    const route = routeSlackEvent(event);
    if (route.action === "discard") {
      return;
    }

    // Process inline (fire-and-forget)
    processSlackTriage({
      type: event.type,
      channel: event.channel,
      user: event.user ?? "",
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
    }).catch((err) => logger.error("Server", "Error processing Slack event", err));
  });

  // Handle thread messages (replies without @mention)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.event("message", async ({ event }: { event: any }) => {
    // Only handle thread replies
    if (
      event.type === "message" &&
      !event.subtype &&
      event.thread_ts &&
      event.thread_ts !== event.ts
    ) {
      // Skip if message mentions our bot - app_mention handler will process it
      const botUserId = getBotUserId();
      if (botUserId && event.text?.includes(`<@${botUserId}>`)) {
        return;
      }

      // Check if shutting down
      if (isShuttingDown) {
        logger.system("Ignoring Slack event during shutdown");
        return;
      }

      // Route the event
      const route = routeSlackEvent(event);
      if (route.action === "discard") {
        return;
      }

      // Process inline (fire-and-forget)
      processSlackTriage({
        type: event.type,
        channel: event.channel,
        user: event.user || "",
        text: event.text || "",
        ts: event.ts,
        thread_ts: event.thread_ts,
      }).catch((err) => logger.error("Server", "Error processing Slack event", err));
    }
  });

  // Handle edit mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action("approve_edit_mode", async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || "unknown";

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

      const task = await Task.get(taskId);
      await task.handleEditModeApproval();
    } catch (error) {
      logger.error("Server", "Error handling edit mode approval", error);
    }
  });

  // Handle edit mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action("deny_edit_mode", async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || "unknown";

    logger.server(`Edit mode denied by ${userId} for task ${taskId}`);

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

      const task = await Task.get(taskId);
      await task.handleEditModeDenial();
    } catch (error) {
      logger.error("Server", "Error handling edit mode denial", error);
    }
  });

  // Handle research budget approval button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action("approve_research_budget", async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || "unknown";

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
      logger.error("Server", "Error handling research budget approval", error);
    }
  });

  // Handle research budget denial button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action("deny_research_budget", async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || "unknown";

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
      logger.error("Server", "Error handling research budget denial", error);
    }
  });

  // Start the app
  await app!.start(config.port);

  logger.plain(`Archie server is running on port ${config.port}`);
  logger.plain(`Slack webhook: POST /webhooks/slack`);
  logger.plain(`GitHub webhook: POST /webhooks/github`);
  logger.plain(`Health check: GET /health`);
}

/**
 * Handle GitHub webhook with inline routing
 */
async function handleGitHubWebhook(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Get context for logging
  const context = formatGitHubContext(eventType, payload);

  logger.system(
    `GitHub webhook: ${context.eventType}/${context.action}` +
      ` repo=${context.githubRepo}` +
      (context.prNumber ? ` pr=#${context.prNumber}` : "") +
      (context.branch ? ` branch=${context.branch}` : "") +
      ` user=${context.user}` +
      (context.state ? ` state=${context.state}` : "")
  );

  // Route the event
  const route = await routeGitHubEvent(eventType, payload);

  if (route.action === "discard") {
    logger.system(`GitHub: ${route.reason}`);
    return;
  }

  if (route.action === "triage") {
    // Process GitHub issue_comment inline (was queued before)
    processGitHubTriage(route.taskId, payload).catch((err) =>
      logger.error("Server", "Error processing GitHub triage", err)
    );
  } else if (route.action === "direct") {
    // Handle directly (fast, non-blocking)
    if (route.handler === "merge_check") {
      handleMergeCheckDirect(route.taskId);
    } else if (route.handler === "existing_task") {
      await handleExistingTaskDirect(route.taskId, context);
    }
  }
}

/**
 * Handle existing task event directly (for deterministic events)
 * Logs the event and reactivates the task
 */
async function handleExistingTaskDirect(
  taskId: string,
  context: ReturnType<typeof formatGitHubContext>
): Promise<void> {
  const eventMessage = formatGitHubEventMessage(context);
  const repoDef = getAgentDefByGithubRepo(context.githubRepo);
  const repoKey = repoDef?.repo?.repoKey || "unknown";

  const task = await Task.get(taskId);
  await appendGitHubEvent(taskId, repoKey, eventMessage);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

/**
 * Graceful shutdown
 *
 * Stop accepting webhooks and stop HTTP server.
 * Active agents are dropped — recovery happens on restart via recoverActiveTasks().
 */
export async function stopServer(): Promise<void> {
  logger.plain("Shutting down Archie server...");

  isShuttingDown = true;
  logger.system("Stopped accepting new webhooks");

  if (app) {
    await app.stop();
    logger.plain("Server closed");
  }
}
