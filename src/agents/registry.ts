/**
 * Unified Agent Registry
 *
 * Replaces the scan-then-transform pipeline of:
 *   plugin-loader.ts → repo-configs.ts → plugin-configs.ts → peer-list.ts
 *
 * One scan, one AgentDef type, one validation step.
 * Scanned fresh at startup (validate + fail-fast) and on every task start/restart.
 */

import type { AgentDef } from '../types/agent.js';
import { getPlugins, getPluginsWithRepoConfigs, type LoadedPlugin, type PmSkillEntry } from '../system/plugin-loader.js';
import { REPOS_DIR } from '../system/workdir.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

// ---- Module state ----

let registry: AgentDef[] = [];

// ---- Public API ----

/**
 * Initialize the registry. Must be called after initPlugins().
 * Scans plugins and builds all AgentDefs (PM + repo + plugin agents).
 * Fails fast on validation errors (missing prompts, ID collisions, no repo configs).
 */
export function initRegistry(): void {
  registry = scanAgentDefs();
}

/**
 * Scan all plugins and produce a full list of AgentDefs.
 * Called at startup and on every task start/restart (fresh scan from disk).
 */
export function scanAgentDefs(): AgentDef[] {
  const defs: AgentDef[] = [];
  const seenIds = new Map<string, string>(); // agentId → pluginName (collision detection)

  // --- Repo agents ---
  const repoPlugins = getPluginsWithRepoConfigs();
  for (const plugin of repoPlugins) {
    const repoConfigs = plugin.repoConfigs!;
    for (const [key, infraConfig] of Object.entries(repoConfigs)) {
      const agentId = `${key}-agent`;

      // Validate prompt field
      if (!infraConfig.prompt) {
        throw new Error(
          `Missing "prompt" field for "${key}" in ${plugin.name}/repo-config.json. ` +
          `Each agent must declare its prompt file (e.g. "prompt": "agents/${key}.md").`
        );
      }

      // Read agent identity from prompt file
      const agentFilePath = join(plugin.dir, infraConfig.prompt);
      if (!existsSync(agentFilePath)) {
        throw new Error(
          `Agent prompt file not found: ${agentFilePath} ` +
          `(declared as "${infraConfig.prompt}" for "${key}" in ${plugin.name}/repo-config.json)`
        );
      }

      const agentContent = readFileSync(agentFilePath, 'utf-8');
      const { data, content } = matter(agentContent);

      checkCollision(agentId, plugin.name, seenIds);

      defs.push({
        id: agentId,
        key,
        role: data.role || '',
        expertise: data.expertise || '',
        track: 'repo',
        pluginName: plugin.name,
        agentPrompt: content.trim() || undefined,
        repo: {
          githubRepo: infraConfig.githubRepo,
          baseBranch: infraConfig.baseBranch,
          defaultPath: infraConfig.repoPath || join(REPOS_DIR, key),
          repoKey: key,
        },
      });
    }
  }

  // Fail-fast: at least one repo config required (z.enum() crashes on empty array)
  const repoDefs = defs.filter((d) => d.track === 'repo');
  if (repoDefs.length === 0) {
    throw new Error(
      'No repo configs loaded. Ensure at least one plugin has repo-config.json.'
    );
  }

  // --- Plugin agents ---
  for (const plugin of getPlugins()) {
    // Skip repo plugins — their agents are already handled above
    if (plugin.repoConfigs !== null) continue;

    for (const agent of plugin.agents) {
      const agentId = `${agent.key}-agent`;

      checkCollision(agentId, plugin.name, seenIds);

      defs.push({
        id: agentId,
        key: agent.key,
        role: agent.role,
        expertise: agent.expertise,
        model: agent.model,
        track: 'plugin',
        pluginName: plugin.name,
        agentPrompt: agent.prompt,
        pluginPath: plugin.dir,
        skillsPath: plugin.skillsPath || undefined,
      });
    }
  }

  // --- PM agent (singleton, built from the full team) ---
  const teamDefs = defs; // all repo + plugin agents collected above
  defs.push(buildPmDef(teamDefs));

  return defs;
}

/**
 * Get all registered AgentDefs
 */
export function getAllAgentDefs(): AgentDef[] {
  return registry;
}

/**
 * Get all agent IDs (repo + plugin, excludes PM)
 */
export function getAgentIds(): string[] {
  return registry.filter((d) => d.track !== 'pm').map((d) => d.id);
}

/**
 * Get all repo agent IDs
 */
export function getRepoAgentIds(): string[] {
  return registry.filter((d) => d.track === 'repo').map((d) => d.id);
}

/**
 * Get a single AgentDef by ID
 */
export function getAgentDef(id: string): AgentDef | undefined {
  return registry.find((d) => d.id === id);
}

/**
 * Get repo AgentDef by GitHub repository identifier (e.g., 'sweatco/backend')
 */
export function getAgentDefByGithubRepo(githubRepo: string): AgentDef | undefined {
  return registry.find((d) => d.track === 'repo' && d.repo?.githubRepo === githubRepo);
}

/**
 * Get the PM AgentDef
 */
export function getPmDef(): AgentDef | undefined {
  return registry.find((d) => d.track === 'pm');
}

/**
 * Build a formatted peer list string for agent prompts.
 * Includes all agents except the excluded one (and PM).
 */
export function buildPeerList(excludeAgentId: string): string {
  const repoPeers = registry
    .filter((d) => d.track === 'repo' && d.id !== excludeAgentId)
    .map((d) => `- ${d.id}: ${d.role} (${d.repo!.repoKey} repository)`);

  const pluginPeers = registry
    .filter((d) => d.track === 'plugin' && d.id !== excludeAgentId)
    .map((d) => `- ${d.id}: ${d.role} [${d.pluginName}]`);

  return [...repoPeers, ...pluginPeers].join('\n');
}

// ---- Internal helpers ----

function checkCollision(agentId: string, pluginName: string, seen: Map<string, string>): void {
  const existing = seen.get(agentId);
  if (existing) {
    throw new Error(
      `Duplicate agent ID "${agentId}" found in plugins "${existing}" and "${pluginName}". ` +
      `Rename one of the agent files to avoid collision.`
    );
  }
  seen.set(agentId, pluginName);
}

function buildPmDef(teamDefs: AgentDef[]): AgentDef {
  const plugins = getPlugins();
  const allPmSkills = plugins.flatMap((p: LoadedPlugin) =>
    p.pmSkills.map((s: PmSkillEntry) => s.namespacedName)
  );

  const teamList = teamDefs
    .map((d) => `- ${d.id}: ${d.role}`)
    .join('\n');

  const teamExpertise = teamDefs
    .map((d) => `- ${d.id}: ${d.expertise}`)
    .join('\n');

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    track: 'pm',
    pluginName: 'core',
    pmConfig: { teamList, teamExpertise },
    pmSkills: allPmSkills,
  };
}
