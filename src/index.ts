/**
 * AI Engineer - Multi-Agent Software Engineering System
 *
 * Main entry point for the application.
 */

import 'dotenv/config';
import { startServer, stopServer, type ServerConfig } from './system/server.js';
import { logger } from './system/logger.js';

/**
 * Load configuration from environment
 */
function loadConfig(): ServerConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const port = parseInt(process.env.PORT || '3000', 10);
  const backendRepoPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
  const mobileRepoPath = process.env.MOBILE_REPO_PATH || '/repos/mobile';
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Validate required environment variables
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required');
  }
  if (!slackSigningSecret) {
    throw new Error('SLACK_SIGNING_SECRET environment variable is required');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return {
    slackBotToken,
    slackSigningSecret,
    port,
    backendRepoPath,
    mobileRepoPath,
    githubWebhookSecret,
  };
}

/**
 * Main function
 */
async function main(): Promise<void> {
  logger.plain('AI Engineer - Multi-Agent Software Engineering System');
  logger.plain('======================================================');
  logger.plain('');

  // Fix PATH for spawned processes - npm/tsx strips PATH to node_modules only
  // Add standard binary locations so child processes can find node
  const nodeBinDir = process.execPath.substring(0, process.execPath.lastIndexOf('/'));
  process.env.PATH = `${nodeBinDir}:${process.env.PATH}`;

  try {
    const config = loadConfig();

    logger.plain(`Backend repo: ${config.backendRepoPath}`);
    logger.plain(`Mobile repo: ${config.mobileRepoPath}`);
    logger.plain('');

    await startServer(config);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.plain('\nReceived SIGINT signal');
      await stopServer();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.plain('\nReceived SIGTERM signal');
      await stopServer();
      process.exit(0);
    });
  } catch (error) {
    logger.error('index', 'Failed to start server', error);
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  logger.error('index', 'Unhandled error', error);
  process.exit(1);
});
