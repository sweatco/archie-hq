/**
 * Archie - Autonomous Responsive and Collaborative Hyper Intelligent Employee
 *
 * Main entry point. Owns the HTTP server (ExpressReceiver),
 * mounts connectors (Slack, GitHub), and coordinates startup/shutdown.
 */

import 'dotenv/config';
import { createRequire } from 'module';
import http from 'node:http';
import { readdirSync } from 'fs';
const require = createRequire(import.meta.url);
const express = require('express');

import type { Application, Request, Response } from 'express';

import { mountSlackApp, type SlackLifecycle } from './connectors/slack/events.js';
import { mountGitHubWebhook } from './connectors/github/events.js';
import { mountApiRoutes } from './connectors/api/routes.js';
import { mountOAuthRoutes } from './connectors/oauth/routes.js';
import { getIsShuttingDown, setShuttingDown } from './system/shutdown.js';
import { getActiveTaskIds } from './tasks/task.js';
import { logger } from './system/logger.js';
import { bootstrapWorkdir, cloneRepos, OAUTH_DIR } from './system/workdir.js';
import { validateMasterKey } from './system/secrets-vault.js';
import { initPlugins, getPlugins } from './system/plugin-loader.js';
import { initRegistry, getAllAgentDefs } from './agents/registry.js';
import { isRepoAgent, isPmAgent } from './types/agent.js';
import { configureGitIdentity } from './connectors/github/client.js';
import { recoverActiveTasks } from './tasks/recovery.js';
import { initEventPersistence } from './tasks/persistence.js';
import { initReminderScheduler } from './system/reminder-scheduler.js';

/**
 * Application configuration
 */
interface AppConfig {
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackAppToken?: string;
  port: number;
  githubWebhookSecret?: string;
}

/**
 * Load configuration from environment
 */
