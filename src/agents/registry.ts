/**
 * Unified Agent Registry
 *
 * Replaces the scan-then-transform pipeline of:
 *   plugin-loader.ts → repo-configs.ts → plugin-configs.ts → peer-list.ts
 *
 * One scan, one AgentDef type, one validation step.
 * Scanned fresh at startup (validate + fail-fast) and on every task start/restart.
 */

import { type AgentDef, isRepoAgent, isPmAgent } from '../types/agent.js';
import { getPlugins, getRootMcpConfig, getPmOverlay, type LoadedMcpConfig, type PluginAgentDef } from '../system/plugin-loader.js';
import { PLUGINS_DATA_DIR } from '../system/workdir.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../system/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Built-in PM skills shipped with archie-hq (resolved relative to this file: src/agents -> skills)
const CORE_SKILLS_DIR = join(__dirname, '..', '..', 'skills');

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

      const visibility: 'global' | 'local' = agent.visibility ?? 'global';

      if (agent.repo) {
        // Repo agent — has repo metadata in frontmatter
        defs.push({
          id: agentId,
          key: agent.key,
          statusLabel: agent.statusLabel,
          role: agent.role,
          expertise: agent.expertise,
          model: agent.model,
          effort: agent.effort,
          maxTurns: agent.maxTurns,
          pluginName: plugin.name,
          visibility,
          agentPrompt: agent.prompt || undefined,
          pluginPath: plugin.dir,
          repo: {
            repos: agent.repo.repos.map((r) => ({
              github: r.github,
              baseBranch: r.baseBranch || 'main',
            })),
            primary: agent.repo.primary,
          },
          pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),
          skillsPath: plugin.skillsPath || undefined,
          pluginHooks: plugin.hooks || undefined,
          allowedNetworkDomains: agent.allowedNetworkDomains,
          ...resolvedMcp,
        });
      } else {
        // Plugin agent — no repo metadata
        defs.push({
          id: agentId,
          key: agent.key,
          statusLabel: agent.statusLabel,
          role: agent.role,
          expertise: agent.expertise,
          model: agent.model,
          effort: agent.effort,
          maxTurns: agent.maxTurns,
          pluginName: plugin.name,
          visibility,
          agentPrompt: agent.prompt,
          pluginPath: plugin.dir,
          pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),
          skillsPath: plugin.skillsPath || undefined,
          pluginHooks: plugin.hooks || undefined,
          allowedNetworkDomains: agent.allowedNetworkDomains,
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
 * Test-only: override the in-memory registry. Used by unit tests that exercise
 * the pure helpers (visibility filtering, peer-list construction) without
 * loading plugins from disk. Do not call from production code.
 */
export function __setRegistryForTesting(defs: AgentDef[]): void {
  registry = defs;
}

/**
 * Get all agent IDs (repo + plugin, excludes PM)
 */
export function getAgentIds(): string[] {
  return registry.filter((d) => !isPmAgent(d)).map((d) => d.id);
}

/**
 * Get all repo agent IDs
 */
export function getRepoAgentIds(): string[] {
  return registry.filter(isRepoAgent).map((d) => d.id);
}

/**
 * Get a single AgentDef by ID
 */
export function getAgentDef(id: string): AgentDef | undefined {
  return registry.find((d) => d.id === id);
}

/**
 * Get repo AgentDef whose **primary** is the given GitHub repository identifier
 * (e.g., 'acme/backend'). Matches on the primary only; an agent that merely
 * lists the repo as a secondary is not returned.
 */
export function getAgentDefByGithubRepo(githubRepo: string): AgentDef | undefined {
  return registry.find((d) => isRepoAgent(d) && d.repo!.primary === githubRepo);
}

/**
 * Get the PM AgentDef
 */
export function getPmDef(): AgentDef | undefined {
  return registry.find(isPmAgent);
}

/**
 * Return the set of agent ids the sender is allowed to address.
 * Filter rules:
 *   - Same-plugin peers are always visible (any visibility).
 *   - Other-plugin peers are visible only if visibility === 'global'.
 *   - PM is excluded (the send_message_to_agent enum adds it back as a fallback).
 *   - The sender itself is excluded.
 */
export function getVisiblePeerIdsForSender(senderDef: AgentDef): string[] {
  return registry
    .filter((d) => !isPmAgent(d))
    .filter((d) => d.id !== senderDef.id)
    .filter((d) => d.pluginName === senderDef.pluginName || d.visibility === 'global')
    .map((d) => d.id);
}

/**
 * Build a formatted peer list for the sender's prompt, applying visibility rules.
 */
export function buildPeerListForSender(senderDef: AgentDef): string {
  const visibleIds = new Set(getVisiblePeerIdsForSender(senderDef));

  const repoPeers = registry
    .filter((d) => isRepoAgent(d) && visibleIds.has(d.id))
    .map((d) => `- ${d.id}: ${d.role} (${d.repo!.primary} repository)`);

  // Non-repo peers (visibleIds already excludes the PM).
  const pluginPeers = registry
    .filter((d) => !isRepoAgent(d) && visibleIds.has(d.id))
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

  // PM belongs to the "pm" plugin for visibility purposes — agents marked `local`
  // in the pm plugin are addressable by PM, locals elsewhere are not.
  const visibleTeam = teamDefs.filter(
    (d) => d.pluginName === 'pm' || d.visibility === 'global',
  );

  // PM overlay from the "pm" plugin (extra prompt, MCP, tool permissions)
  const overlay = getPmOverlay();
  const resolvedMcp = overlay ? resolveAgentMcpServers(overlay, rootMcp) : {};

  // Annotate each teammate's roster line with the external systems it can reach
  // via MCP. Without this the PM sees only roles/expertise and can wrongly tell a
  // user that checking Jira / Rollbar / the admin panel / etc. isn't possible —
  // the roster is its only window into what teammates can reach.
  const describeServer = (name: string): string => {
    const desc = rootMcp.descriptions[name];
    return desc ? `${name} (${desc})` : name;
  };
  const integrationsSuffix = (d: AgentDef): string => {
    const names = d.mcpServers ? Object.keys(d.mcpServers) : [];
    return names.length > 0 ? ` — integrations: ${names.map(describeServer).join('; ')}` : '';
  };

  const teamList = visibleTeam
    .map((d) => `- ${d.id}: ${d.role}${integrationsSuffix(d)}`)
    .join('\n');

  const teamExpertise = visibleTeam
    .map((d) => `- ${d.id}: ${d.expertise}`)
    .join('\n');

  // The PM isn't part of its own roster, so surface the integrations it can call
  // directly as a self-contained sentence (empty when it has none).
  const pmServerNames = resolvedMcp.mcpServers ? Object.keys(resolvedMcp.mcpServers) : [];
  const pmIntegrations = pmServerNames.length > 0
    ? `You can also query these external systems yourself directly: ${pmServerNames.map(describeServer).join('; ')}.`
    : '';

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    model: overlay?.model,
    effort: overlay?.effort,
    maxTurns: overlay?.maxTurns,
    isPm: true,
    pluginName: 'pm',
    visibility: 'global',
    pluginDataPath: join(PLUGINS_DATA_DIR, 'pm'),
    pmConfig: { teamList, teamExpertise, pmIntegrations },
    pmOverlayPrompt: overlay?.prompt || undefined,
    skillsPath: pmPlugin?.skillsPath || undefined,
    coreSkillsPath: existsSync(CORE_SKILLS_DIR) ? CORE_SKILLS_DIR : undefined,
    pluginHooks: pmPlugin?.hooks || undefined,
    ...resolvedMcp,
  };
}
