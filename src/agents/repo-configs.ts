/**
 * Repository Agent Configurations — SHIM
 *
 * Delegates to agents/registry.ts. Converts AgentDef → RepoAgentConfig
 * so existing consumers (task-runtime, server, event-handler, etc.) keep working.
 *
 * Will be deleted in Step 10 when all imports are updated.
 */

import type { RepoAgentConfig } from '../types/repo-agent.js';
import type { AgentDef } from '../types/agent.js';
import { getAllAgentDefs, getAgentDef, getAgentDefByGithubRepo } from './registry.js';

function toRepoConfig(def: AgentDef): RepoAgentConfig {
  return {
    agentId: def.id,
    repoKey: def.repo!.repoKey,
    defaultRepoPath: def.repo!.defaultPath,
    role: def.role,
    expertise: def.expertise,
    githubRepo: def.repo!.githubRepo,
    baseBranch: def.repo!.baseBranch,
    agentPrompt: def.agentPrompt,
    pluginName: def.pluginName,
  };
}

/**
 * @deprecated Use initRegistry() instead. Kept as no-op for backward compat.
 */
export function initRepoConfigs(): void {
  // No-op: registry is initialized via initRegistry()
}

export function getRepoConfig(agentId: string): RepoAgentConfig | undefined {
  const def = getAgentDef(agentId);
  return def?.track === 'repo' ? toRepoConfig(def) : undefined;
}

export function getAllRepoConfigs(): RepoAgentConfig[] {
  return getAllAgentDefs()
    .filter((d) => d.track === 'repo')
    .map(toRepoConfig);
}

export function getAllRepoAgentIds(): string[] {
  return getAllAgentDefs()
    .filter((d) => d.track === 'repo')
    .map((d) => d.id);
}

export function getRepoConfigByGithubRepo(githubRepo: string): RepoAgentConfig | undefined {
  const def = getAgentDefByGithubRepo(githubRepo);
  return def ? toRepoConfig(def) : undefined;
}
