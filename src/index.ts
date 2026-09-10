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
import { bootstrapWorkdir, cloneRepos, OAUTH_DIR } from './system/workdir.js';
import { validateMasterKey } from './system/secrets-vault.js';
import { initPlugins, getPlugins, getArchieConfig } from './system/plugin-loader.js';
import { startContextProbe } from './system/context-probe.js';
import { initRegistry, getPmDef } from './agents/registry.js';
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

    // Warm the base clones the plugins repo asks for (`repos[*].warm` in
    // archie.json), so the first `mount_repo` of a big repository does not pay
    // for a cold clone inside a task. Every other repo is cloned on demand.
    const archieConfig = getArchieConfig();
    const warmRepos = Object.entries(archieConfig.repos)
      .filter(([, cfg]) => cfg.warm === true)
      .map(([github]) => ({ github }));
    if (warmRepos.length > 0) {
      logger.plain(`Warming base clones: ${warmRepos.map((r) => r.github).join(', ')}`);
      await cloneRepos(warmRepos);
    }

    // Log what the next task will load. The plugin directories here are exactly
    // what spawn hands to the SDK `plugins` option; their skills and agents are
    // read by the SDK, not by us, so there is nothing to enumerate at startup —
    // spawn asserts against the session's `init` message instead.
    const plugins = getPlugins();
    logger.plain(`Plugins loaded: ${plugins.map((p) => p.name).join(', ') || 'none'}`);

    const pmDef = getPmDef();
    logger.plain('PM agent:');
    logger.plain(`  model: ${pmDef.model}${pmDef.effort ? ` (effort: ${pmDef.effort})` : ''}`);
    if (pmDef.mcpServers && Object.keys(pmDef.mcpServers).length > 0) {
      logger.plain(`  mcp: ${Object.keys(pmDef.mcpServers).join(', ')}`);
    }
    if (pmDef.allowedNetworkDomains && pmDef.allowedNetworkDomains.length > 0) {
      logger.plain(`  network: ${pmDef.allowedNetworkDomains.join(', ')}`);
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
        // Checkout attestation for the e2e harness (docker-compose passes the
        // composing shell's GIT_SHA); null when not composed with one.
        git_sha: process.env.GIT_SHA || null,
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
