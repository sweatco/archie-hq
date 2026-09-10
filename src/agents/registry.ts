/**
 * PM Agent Definition
 *
 * One task runs one agent — the PM — and its definition is engine-owned and
 * static apart from two things read from the plugins repo root: the MCP servers
 * of `.mcp.json` (all of them attach to the session) and the network allowlist
 * of `archie.json`. Everything a plugin contributes — skills, agents, commands,
 * hooks — is loaded natively by the SDK from the plugin directories, so nothing
 * here scans a plugin's contents any more.
 *
 * Built fresh on every task start/restart, so a plugins-repo change is picked
 * up by the next task without a restart.
 */

import type { AgentDef } from '../types/agent.js';
import { getRootMcpConfig, getArchieConfig } from '../system/plugin-loader.js';
import { logger } from '../system/logger.js';
import { deniedToolNames } from './tool-approval-gate.js';

// ---- Engine constants ----
//
// The PM's model and effort are engine-owned, not plugin-owned. The defaults
// are exactly what the `pm` plugin overlay resolved to before the flattening
// (`model: opus`, `effort: high`), so behaviour is unchanged out of the box.
// Max mode is likewise unchanged by default — the PM kept its normal model and
// effort under max mode before, and still does unless a deployment opts in.

const PM_MODEL = process.env.ARCHIE_PM_MODEL?.trim() || 'opus';
const PM_EFFORT = process.env.ARCHIE_PM_EFFORT?.trim() || 'high';
const PM_MAX_MODEL = process.env.ARCHIE_PM_MAX_MODEL?.trim() || PM_MODEL;
const PM_MAX_EFFORT = process.env.ARCHIE_PM_MAX_EFFORT?.trim() || PM_EFFORT;

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function asEffort(value: string): AgentDef['effort'] {
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return value as AgentDef['effort'];
  logger.warn('registry', `Unknown PM effort "${value}" — falling back to 'high'`);
  return 'high';
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
 * The PM AgentDef, built fresh from the current plugins-repo state. Used on
 * every task start/restart so a resumed task picks up config changes.
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
 * Declared per repo in the plugins repo's root `archie.json`
 * (`repos["owner/repo"].autoMerge`). Strict-boolean, so a repo that is absent,
 * or whose flag is anything but the literal `true`, goes through the existing
 * user-approval gate on every merge.
 */
export function isAutoMergeRepo(github: string): boolean {
  return getArchieConfig().repos[github]?.autoMerge === true;
}

// ---- Internal helpers ----

/**
 * The PM definition: static identity and model, plus the two things the
 * plugins repo root still decides.
 *
 * MCP is engine-owned and session-wide. Every server in `.mcp.json` attaches,
 * carrying its own `archie` policy with it, and those policies are unioned into
 * one session policy — `deny` tiers become `disallowedTools` here, `ask` tiers
 * attach the PreToolUse approval gate in `spawn.ts`. There is no per-agent
 * subsetting left to do: there is only one agent.
 */
function buildPmDef(): AgentDef {
  const rootMcp = getRootMcpConfig();
  const denied = deniedToolNames(rootMcp.policies);

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    model: PM_MODEL,
    effort: asEffort(PM_EFFORT),
    maxMode: { model: PM_MAX_MODEL, effort: asEffort(PM_MAX_EFFORT) },
    isPm: true,
    pluginName: 'core',
    visibility: 'global',
    mcpServers: rootMcp.servers,
    mcpDescriptions: rootMcp.descriptions,
    ...(Object.keys(rootMcp.policies).length > 0 ? { mcpPolicy: rootMcp.policies } : {}),
    ...(denied.length > 0 ? { disallowedTools: denied } : {}),
    allowedNetworkDomains: getArchieConfig().allowedNetworkDomains,
  };
}
