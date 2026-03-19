/**
 * Archie - Autonomous Responsive and Collaborative Hyper Intelligent Employee
 *
 * Main entry point. Owns the HTTP server (ExpressReceiver),
 * mounts connectors (Slack, GitHub), and coordinates startup/shutdown.
 */

import 'dotenv/config';
import { createRequire } from 'module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const express = require('express');

import type { Application, Request, Response } from 'express';

import { mountSlackApp } from './connectors/slack/events.js';
import { mountGitHubWebhook } from './connectors/github/events.js';
import { mountApiRoutes } from './connectors/api/routes.js';
import { getIsShuttingDown, setShuttingDown } from './system/shutdown.js';
import { getActiveTaskIds } from './tasks/task.js';
import { logger } from './system/logger.js';
import { bootstrapWorkdir, cloneRepos } from './system/workdir.js';
import { initPlugins, getPlugins } from './system/plugin-loader.js';
import { initRegistry, getAllAgentDefs } from './agents/registry.js';
import { configureGitIdentity } from './connectors/github/client.js';
import { recoverActiveTasks } from './tasks/recovery.js';
import { initEventPersistence } from './tasks/persistence.js';
import { initMemoryAdapter } from './memory-adapter.js';

/**
 * Application configuration
 */
interface AppConfig {
  slackBotToken?: string;
  slackSigningSecret?: string;
  port: number;
  githubWebhookSecret?: string;
}

/**
 * Load configuration from environment
 */
function loadConfig(): AppConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const port = parseInt(process.env.PORT || '3000', 10);
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

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
  logger.plain('Archie - Autonomous Responsive and Collaborative Hyper Intelligent Employee');
  logger.plain('===========================================================================');
  logger.plain('');

  // Fix PATH for spawned processes - npm/tsx strips PATH to node_modules only
  const nodeBinDir = process.execPath.substring(0, process.execPath.lastIndexOf('/'));
  process.env.PATH = `${nodeBinDir}:${process.env.PATH}`;

  try {
    const config = loadConfig();

    // Bootstrap: create workdir structure, clone/pull plugins
    await bootstrapWorkdir();

    // Initialize modules
    initPlugins();
    initRegistry();
    initEventPersistence();
    await initMemoryAdapter();

    // Clone repos declared by plugins
    const agentDefs = getAllAgentDefs();
    const repoDefs = agentDefs.filter((d) => d.track === 'repo');
    await cloneRepos(repoDefs.map((d) => ({
      key: d.repo!.repoKey,
      githubRepo: d.repo!.githubRepo,
    })));

    // Log loaded plugins and agents
    const plugins = getPlugins();

    logger.plain(`Plugins loaded: ${plugins.map((p) => p.name).join(', ') || 'none'}`);
    logger.plain('');

    const allPmSkills = plugins.flatMap((p) =>
      p.pmSkills.map((s) => s.namespacedName)
    );

    logger.plain('Team:');
    logger.plain('  pm-agent (orchestrator)');
    if (allPmSkills.length > 0) {
      logger.plain(`    skills: ${allPmSkills.join(', ')}`);
    }
    for (const def of repoDefs) {
      logger.plain(`  [${def.pluginName}] ${def.id} — ${def.role}`);
      const gitName = await configureGitIdentity(def.repo!.defaultPath);
      logger.plain(`    repo: ${def.repo!.defaultPath} (${def.repo!.githubRepo})`);
      if (gitName) {
        logger.plain(`    git: ${gitName}`);
      }
    }
    for (const def of agentDefs.filter((d) => d.track === 'plugin')) {
      logger.plain(`  [${def.pluginName}] ${def.id} — ${def.role}`);
    }
    logger.plain('');

    // ---- HTTP Server Setup ----

    // Create shared Express app — connectors mount their routes on it
    const app: Application = express();

    // Health check
    app.get('/health', (_req: Request, res: Response) => {
      const shutting = getIsShuttingDown();
      res.status(shutting ? 503 : 200).json({
        status: shutting ? 'shutting_down' : 'ok',
        activeTasks: getActiveTaskIds().length,
      });
    });

    // Mount API routes (REST + SSE for CLI)
    mountApiRoutes(app);

    // Mount GitHub webhook (if configured)
    if (config.githubWebhookSecret) {
      mountGitHubWebhook(app, config.githubWebhookSecret);
    } else {
      logger.plain('GitHub App not configured — PR tools disabled');
    }

    // Mount Slack Bolt app (if configured)
    if (config.slackBotToken && config.slackSigningSecret) {
      await mountSlackApp(app, {
        slackBotToken: config.slackBotToken,
        slackSigningSecret: config.slackSigningSecret,
      });
    } else {
      logger.plain('Slack App not configured — running in CLI-only mode');
    }

    // Start the HTTP server
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(config.port, resolve));

    logger.plain(`Health check: GET /health`);
    logger.plain(`Archie server is running on port ${config.port}\n`);

    await recoverActiveTasks();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.plain(`\nReceived ${signal} signal`);
      setShuttingDown(true);
      logger.system('Stopped accepting new webhooks');
      server.close();
      logger.plain('Server closed');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
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
