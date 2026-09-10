/**
 * PM Agent Definition
 *
 * One task runs one agent — the PM — so this module builds exactly one
 * `AgentDef`. Everything else a plugin contributes (skills and agent files) is
 * loaded natively by the SDK from the plugin directories; the engine no longer
 * scans agent frontmatter, builds repo/plugin agent definitions, or computes
 * peer visibility.
 *
 * Scanned fresh at startup and re-scanned by `syncPlugins()` after the plugins
 * repo moves, so a changed overlay is picked up by the next task.
 */

import type { AgentDef } from '../types/agent.js';
import { getRootMcpConfig, getPlugins, getPmOverlay, type LoadedMcpConfig, type PluginAgentDef } from '../system/plugin-loader.js';
import { PLUGINS_DATA_DIR } from '../system/workdir.js';
import { join } from 'path';
import { logger } from '../system/logger.js';
import { resolveSkillPaths } from './core-skills.js';
import { deniedToolNames, type McpToolPolicy } from './tool-approval-gate.js';

// ---- Engine constants ----
//
// The PM's model and effort are engine-owned, not plugin-owned. The defaults
// are exactly what the `pm` plugin overlay resolved to before the flattening
// (`model: opus`, `effort: medium`), so behaviour is unchanged out of the box.
// Max mode is likewise unchanged by default — the PM kept its normal model and
// effort under max mode before, and still does unless a deployment opts in.

const PM_MODEL = process.env.ARCHIE_PM_MODEL?.trim() || 'opus';
const PM_EFFORT = process.env.ARCHIE_PM_EFFORT?.trim() || 'medium';
const PM_MAX_MODEL = process.env.ARCHIE_PM_MAX_MODEL?.trim() || PM_MODEL;
const PM_MAX_EFFORT = process.env.ARCHIE_PM_MAX_EFFORT?.trim() || PM_EFFORT;

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function asEffort(value: string): AgentDef['effort'] {
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return value as AgentDef['effort'];
  logger.warn('registry', `Unknown PM effort "${value}" — falling back to 'medium'`);
  return 'medium';
}

// ---- Module state ----

let pmDef: AgentDef | undefined;

// ---- Public API ----

/**
 * Initialize the registry. Must be called after initPlugins().
 * Rebuilds the PM definition from the current plugin state.
 */
export function initRegistry(): void {
  pmDef = buildPmDef();
}

/**
 * The PM AgentDef, built fresh from the current plugin state. Used on every
 * task start/restart so a resumed task picks up overlay changes.
 */
export function scanPmDef(): AgentDef {
  return buildPmDef();
}

/**
 * The cached PM AgentDef. Built lazily if `initRegistry()` has not run (tests,
 * and any path that reaches an agent before startup finishes).
 */
export function getPmDef(): AgentDef {
  pmDef ??= buildPmDef();
  return pmDef;
}

/**
 * Every AgentDef the engine knows about — the PM, and only the PM. Retained as
 * a list so startup logging and any roster consumer keeps working.
 */
export function getAllAgentDefs(): AgentDef[] {
  return [getPmDef()];
}

/**
 * Test-only: override the cached PM definition. Do not call from production code.
 */
export function __setPmDefForTesting(def: AgentDef | undefined): void {
  pmDef = def;
}

/**
 * Merge policy for a repo: may Archie merge its PRs without asking the user?
 *
 * TODO(flat): W2-spawn wires this to `repos[*].autoMerge` in the plugins repo's
 * root `archie.json`. Until then no repo is auto-merge, which is the safe
 * direction: every merge goes through the existing user-approval gate.
 */
export function isAutoMergeRepo(_github: string): boolean {
  return false;
}

// ---- Internal helpers ----

/**
 * Resolve the PM's mcpServers references against the root .mcp.json.
 *
 * Tool permission rules:
 * - No `tools` defined → every tool is available (bypassPermissions), minus denials
 * - `tools` defined → use exactly what's listed
 * - `disallowedTools` → always applied on top, and the servers' own `deny`-tier
 *   tools are appended to it, so a tool disabled once in .mcp.json is withheld
 *   rather than re-listed per agent
 *
 * The tool approval policy travels with the server, not the agent: mounting
 * `tramline` brings its `archie` block along.
 */
