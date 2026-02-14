/**
 * Archie - Autonomous Repository Collaborative Hyper Intelligent Engineer
 *
 * Main entry point for the application.
 */

import 'dotenv/config';
import { startServer, stopServer, type ServerConfig } from './system/server.js';
import { logger } from './system/logger.js';
import { getPlugins } from './system/plugin-loader.js';
import { getAllRepoConfigs } from './agents/repo-configs.js';
import { getAllPluginAgentConfigs } from './agents/plugin-configs.js';
import { configureGitIdentity } from './github/client.js';

/**
 * Load configuration from environment
 */
function loadConfig(): ServerConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const port = parseInt(process.env.PORT || '3000', 10);
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
    githubWebhookSecret,
  };
}

/**
 * Main function
 */
async function main(): Promise<void> {
  logger.plain('Archie - Autonomous Repository Collaborative Hyper Intelligent Engineer');
  logger.plain('=======================================================================');
  logger.plain('');

  // Fix PATH for spawned processes - npm/tsx strips PATH to node_modules only
  // Add standard binary locations so child processes can find node
  const nodeBinDir = process.execPath.substring(0, process.execPath.lastIndexOf('/'));
  process.env.PATH = `${nodeBinDir}:${process.env.PATH}`;

  try {
    const config = loadConfig();

    // Log loaded plugins and agents
    const plugins = getPlugins();
    const repoConfigs = getAllRepoConfigs();

    logger.plain(`Plugins loaded: ${plugins.map((p) => p.name).join(', ') || 'none'}`);
    logger.plain('');

    // Collect all PM skills across plugins (already namespaced)
    const allPmSkills = plugins.flatMap((p) =>
      p.pmSkills.map((s) => s.namespacedName)
    );

    logger.plain('Team:');
    logger.plain('  pm-agent (orchestrator)');
    if (allPmSkills.length > 0) {
      logger.plain(`    skills: ${allPmSkills.join(', ')}`);
    }
    for (const rc of repoConfigs) {
      logger.plain(`  [${rc.pluginName}] ${rc.agentId} — ${rc.role}`);
      const gitName = await configureGitIdentity(rc.defaultRepoPath);
      logger.plain(`    repo: ${rc.defaultRepoPath} (${rc.githubRepo})`);
      if (gitName) {
        logger.plain(`    git: ${gitName}`);
      }
    }
    for (const pa of getAllPluginAgentConfigs()) {
      logger.plain(`  [${pa.pluginName}] ${pa.agentId} — ${pa.role}`);
    }
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
