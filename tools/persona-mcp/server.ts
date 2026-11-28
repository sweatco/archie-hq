/**
 * Archie Personas MCP Server — lets a coding agent act as test members of a dedicated Slack
 * test workspace, to verify behavior that depends on who is speaking (memory, proactivity).
 *
 * Standalone stdio MCP server. No imports from src/. Setup: docs/guides/slack-test-personas.md.
 *
 * Start-up:
 *   - No persona config on this machine: the server starts with `list_personas` only, which
 *     explains the setup. Personas are opt-in per developer.
 *   - Config present: every token is checked against the configured workspace and member
 *     first. A mismatch stops the server with the reason on stderr, before any tool exists.
 *
 * Every action uses the API transport: the member's own user token. Slack may stamp such posts
 * with the persona app's identity; `read_as` reports that per message as `appAuthored`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, findPersonaConfig } from './load-config.js';
import { connectPersonas, createSlackClient } from './persona-clients.js';
import { registerPersonaTools, registerSetupNotice } from './persona-tools.js';
import { readSecret, runCommand } from './secrets.js';

const server = new McpServer({ name: 'archie-personas', version: '1.0.0' });
const secretSources = { env: process.env, run: runCommand };

/** Register the tools this machine is set up for. Throws if a config exists but is unusable. */
async function registerTools(): Promise<void> {
  const config = findPersonaConfig();
  if (!config) {
    registerSetupNotice(server, configPath());
    console.error(`[archie-personas] no config at ${configPath()}; setup notice only`);
    return;
  }
  const actors = await connectPersonas(config, secretSources, createSlackClient);
  const { signingSecret } = config;
  registerPersonaTools(server, config, actors, {
    readSigningSecret: () => {
      if (!signingSecret) throw new Error('signingSecret is not configured');
      return readSecret(signingSecret, secretSources);
    },
  });
  console.error(`[archie-personas] ${config.environment}: acting as ${actors.length} personas`);
}

// stderr only — stdout carries the MCP protocol and must not be polluted.
try {
  await registerTools();
} catch (error) {
  // A wrong or unreadable token must never leave a half-working server behind: say why and stop.
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[archie-personas] refusing to start: ${reason}`);
  process.exit(1);
}

await server.connect(new StdioServerTransport());
