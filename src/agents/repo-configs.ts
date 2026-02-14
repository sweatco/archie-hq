/**
 * Repository Agent Configurations
 *
 * Builds repo agent configs from plugins loaded by plugin-loader.
 * Infrastructure config (githubRepo, baseBranch) comes from repo-config.json.
 * Agent identity (role, expertise) comes from agents/*.md frontmatter.
 * Agent domain instructions (Layer 3 prompt) comes from agents/*.md body.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import type { RepoAgentConfig } from '../types/repo-agent.js';
import { getPluginsWithRepoConfigs, PLUGINS_DIR } from '../system/plugin-loader.js';

const REPOS_DIR = process.env.ARCHIE_REPOS_DIR || '/repos';

/**
 * Build repo agent configs from loaded plugins that have repo-config.json.
 * Uses sync reads at module load time for simplicity (runs once at startup).
 */
function buildRepoConfigs(): RepoAgentConfig[] {
  const configs: RepoAgentConfig[] = [];

  for (const plugin of getPluginsWithRepoConfigs()) {
    const repoConfigs = plugin.repoConfigs!;

    for (const [key, infraConfig] of Object.entries(repoConfigs)) {
      // Read agent identity and domain prompt from explicit prompt path
      let role = '';
      let expertise = '';
      let agentPrompt: string | undefined;

      if (!infraConfig.prompt) {
        throw new Error(
          `Missing "prompt" field for "${key}" in ${plugin.name}/repo-config.json. ` +
          `Each agent must declare its prompt file (e.g. "prompt": "agents/${key}.md").`
        );
      }

      const agentFilePath = join(plugin.dir, infraConfig.prompt);
      if (!existsSync(agentFilePath)) {
        throw new Error(
          `Agent prompt file not found: ${agentFilePath} ` +
          `(declared as "${infraConfig.prompt}" for "${key}" in ${plugin.name}/repo-config.json)`
        );
      }

      const agentContent = readFileSync(agentFilePath, 'utf-8');
      const { data, content } = matter(agentContent);
      role = data.role || '';
      expertise = data.expertise || '';
      agentPrompt = content.trim() || undefined;

      // repoPath is optional — defaults to ${ARCHIE_REPOS_DIR}/${key}
      const defaultRepoPath = infraConfig.repoPath || join(REPOS_DIR, key);

      configs.push({
        agentId: `${key}-agent`,
        repoKey: key,
        defaultRepoPath,
        role,
        expertise,
        githubRepo: infraConfig.githubRepo,
        baseBranch: infraConfig.baseBranch,
        agentPrompt,
        pluginName: plugin.name,
      });
    }
  }

  return configs;
}

// Load at module initialization
const repoConfigs = buildRepoConfigs();

// Fail-fast: empty array causes z.enum() crash in mcp/tools.ts
if (repoConfigs.length === 0) {
  throw new Error(
    'No repo configs loaded. Ensure at least one plugin has repo-config.json. ' +
    `Scanned: ${PLUGINS_DIR}. ` +
    'Set ARCHIE_PLUGINS_DIR if plugins are in a non-default location.'
  );
}

/**
 * Get a repo config by agent ID
 */
export function getRepoConfig(agentId: string): RepoAgentConfig | undefined {
  return repoConfigs.find((c) => c.agentId === agentId);
}

/**
 * Get all repo configs
 */
export function getAllRepoConfigs(): RepoAgentConfig[] {
  return repoConfigs;
}

/**
 * Get all repo agent IDs
 */
export function getAllRepoAgentIds(): string[] {
  return repoConfigs.map((c) => c.agentId);
}

/**
 * Get a repo config by GitHub repository identifier
 * Used for routing GitHub webhooks to the correct repo agent
 */
export function getRepoConfigByGithubRepo(githubRepo: string): RepoAgentConfig | undefined {
  return repoConfigs.find((c) => c.githubRepo === githubRepo);
}
