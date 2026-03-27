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
import { getPlugins, getRootMcpConfig, getPmOverlay, type LoadedMcpConfig, type PluginAgentDef } from '../system/plugin-loader.js';
import { REPOS_DIR, PLUGINS_DATA_DIR } from '../system/workdir.js';
import { join } from 'path';
import { logger } from '../system/logger.js';

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

  // Load root MCP config once for all agents
  const rootMcp = getRootMcpConfig();

  // --- Scan all agents from all plugins ---
  for (const plugin of getPlugins()) {
    for (const agent of plugin.agents) {
      // Skip the PM overlay — it's handled separately in buildPmDef()
      if (plugin.name === 'pm' && agent.key === 'pm') continue;

      const agentId = `${agent.key}-agent`;
      checkCollision(agentId, plugin.name, seenIds);

      // Resolve MCP servers and tool permissions from frontmatter
      const resolvedMcp = resolveAgentMcpServers(agent, rootMcp);

      if (agent.repo) {
        // Repo agent — has repo metadata in frontmatter
        defs.push({
          id: agentId,
          key: agent.key,
          role: agent.role,
          expertise: agent.expertise,
          model: agent.model,
          track: 'repo',
          pluginName: plugin.name,
          agentPrompt: agent.prompt || undefined,
          repo: {
            githubRepo: agent.repo.github,
            baseBranch: agent.repo.baseBranch,
            defaultPath: join(REPOS_DIR, agent.key),
            repoKey: agent.key,
          },
          pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),
          pluginHooks: plugin.hooks || undefined,
          ...resolvedMcp,
        });
      } else {
        // Plugin agent — no repo metadata
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
          pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),
          skillsPath: plugin.skillsPath || undefined,
          pluginHooks: plugin.hooks || undefined,
          ...resolvedMcp,
        });
      }
    }
  }

  // --- PM agent (singleton, built from the full team) ---
  const teamDefs = defs; // all repo + plugin agents collected above
  defs.push(buildPmDef(teamDefs, rootMcp));

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

/**
 * Resolve agent's mcpServers references against the root .mcp.json.
 *
 * Tool permission rules (all from agent frontmatter):
 * - No `tools` defined → wildcard for every MCP server (`mcp__<name>__*`)
 * - `tools` defined → use exactly what's listed (user adds wildcards explicitly if needed)
 * - `disallowedTools` → always applied on top
 */
function resolveAgentMcpServers(
  agent: PluginAgentDef,
  rootMcp: LoadedMcpConfig,
): Pick<AgentDef, 'mcpServers' | 'tools' | 'disallowedTools'> {
  const result: Pick<AgentDef, 'mcpServers' | 'tools' | 'disallowedTools'> = {};

  if (agent.mcpServers && agent.mcpServers.length > 0) {
    const resolved: Record<string, any> = {};
    for (const name of agent.mcpServers) {
      const config = rootMcp.servers[name];
      if (config) {
        resolved[name] = config;
      } else {
        logger.warn('registry', `Agent "${agent.key}" references MCP server "${name}" not found in root .mcp.json`);
      }
    }
    if (Object.keys(resolved).length > 0) {
      result.mcpServers = resolved;
    }
  }

  // Only pass tools when explicitly defined in agent frontmatter.
  // With bypassPermissions, all tools (built-in + MCP) are available by default —
  // def.tools restricts the set, so auto-generating MCP wildcards would kill built-ins.
  if (agent.tools && agent.tools.length > 0) {
    result.tools = agent.tools;
  }

  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    result.disallowedTools = agent.disallowedTools;
  }

  return result;
}

function buildPmDef(teamDefs: AgentDef[], rootMcp: LoadedMcpConfig): AgentDef {
  const pmPlugin = getPlugins().find((p) => p.name === 'pm');

  const teamList = teamDefs
    .map((d) => `- ${d.id}: ${d.role}`)
    .join('\n');

  const teamExpertise = teamDefs
    .map((d) => `- ${d.id}: ${d.expertise}`)
    .join('\n');

  // PM overlay from the "pm" plugin (extra prompt, MCP, tool permissions)
  const overlay = getPmOverlay();
  const resolvedMcp = overlay ? resolveAgentMcpServers(overlay, rootMcp) : {};

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    track: 'pm',
    pluginName: 'core',
    pluginDataPath: join(PLUGINS_DATA_DIR, 'pm'),
    pmConfig: { teamList, teamExpertise },
    pmOverlayPrompt: overlay?.prompt || undefined,
    skillsPath: pmPlugin?.skillsPath || undefined,
    pluginHooks: pmPlugin?.hooks || undefined,
    ...resolvedMcp,
  };
}
