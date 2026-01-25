/**
 * Main Server
 *
 * Entry point for the Archie system.
 * Uses Slack Bolt in HTTP mode for webhook events.
 *
 * MVP v4: Queue-based architecture with graceful shutdown.
 * - Webhook events are routed to queues for durable processing
 * - Triage worker handles classification
 * - Spawn worker manages PM agent lifecycle
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
import {
  setSlackCallbacks,
  handleEditModeApproval,
  handleEditModeDenial,
} from "./task-runtime.js";
import { loadMetadata, findTaskByPRNumber } from "./task-manager.js";
import { logger } from "./logger.js";
import type { Request, Response } from "express";

// Queue-based architecture imports
import { getTriageQueue } from "./queues.js";
import { closeQueues } from "./queues.js";
import { closeRedisConnection, isRedisReady } from "./redis.js";
import {
  routeSlackEvent,
  routeGitHubEvent,
  handleMergeCheckDirect,
  formatGitHubContext,
  formatGitHubEventMessage,
} from "./webhook-router.js";
import {
  startTriageWorker,
  stopTriageWorker,
  setRepoPaths as setTriageRepoPaths,
  routeToSpawnOrNotify,
} from "../workers/triage-worker.js";
import {
  startSpawnWorker,
  stopSpawnWorker,
  getActiveSpawnJobCount,
} from "../workers/spawn-worker.js";
import { appendGitHubEvent } from "./task-manager.js";
import { getRepoConfigByGithubRepo } from "../agents/repo-configs.js";
import { verifyWebhookSignature } from "../github/webhook-utils.js";
import { configureGitIdentity } from "../github/client.js";

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
let isShuttingDown = false;

/**
 * Create and start the server
 */
export async function startServer(config: ServerConfig): Promise<void> {
  // Initialize Slack client for outgoing messages
  await initSlackClient(config.slackBotToken);

  // Set repository paths for triage worker
  setTriageRepoPaths(config.backendRepoPath, config.mobileRepoPath);

  // Configure git identity for base repos (worktrees inherit this)
  await configureGitIdentity(config.backendRepoPath);
  await configureGitIdentity(config.mobileRepoPath);

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
        await postInteractiveToThreads(
          taskMetadata.slack_threads,
          text,
          blocks
        );
      }
    }
  );

  // Start queue workers
  startTriageWorker();
  startSpawnWorker();

  // Create Express receiver for HTTP mode
  const receiver: ExpressReceiverType = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    endpoints: "/webhooks/slack",
  });

  // Add health check endpoint
  receiver.router.get("/health", (_req: Request, res: Response) => {
    const status = {
      status: isShuttingDown ? "shutting_down" : "ok",
      redis: isRedisReady() ? "connected" : "disconnected",
      activeSpawnJobs: getActiveSpawnJobCount(),
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

        // Route the webhook
        try {
          const parsedPayload = JSON.parse(payload);
          await handleGitHubWebhookQueued(eventType, parsedPayload);
        } catch (error) {
          logger.error("Server", "Error processing GitHub webhook", error);
        }
      }
    );

    logger.system("GitHub webhooks enabled (queue-based)");
  } else {
    logger.system("GitHub webhooks disabled (GITHUB_WEBHOOK_SECRET not set)");
  }

  // Create Bolt app with HTTP receiver
  app = new App({
    token: config.slackBotToken,
    receiver,
  });

  // Handle app mentions - route to triage queue
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

    // Queue for triage
    const threadId = event.thread_ts || event.ts;
    try {
      const triageQueue = getTriageQueue();
      await triageQueue.add({
        groupId: threadId, // FIFO within same thread
        data: {
          source: "slack",
          payload: {
            type: event.type,
            channel: event.channel,
            user: event.user ?? "",
            text: event.text,
            ts: event.ts,
            thread_ts: event.thread_ts,
          },
        },
      });
      logger.triageQueue(`Queued Slack event (thread: ${threadId})`);

    } catch (error) {
      logger.error("Server", "Error queuing Slack event", error);
    }
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

      // Queue for triage
      const threadId = event.thread_ts;
      try {
        const triageQueue = getTriageQueue();
        await triageQueue.add({
          groupId: threadId, // FIFO within same thread
          data: {
            source: "slack",
            payload: {
              type: event.type,
              channel: event.channel,
              user: event.user || "",
              text: event.text || "",
              ts: event.ts,
              thread_ts: event.thread_ts,
            },
          },
        });
        logger.triageQueue(`Queued Slack thread reply (thread: ${threadId})`);
      } catch (error) {
        logger.error("Server", "Error queuing Slack event", error);
      }
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

      // Handle the approval (routes through spawn queue)
      await handleEditModeApproval(taskId);
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

      // Handle the denial (routes through spawn queue)
      await handleEditModeDenial(taskId);
    } catch (error) {
      logger.error("Server", "Error handling edit mode denial", error);
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
 * Handle GitHub webhook with queue-based routing
 */
async function handleGitHubWebhookQueued(
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
    // Queue issue_comment for triage (to filter conversational noise)
    const triageQueue = getTriageQueue();
    await triageQueue.add({
      groupId: route.taskId, // FIFO within same task
      data: {
        source: "github",
        payload,
        taskId: route.taskId,
      },
    });
    logger.triageQueue(`Queued GitHub issue_comment (task: ${route.taskId})`);
  } else if (route.action === "direct") {
    // Handle directly (fast, non-blocking)
    if (route.handler === "merge_check") {
      handleMergeCheckDirect(route.taskId);
    } else if (route.handler === "existing_task") {
      await handleExistingTaskDirect(route.taskId, context, payload);
    }
  }
}

