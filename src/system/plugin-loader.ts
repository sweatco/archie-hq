/**
 * Plugin Loader
 *
 * The SDK loads plugins natively now: every plugin directory is handed to
 * `query()` through the `plugins` option, and the Claude Agent SDK reads its
 * skills, agents, commands and hooks itself. So this module no longer parses
 * anything *inside* a plugin. What it still owns is what the SDK does not:
 *
 *   - enumerating which top-level directories of the plugins repo are plugins
 *     (a directory with `.claude-plugin/plugin.json`),
 *   - the root `.mcp.json`, with `${MCP_*}` interpolation and the two Archie
 *     extensions (`description`, `archie`) split out before the config reaches
 *     the SDK — MCP stays engine-owned, which is why every plugin is passed
 *     with `skipMcpDiscovery`,
 *   - the root `archie.json`, the one engine-level config surface the plugins
 *     repo has: the sandbox network allowlist and per-repo warm/auto-merge
 *     flags.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { mcpToolName, parseMcpToolName, type McpToolPolicy, type McpServerPolicy, type ToolTier } from '../agents/tool-approval-gate.js';
import { PLUGINS_DIR } from './workdir.js';
import { logger } from './logger.js';

export { PLUGINS_DIR };

/** Parsed root .mcp.json — server connection configs plus Archie extensions */
export interface LoadedMcpConfig {
  servers: Record<string, any>;
  /**
   * Human-readable description per server, taken from an optional `description`
   * key on each server entry. Stripped from `servers` so the Claude Agent SDK
   * only ever receives valid connection config. Used to phrase the Slack status
   * line for an integration call (see `src/agents/activity.ts`).
   */
  descriptions: Record<string, string>;
  /**
   * Tool approval policy per server, from an optional `archie` key on each
   * server entry. Also stripped from `servers`. Absent for a server that
   * declares none — such a server is unmanaged and behaves as it did before
   * the gate existed. See agents/tool-approval-gate.ts.
   */
  policies: McpToolPolicy;
}

const TIERS: ToolTier[] = ['allow', 'ask', 'deny'];
const HOST_OWNED_MCP_SERVER_NAMES = new Set([
  'agent-tools',
  'comms-tools',
  'orchestration-tools',
  'scheduling-tools',
  'repo-tools',
  'research-tools',
  'file-bridge',
  'memory-tools',
]);

/**
 * Parse and validate one server's `archie` block from .mcp.json.
 *
 * ```json
 * "tramline": {
 *   "command": "…",
 *   "archie": {
 *     "_comment": "why this server is tiered the way it is",
 *     "default": "ask",              // tier for tools not listed (default: ask)
 *     "allow": ["get_release"],      // runs ungated
 *     "ask":   ["extend_soak"],      // needs a per-call human approval
 *     "deny":  ["start_release"],    // withheld from the session
 *     "titles": {                    // optional approver-facing button text
 *       "extend_soak": "Extend the beta soak, delaying the production rollout"
 *     }
 *   }
 * }
 * ```
 *
 * Throws rather than dropping a malformed policy: this block decides which
 * external mutations need a human, so a silently-ignored typo must not
 * reclassify a tool. Unknown keys are rejected for the same reason — a
 * misspelled tier name would otherwise read as "nothing listed". A key with a
 * leading underscore is the one exception: it is an explicit comment marker,
 * not a plausible typo of a tier, and policy blocks are where the reasoning for
 * a denial belongs.
 */
