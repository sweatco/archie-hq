/**
 * Archie - Autonomous Responsive and Collaborative Hyper Intelligent Employee
 *
 * Main entry point. Owns the HTTP server (ExpressReceiver),
 * mounts connectors (Slack, GitHub), and coordinates startup/shutdown.
 *
 * Copyright (C) 2026 Archie HQ contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed WITHOUT ANY WARRANTY. See the
 * LICENSE file or <https://www.gnu.org/licenses/> for details.
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
import { bootstrapWorkdir, cloneRepos, OAUTH_DIR, REPOS_DIR } from './system/workdir.js';
import { join } from 'path';
import { validateMasterKey } from './system/secrets-vault.js';
import { initPlugins, getPlugins } from './system/plugin-loader.js';
import { startContextProbe } from './system/context-probe.js';
import { initRegistry, getAllAgentDefs } from './agents/registry.js';
import { isRepoAgent, isPmAgent } from './types/agent.js';
import { configureGitIdentity } from './connectors/github/client.js';
import { recoverActiveTasks } from './tasks/recovery.js';
import { initEventPersistence } from './tasks/persistence.js';
import { initReminderScheduler } from './system/reminder-scheduler.js';
import { initTriggerScheduler } from './system/trigger-scheduler.js';
import { initMemory } from './memory/index.js';

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
    await initMemory();

    // DEBUG: start the context-probe logging proxy (no-op when disabled). Must
    // be before any agent spawns so getProbeBaseUrl() is live at spawn time.
    startContextProbe();

    // Clone repos declared by plugins (every entry across every repo agent,
    // deduplicated by github identifier).
    const agentDefs = getAllAgentDefs();
    const repoDefs = agentDefs.filter(isRepoAgent);
    const byGithub = new Map<string, { github: string; baseBranch: string }>();
    for (const def of repoDefs) {
      for (const entry of def.repo!.repos) {
        if (!byGithub.has(entry.github)) {
          byGithub.set(entry.github, { github: entry.github, baseBranch: entry.baseBranch });
        }
      }
    }
    await cloneRepos([...byGithub.values()]);

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
      const primary = def.repo!.primary;
      const primaryPath = join(REPOS_DIR, primary);
      const gitName = await configureGitIdentity(primaryPath);
      logger.plain(`    primary: ${primary} (${primaryPath})`);
      if (gitName) {
        logger.plain(`    git: ${gitName}`);
      }
      const otherRepos = def.repo!.repos.filter((r) => r.github !== primary);
      if (otherRepos.length > 0) {
        logger.plain(`    also mounts: ${otherRepos.map((r) => r.github).join(', ')}`);
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
    await initTriggerScheduler();

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