function resolveAgentMcpServers(
  agent: PluginAgentDef,
  rootMcp: LoadedMcpConfig,
): Pick<AgentDef, 'mcpServers' | 'mcpDescriptions' | 'mcpPolicy' | 'tools' | 'disallowedTools'> {
  const result: Pick<AgentDef, 'mcpServers' | 'mcpDescriptions' | 'mcpPolicy' | 'tools' | 'disallowedTools'> = {};

  if (agent.mcpServers && agent.mcpServers.length > 0) {
    const resolved: Record<string, any> = {};
    const descriptions: Record<string, string> = {};
    const policy: McpToolPolicy = {};
    for (const name of agent.mcpServers) {
      const config = rootMcp.servers[name];
      if (config) {
        resolved[name] = config;
        if (rootMcp.descriptions[name]) descriptions[name] = rootMcp.descriptions[name];
        if (rootMcp.policies[name]) policy[name] = rootMcp.policies[name];
      } else {
        logger.warn('registry', `PM overlay references MCP server "${name}" not found in root .mcp.json`);
      }
    }
    if (Object.keys(resolved).length > 0) {
      result.mcpServers = resolved;
    }
    if (Object.keys(descriptions).length > 0) {
      result.mcpDescriptions = descriptions;
    }
    if (Object.keys(policy).length > 0) {
      result.mcpPolicy = policy;
    }
  }

  // Only pass tools when explicitly defined in the overlay frontmatter.
  // With bypassPermissions, all tools (built-in + MCP) are available by default —
  // def.tools restricts the set, so auto-generating MCP wildcards would kill built-ins.
  if (agent.tools && agent.tools.length > 0) {
    result.tools = agent.tools;
  }

  // Frontmatter denials plus every `deny`-tier tool of the servers mounted.
  // Deduped: a plugin migrating to .mcp.json policies may still list a tool in
  // both places for a while.
  const disallowed = [
    ...(agent.disallowedTools ?? []),
    ...(result.mcpPolicy ? deniedToolNames(result.mcpPolicy) : []),
  ];
  if (disallowed.length > 0) {
    result.disallowedTools = [...new Set(disallowed)];
  }

  return result;
}

/**
 * TODO(flat): W2-spawn replaces the overlay read entirely — every plugin
 * directory (including `pm`) goes through the SDK `plugins` option, and the
 * root MCP config attaches to the session as a whole rather than through the
 * overlay's `mcpServers` list.
 */
function buildPmDef(): AgentDef {
  const rootMcp = getRootMcpConfig();
  const pmPlugin = getPlugins().find((p) => p.name === 'pm');
  const overlay = getPmOverlay();
  const resolvedMcp = overlay ? resolveAgentMcpServers(overlay, rootMcp) : {};

  const describeServer = (name: string): string => {
    const desc = rootMcp.descriptions[name];
    return desc ? `${name} (${desc})` : name;
  };

  // The PM has no roster to annotate any more, but it still needs to know what
  // it can reach itself — otherwise it tells a user that checking Jira /
  // Rollbar / the admin panel isn't possible.
  const pmServerNames = resolvedMcp.mcpServers ? Object.keys(resolvedMcp.mcpServers) : [];
  const pmIntegrations = pmServerNames.length > 0
    ? `You can query these external systems directly: ${pmServerNames.map(describeServer).join('; ')}.`
    : '';

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    model: PM_MODEL,
    effort: asEffort(PM_EFFORT),
    maxMode: { model: PM_MAX_MODEL, effort: asEffort(PM_MAX_EFFORT) },
    maxTurns: overlay?.maxTurns,
    isPm: true,
    pluginName: 'pm',
    visibility: 'global',
    pluginDataPath: join(PLUGINS_DATA_DIR, 'pm'),
    pmConfig: { pmIntegrations },
    pmOverlayPrompt: overlay?.prompt || undefined,
    skillPaths: resolveSkillPaths('pm', pmPlugin?.skillsPath || undefined),
    pluginHooks: pmPlugin?.hooks || undefined,
    ...resolvedMcp,
  };
}
