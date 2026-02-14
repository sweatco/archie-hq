/**
 * Plugin Agent Configurations
 *
 * Builds plugin agent configs from generic plugins (those WITHOUT repo-config.json).
 * Agent identity (role, expertise) comes from agents/*.md frontmatter.
 * Agent domain instructions (Layer 3 prompt) comes from agents/*.md body.
 *
 * Mirrors the repo-configs.ts pattern but for lightweight, read-only agents.
 */

import { getPlugins } from '../system/plugin-loader.js';
// Import repo agent IDs for collision cross-checking.
// This import also ensures repo-configs.ts initializes first (ES module evaluation order).
import { getAllRepoAgentIds } from './repo-configs.js';
import type { PluginAgentConfig } from '../types/plugin-agent.js';

/**
 * Build plugin agent configs from loaded generic plugins.
 * Checks for agent ID collisions across plugins and against repo agents.
 */
function buildPluginAgentConfigs(): PluginAgentConfig[] {
  const configs: PluginAgentConfig[] = [];
  const seen = new Map<string, string>(); // agentId -> pluginName

  // Cross-check against repo agent IDs
  const repoAgentIds = new Set(getAllRepoAgentIds());

  for (const plugin of getPlugins()) {
    // Skip repo plugins — their agents are handled by repo-configs.ts
    if (plugin.repoConfigs !== null) continue;

    for (const agent of plugin.agents) {
      const agentId = `${agent.key}-agent`;

      // Check for collision with repo agents
      if (repoAgentIds.has(agentId)) {
        throw new Error(
          `Duplicate agent ID "${agentId}" found in plugin "${plugin.name}" ` +
          `— conflicts with a repo agent. Rename the agent file to avoid collision.`
        );
      }

      // Check for collision with other plugin agents
      const existingPlugin = seen.get(agentId);
      if (existingPlugin) {
        throw new Error(
          `Duplicate agent ID "${agentId}" found in plugins "${existingPlugin}" and "${plugin.name}". ` +
          `Rename one of the agent files to avoid collision.`
        );
      }
      seen.set(agentId, plugin.name);

      configs.push({
        agentId,
        key: agent.key,
        role: agent.role,
        expertise: agent.expertise,
        prompt: agent.prompt,
        model: agent.model,
        pluginName: plugin.name,
        pluginPath: plugin.dir,
        skillsPath: plugin.skillsPath || undefined,
      });
    }
  }

  return configs;
}

// Load at module initialization (empty is valid — no generic plugins loaded)
const pluginAgentConfigs = buildPluginAgentConfigs();

/**
 * Get a plugin agent config by agent ID
 */
export function getPluginAgentConfig(agentId: string): PluginAgentConfig | undefined {
  return pluginAgentConfigs.find((c) => c.agentId === agentId);
}

/**
 * Get all plugin agent configs
 */
export function getAllPluginAgentConfigs(): PluginAgentConfig[] {
  return pluginAgentConfigs;
}

/**
 * Get all plugin agent IDs
 */
export function getAllPluginAgentIds(): string[] {
  return pluginAgentConfigs.map((c) => c.agentId);
}
