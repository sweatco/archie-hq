/**
 * Peer List Builder
 *
 * Builds a unified peer list for agent prompts that includes
 * both repo agents and plugin agents. Used by both repo-agent.ts
 * and plugin-agent.ts for cross-track peer discovery.
 */

import { getAllRepoConfigs } from './repo-configs.js';
import { getAllPluginAgentConfigs } from './plugin-configs.js';

/**
 * Build a formatted peer list string for agent prompts.
 * Includes all repo agents and plugin agents except the excluded one.
 */
export function buildPeerList(excludeAgentId: string): string {
  const repoPeers = getAllRepoConfigs()
    .filter((c) => c.agentId !== excludeAgentId)
    .map((c) => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`);

  const pluginPeers = getAllPluginAgentConfigs()
    .filter((c) => c.agentId !== excludeAgentId)
    .map((c) => `- ${c.agentId}: ${c.role} [${c.pluginName}]`);

  return [...repoPeers, ...pluginPeers].join('\n');
}