/**
 * Handle existing task event directly (for deterministic events)
 * Logs the event and routes through spawn queue logic
 */
async function handleExistingTaskDirect(
  taskId: string,
  context: ReturnType<typeof formatGitHubContext>,
  _payload: Record<string, unknown>
): Promise<void> {
  // Format and log the event
  const eventMessage = formatGitHubEventMessage(context);
  const repoConfig = getRepoConfigByGithubRepo(context.githubRepo);
  const repoKey = repoConfig?.repoKey || "unknown";

  await appendGitHubEvent(taskId, repoKey, eventMessage);

  // Route through spawn queue logic (same as triage worker)
  await routeToSpawnOrNotify(taskId);
}

/**
 * Graceful shutdown
 *
 * Shutdown sequence:
 * 1. Stop accepting new webhooks (isShuttingDown = true)
 * 2. Stop triage worker (waits for current job to complete)
 * 3. Wait for spawn worker to finish (waits for all PMs to complete)
 * 4. Close queues and Redis connections
 * 5. Stop HTTP server
 */
export async function stopServer(): Promise<void> {
  logger.plain("Shutting down Archie server...");

  // 1. Stop accepting new webhooks
  isShuttingDown = true;
  logger.system("Stopped accepting new webhooks");

  // 2. Stop triage worker (waits for current job)
  await stopTriageWorker();
  logger.system("Triage worker stopped");

  // 3. Wait for spawn worker (waits for all PMs to complete)
  // Use a generous timeout for graceful shutdown (1 hour)
  const gracefulTimeout = parseInt(
    process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || "3600000",
    10
  );
  logger.system(
    `Waiting for spawn worker to finish (timeout: ${
      gracefulTimeout / 1000
    }s)...`
  );
  await stopSpawnWorker(gracefulTimeout);
  logger.system("Spawn worker stopped, all PM agents completed");

  // 4. Close queues and Redis
  await closeQueues();
  await closeRedisConnection();
  logger.system("Queue connections closed");

  // 5. Stop HTTP server
  if (app) {
    await app.stop();
    logger.plain("Server closed");
  }
}