function loadConfig(): AppConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const port = parseInt(process.env.PORT || '3000', 10);
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return {
    slackBotToken,
    slackSigningSecret,
    slackAppToken,
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

    // If any OAuth vault records exist (or the master key was provided),
    // validate it now so a misconfigured deployment fails fast instead of
    // erroring at agent-spawn time.
    const hasVaultRecords = readdirSync(OAUTH_DIR).some((name) => name.endsWith('.json'));
    if (hasVaultRecords || process.env.ARCHIE_SECRETS_KEY) {
      validateMasterKey();
    }

    // Initialize modules
    initPlugins();
    initRegistry();
    initEventPersistence();

    // Clone repos declared by plugins
    const agentDefs = getAllAgentDefs();
    const repoDefs = agentDefs.filter(isRepoAgent);
    await cloneRepos(repoDefs.map((d) => ({
      key: d.repo!.repoKey,
      githubRepo: d.repo!.githubRepo,
      baseBranch: d.repo!.baseBranch,
    })));

    // Log loaded plugins and agents
    const plugins = getPlugins();

    logger.plain(`Plugins loaded: ${plugins.map((p) => p.name).join(', ') || 'none'}`);
    logger.plain('');

    const pmDef = agentDefs.find(isPmAgent);

    logger.plain('Team:');
    logger.plain('  pm-agent (orchestrator)');
    const pmPlugin = plugins.find((p) => p.name === 'pm');
    const pmSkillNames = new Set<string>();
    if (pmPlugin?.skillsPath) {
      for (const e of readdirSync(pmPlugin.skillsPath, { withFileTypes: true })) {
        if (e.isDirectory()) pmSkillNames.add(e.name);
      }
    }
    if (pmDef?.coreSkillsPath) {
      for (const e of readdirSync(pmDef.coreSkillsPath, { withFileTypes: true })) {
        if (e.isDirectory()) pmSkillNames.add(e.name);
      }
    }
    if (pmSkillNames.size > 0) {
      logger.plain(`    skills: ${Array.from(pmSkillNames).sort().join(', ')}`);
    }
    if (pmDef?.mcpServers) {
      logger.plain(`    mcp: ${Object.keys(pmDef.mcpServers).join(', ')}`);
    }
    if (pmDef?.pmOverlayPrompt) {
      logger.plain(`    overlay: pm plugin`);
    }
    for (const def of repoDefs) {
      logger.plain(`  [${def.pluginName}] ${def.id} (${def.visibility}) — ${def.role}`);
      const gitName = await configureGitIdentity(def.repo!.defaultPath);
      logger.plain(`    repo: ${def.repo!.defaultPath} (${def.repo!.githubRepo})`);
      if (gitName) {
        logger.plain(`    git: ${gitName}`);
      }
      if (def.mcpServers) {
        logger.plain(`    mcp: ${Object.keys(def.mcpServers).join(', ')}`);
      }
    }
    for (const def of agentDefs.filter((d) => !isPmAgent(d) && !isRepoAgent(d))) {
      logger.plain(`  [${def.pluginName}] ${def.id} (${def.visibility}) — ${def.role}`);
      if (def.mcpServers) {
        logger.plain(`    mcp: ${Object.keys(def.mcpServers).join(', ')}`);
      }
    }
    logger.plain('');

    // Warn about plugins that have no externally reachable agents.
    // Repo agents can still be addressed via webhooks even when local, so they
    // count as external entry points; plugin agents must be `global` for PM
    // (or another plugin) to dispatch into them.
    const pluginNames = new Set(plugins.map((p) => p.name));
    pluginNames.delete('pm');
    for (const pluginName of pluginNames) {
      const pluginAgents = agentDefs.filter((d) => d.pluginName === pluginName && !isPmAgent(d));
      if (pluginAgents.length === 0) continue;
      const hasEntryPoint = pluginAgents.some(
        (d) => d.visibility === 'global' || isRepoAgent(d),
      );
      if (!hasEntryPoint) {
        logger.warn(
          'system',
          `Plugin "${pluginName}" has no externally reachable agents — PM cannot dispatch into it (all agents are local).`,
        );
      }
    }

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

    // Mount OAuth callback route (provider redirects land here)
    mountOAuthRoutes(app);

    // Mount GitHub webhook (if configured)
    if (config.githubWebhookSecret) {
      mountGitHubWebhook(app, config.githubWebhookSecret);
    } else {
      logger.plain('GitHub App not configured — PR tools disabled');
    }

    // Mount Slack Bolt app (if configured).
    // Two modes: HTTP (bot token + signing secret) or Socket Mode (bot token + app token).
    // Mounting registers handlers but does NOT start accepting events — we defer
    // that until after task recovery so inbound events cannot race recovery.
    const slackHttpReady = !!(config.slackBotToken && config.slackSigningSecret);
    const slackSocketReady = !!(config.slackBotToken && config.slackAppToken);
    let slackLifecycle: SlackLifecycle | null = null;
    if (slackHttpReady || slackSocketReady) {
      slackLifecycle = await mountSlackApp(app, {
        slackBotToken: config.slackBotToken!,
        slackSigningSecret: config.slackSigningSecret,
        slackAppToken: config.slackAppToken,
        dryRun: process.env.SLACK_DRY_RUN === 'true',
      });
    } else {
      logger.plain('Slack App not configured — running in CLI-only mode');
    }

    // Create the HTTP server but DO NOT listen yet — recover first so a Slack
    // event arriving on startup cannot reach a task before its agent is respawned.
    const server = http.createServer(app);

    await recoverActiveTasks();
    await initReminderScheduler();

    // Now accept events: start the HTTP server and open the Socket Mode WebSocket.
    await new Promise<void>((resolve) => server.listen(config.port, resolve));
    if (slackLifecycle) await slackLifecycle.start();

    logger.plain(`Health check: GET /health`);
    logger.plain(`Archie server is running on port ${config.port}\n`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.plain(`\nReceived ${signal} signal`);
      setShuttingDown(true);
      logger.system('Stopped accepting new webhooks');
      if (slackLifecycle) {
        try {
          await slackLifecycle.stop();
        } catch (err) {
          logger.error('index', 'Error stopping Slack receiver', err);
        }
      }
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