function parseServerPolicy(serverKey: string, raw: unknown, path: string): McpServerPolicy {
  const where = `MCP config ${path}: server "${serverKey}" archie policy`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object.`);
  }
  const entry = raw as Record<string, unknown>;

  // The gate finds the policy by splitting the SDK's `mcp__<server>__<tool>`
  // name back into its parts, and a key containing `__` (or a leading/trailing
  // `_`) does not survive that round trip: the split yields a different server
  // name, no policy is found, and every tool of this server runs UNGATED. That
  // is the exact failure the strict parsing here exists to prevent, so refuse
  // the key rather than load a policy that cannot be enforced.
  if (parseMcpToolName(mcpToolName(serverKey, 'probe'))?.server !== serverKey) {
    throw new Error(
      `${where}: server key "${serverKey}" cannot carry a policy — it does not survive ` +
      `the mcp__<server>__<tool> round trip (no "__", no leading or trailing "_"), so the ` +
      `gate would never match its calls. Rename the server.`,
    );
  }

  const allowedKeys = new Set(['default', 'titles', ...TIERS]);
  for (const key of Object.keys(entry)) {
    if (key.startsWith('_')) continue;
    if (!allowedKeys.has(key)) {
      throw new Error(`${where}: unknown key "${key}" — expected one of default, ${TIERS.join(', ')}, titles, or a "_"-prefixed comment.`);
    }
  }

  const fallback = entry.default ?? 'ask';
  if (!TIERS.includes(fallback as ToolTier)) {
    throw new Error(`${where}.default must be one of ${TIERS.join(', ')} — got ${JSON.stringify(fallback)}.`);
  }

  const tiers: Record<string, ToolTier> = {};
  for (const tier of TIERS) {
    const list = entry[tier];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error(`${where}.${tier} must be a list of tool names.`);
    }
    for (const tool of list as string[]) {
      const name = tool.trim();
      if (tiers[name] && tiers[name] !== tier) {
        throw new Error(`${where}: tool "${name}" appears in both ${tiers[name]} and ${tier}.`);
      }
      tiers[name] = tier;
    }
  }

  const titles: Record<string, string> = {};
  if (entry.titles !== undefined) {
    if (!entry.titles || typeof entry.titles !== 'object' || Array.isArray(entry.titles)) {
      throw new Error(`${where}.titles must be a map of tool name to button text.`);
    }
    for (const [tool, title] of Object.entries(entry.titles as Record<string, unknown>)) {
      if (typeof title !== 'string' || !title.trim()) {
        throw new Error(`${where}.titles.${tool} must be a non-empty string.`);
      }
      titles[tool.trim()] = title.trim();
    }
  }

  return { default: fallback as ToolTier, tiers, titles };
}

/**
 * Load and parse an .mcp.json file, substituting ${MCP_*} env vars.
 * Returns pure server connection configs plus the two Archie extensions
 * (`description`, `archie`), pulled out so they never reach the SDK.
 *
 * A syntactically broken file degrades to "no servers" with a warning, as it
 * always has. A *malformed policy* throws instead: dropping it would silently
 * ungate a tool someone meant to gate.
 */
export function loadMcpJson(path: string): LoadedMcpConfig {
  const empty: LoadedMcpConfig = { servers: {}, descriptions: {}, policies: {} };
  if (!existsSync(path)) return empty;

  let rawServers: Record<string, any>;
  try {
    const raw = readFileSync(path, 'utf-8');
    const substituted = raw.replace(/\$\{(MCP_[A-Z0-9_]+)\}/g, (_, name) => {
      const value = process.env[name];
      if (!value) logger.warn('system', `MCP config: env var ${name} is not set (${path})`);
      return value ?? '';
    });
    rawServers = JSON.parse(substituted).mcpServers ?? {};
  } catch {
    logger.warn('system', `MCP config: failed to parse ${path}`);
    return empty;
  }

  const servers: Record<string, any> = {};
  const descriptions: Record<string, string> = {};
  const policies: McpToolPolicy = {};
  for (const [name, config] of Object.entries(rawServers)) {
    if (HOST_OWNED_MCP_SERVER_NAMES.has(name) || name.includes('__')) {
      logger.warn('system', `MCP config ${path}: reserved server key "${name}" refused`);
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      servers[name] = config;
      continue;
    }
    // `description` and `archie` are Archie metadata, not connection config —
    // split them out so the SDK only sees valid server fields.
    const { description, archie, ...connectionConfig } = config as Record<string, any>;
    if (typeof description === 'string' && description.trim()) {
      descriptions[name] = description.trim();
    }
    if (archie !== undefined) {
      policies[name] = parseServerPolicy(name, archie, path);
    }
    servers[name] = connectionConfig;
  }

  return { servers, descriptions, policies };
}

// ---- Root engine config (archie.json) ----

/** Per-repo flags from `archie.json`'s `repos` map, keyed by `owner/repo`. */
export interface ArchieRepoConfig {
  /** May Archie merge this repo's PRs without a per-merge human approval? */
  autoMerge?: boolean;
  /** Warm the base clone at startup, so the first `mount_repo` is cheap. */
  warm?: boolean;
}

/**
 * The plugins repo's root `archie.json` — the only engine-level config surface
 * plugins have. Everything else a plugin contributes is loaded natively by the
 * SDK from the plugin directory itself.
 */
export interface ArchieConfig {
  /** Hostnames the sandbox may reach outbound from Bash. Empty = deny all. */
  allowedNetworkDomains: string[];
  /** Per-repo flags, keyed by the `owner/repo` GitHub identifier. */
  repos: Record<string, ArchieRepoConfig>;
}

const EMPTY_ARCHIE_CONFIG: ArchieConfig = { allowedNetworkDomains: [], repos: {} };

/**
 * Read `$ARCHIE_WORKDIR/plugins/archie.json`. A missing file means the empty
 * config — no allowlisted domains, no warm repos, no auto-merge — which is the
 * safe direction for all three. A malformed one degrades the same way with a
 * warning rather than blocking startup; unknown keys are ignored.
 *
 * Loaded fresh on each call (like {@link getRootMcpConfig}) so a plugins-repo
 * refresh is picked up by the next task without a restart.
 */
export function getArchieConfig(): ArchieConfig {
  const path = join(PLUGINS_DIR, 'archie.json');
  if (!existsSync(path)) return EMPTY_ARCHIE_CONFIG;

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    logger.warn('system', `archie.json: failed to parse ${path} — treating as empty`);
    return EMPTY_ARCHIE_CONFIG;
  }

  const allowedNetworkDomains = Array.isArray(raw?.allowedNetworkDomains)
    ? raw.allowedNetworkDomains.filter((d: unknown): d is string => typeof d === 'string' && d.length > 0)
    : [];

  const repos: Record<string, ArchieRepoConfig> = {};
  if (raw?.repos && typeof raw.repos === 'object' && !Array.isArray(raw.repos)) {
    for (const [github, entry] of Object.entries(raw.repos as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      // Strict-boolean parse on both flags: only the literal `true` opts in, so
      // a typo ("true", 1, yes) fails safe to manual merges and no warm clone.
      repos[github] = { autoMerge: e.autoMerge === true, warm: e.warm === true };
    }
  }

  return { allowedNetworkDomains, repos };
}

// ---- Plugin directory enumeration ----

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
}

export interface LoadedPlugin {
  /** Plugin name from the manifest — what the SDK namespaces its skills under. */
  name: string;
  /** Absolute path to the plugin directory, passed to the SDK `plugins` option. */
  dir: string;
  /** Parsed .claude-plugin/plugin.json */
  manifest: PluginManifest;
}

/**
 * Scan the plugins directory for plugin directories.
 * Only directories with a valid .claude-plugin/plugin.json are loaded.
 * Called at startup and on every plugins-repo refresh (sync reads are fine).
 */
function scanPlugins(): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];

  if (!existsSync(PLUGINS_DIR)) {
    return plugins;
  }

  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const pluginDir = join(PLUGINS_DIR, entry.name);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    let manifest: PluginManifest;
    try {
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (!raw.name || !raw.version || !raw.description) {
        logger.warn('system', `Plugin ${entry.name}: plugin.json missing required fields (name, version, description), skipping`);
        continue;
      }
      manifest = { name: raw.name, version: raw.version, description: raw.description };
    } catch {
      logger.warn('system', `Plugin ${entry.name}: failed to parse plugin.json, skipping`);
      continue;
    }

    plugins.push({ name: manifest.name, dir: pluginDir, manifest });
  }

  return plugins;
}

// Initialized by initPlugins(), called from main() at startup
let loadedPlugins: LoadedPlugin[] = [];

/**
 * Initialize plugin loader. Must be called after bootstrapWorkdir().
 */
export function initPlugins(): void {
  loadedPlugins = scanPlugins();
}

/**
 * Get root-level MCP config (from PLUGINS_DIR/.mcp.json).
 * Loaded fresh each call so config changes are picked up.
 * Every server in it attaches to the PM session.
 */
export function getRootMcpConfig(): LoadedMcpConfig {
  return loadMcpJson(join(PLUGINS_DIR, '.mcp.json'));
}

/**
 * Every plugin directory found in the plugins repo. Handed to the SDK
 * `plugins` option at spawn.
 */
export function getPlugins(): LoadedPlugin[] {
  return loadedPlugins;
}
