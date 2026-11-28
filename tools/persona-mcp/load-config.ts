/** Reads the persona config from disk for the CLI mains and the MCP server. */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { parsePersonaConfig, resolveConfigPath, type PersonaConfig } from './config.js';

export const configPath = (): string => resolveConfigPath(process.env, homedir());

/** The config, or undefined when this machine has none: personas are opt-in per developer. */
export function findPersonaConfig(): PersonaConfig | undefined {
  if (!existsSync(configPath())) return undefined;
  return parsePersonaConfig(readFileSync(configPath(), 'utf-8'));
}

/** The config, for commands that cannot do anything without one. */
export function loadPersonaConfig(): PersonaConfig {
  const config = findPersonaConfig();
  if (!config) {
    throw new Error(
      `no persona config at ${configPath()}: copy tools/persona-mcp/config.example.json there, or point ARCHIE_PERSONAS_CONFIG at one`,
    );
  }
  return config;
}
