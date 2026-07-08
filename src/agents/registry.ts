/**
 * Unified Agent Registry
 *
 * Replaces the scan-then-transform pipeline of:
 *   plugin-loader.ts → repo-configs.ts → plugin-configs.ts → peer-list.ts
 *
 * One scan, one AgentDef type, one validation step.
 * Scanned fresh at startup (validate + fail-fast) and on every task start/restart.
 */

import { type AgentDef, type RepoEntry, isRepoAgent, isPmAgent } from '../types/agent.js';
import type { DynamicAgentSpec } from '../types/task.js';
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
              autoMerge: r.autoMerge === true,
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
 * All registered repo agents that declare the given github anywhere in their
 * `repos` list (primary or otherwise). Used by `spawn_repo_agent`'s
 * anti-duplication check and by `list_available_repos` to tag repos that a
 * plugin specialist already covers.
 */
export function findAgentDefsContainingRepo(githubRepo: string): AgentDef[] {
  return registry.filter(
    (d) => isRepoAgent(d) && d.repo!.repos.some((r) => r.github === githubRepo),
  );
}

/**
 * Merge policy for a repo: may Archie merge its PRs without asking the user?
 *
 * True only when every registered agent declaring the repo sets
 * `autoMerge: true` on all of its matching entries (AND semantics — a conflict
 * means at least one declaration wants supervision, and supervision wins).
 * Repos declared by no registered agent (dynamic-agent-only attachments,
 * retired agents) resolve to false — never auto-merge a repo nobody
 * statically owns. Consults the live registry, so a frontmatter change takes
 * effect on the next merge check after a rescan.
 */
export function isAutoMergeRepo(github: string): boolean {
  const defs = findAgentDefsContainingRepo(github);
  if (defs.length === 0) return false;
  const flags = defs.flatMap((d) =>
    d.repo!.repos.filter((r) => r.github === github).map((r) => r.autoMerge === true),
  );
  const allAuto = flags.every(Boolean);
  if (!allAuto && flags.some(Boolean)) {
    logger.warn(
      'registry',
      `Mixed autoMerge flags for ${github} across declaring agents — resolving to manual-approval merges (AND semantics)`,
    );
  }
  return allAuto;
}

/**
 * Re-synthesize a live AgentDef from a stored DynamicAgentSpec (PM-spawned
 * repo agent). Deterministic and idempotent — called on every `Task.get` to
 * rebuild the agent from the persisted spec, so no derived state lives on disk.
 */
export function synthesizeDynamicAgentDef(spec: DynamicAgentSpec): AgentDef {
  const repos: RepoEntry[] = spec.repos.map((r) => ({
    github: r.github,
    baseBranch: r.baseBranch || 'main',
    // PM-spawned dynamic agents can never confer auto-merge.
    autoMerge: false,
  }));
  if (repos.length === 0) {
    throw new Error(`Dynamic agent spec ${spec.id} has no repos`);
  }
  return {
    id: spec.id,
    key: spec.shortname,
    role: spec.role,
    expertise: spec.expertise,
    pluginName: '<dynamic>',
    // Dynamic agents are repo agents, so default them to opus like the
    // configured repo agents (which all set `model: opus` in frontmatter).
    // Without this they fell through spawn.ts's non-PM default to sonnet,
    // whose smaller context window overflowed on the large injected system
    // prompt — the failure mode seen in task-20260625-2243-dj79r4.
    model: 'opus',
    // PM-spawned agents are globally addressable across the task — they only
    // exist because PM created them on demand, so peers should be able to
    // reach them without a same-plugin relationship.
    visibility: 'global',
    repo: { repos, primary: repos[0].github },
  };
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
 *
 * @param team Optional roster to filter over. Defaults to the global registry;
 *   pass `task.team` so PM-spawned dynamic agents (which live only in the task
 *   team, not the registry) are reachable. When the task has no dynamic agents
 *   `task.team` equals the registry, so the default and override agree.
 */
export function getVisiblePeerIdsForSender(senderDef: AgentDef, team: AgentDef[] = registry): string[] {
  return team
    .filter((d) => !isPmAgent(d))
    .filter((d) => d.id !== senderDef.id)
    .filter((d) => d.pluginName === senderDef.pluginName || d.visibility === 'global')
    .map((d) => d.id);
}

/**
 * Build a formatted peer list for the sender's prompt, applying visibility rules.
 *
 * @param team Optional roster (see {@link getVisiblePeerIdsForSender}). Pass
 *   `task.team` to include PM-spawned dynamic agents.
 */
export function buildPeerListForSender(senderDef: AgentDef, team: AgentDef[] = registry): string {
  const visibleIds = new Set(getVisiblePeerIdsForSender(senderDef, team));

  const repoPeers = team
    .filter((d) => isRepoAgent(d) && visibleIds.has(d.id))
    .map((d) => `- ${d.id}: ${d.role} (${d.repo!.primary} repository)`);

  // Non-repo peers (visibleIds already excludes the PM).
  const pluginPeers = team
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
): Pick<AgentDef, 'mcpServers' | 'mcpDescriptions' | 'tools' | 'disallowedTools'> {
  const result: Pick<AgentDef, 'mcpServers' | 'mcpDescriptions' | 'tools' | 'disallowedTools'> = {};

  if (agent.mcpServers && agent.mcpServers.length > 0) {
    const resolved: Record<string, any> = {};
    const descriptions: Record<string, string> = {};
    for (const name of agent.mcpServers) {
      const config = rootMcp.servers[name];
      if (config) {
        resolved[name] = config;
        if (rootMcp.descriptions[name]) descriptions[name] = rootMcp.descriptions[name];
      } else {
        logger.warn('registry', `Agent "${agent.key}" references MCP server "${name}" not found in root .mcp.json`);
      }
    }
    if (Object.keys(resolved).length > 0) {
      result.mcpServers = resolved;
    }
    if (Object.keys(descriptions).length > 0) {
      result.mcpDescriptions = descriptions;
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
