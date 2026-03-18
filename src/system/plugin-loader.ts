/**
 * Plugin Loader
 *
 * Scans the plugins directory and loads plugin metadata.
 * Each plugin is a directory under plugins/ that may contain:
 *   - repo-config.json  — repo agent infrastructure configs
 *   - agents/*.md       — agent prompts with frontmatter (role, expertise)
 *   - skills/           — skill directories (each subdir has SKILL.md)
 *   - .claude-plugin/plugin.json — optional plugin metadata
 *
 * MCP servers are configured in a single root .mcp.json at the plugins directory root.
 * Individual agents reference server names via frontmatter `mcpServers: [...]`.
 *
 * A special "pm" plugin can provide an overlay for the PM agent:
 *   - agents/pm.md body is appended to the PM's hardcoded prompt
 *   - frontmatter mcpServers/tools/disallowedTools configure PM's MCP access
 *
 * Consumers (repo-configs, task-manager) pull what they need from loaded plugins.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { PLUGINS_DIR } from './workdir.js';
import { logger } from './logger.js';

export { PLUGINS_DIR };

/** Parsed root .mcp.json — server connection configs only */
export interface LoadedMcpConfig {
  servers: Record<string, any>;
}

/**
 * Load and parse an .mcp.json file, substituting ${MCP_*} env vars.
 * Returns pure server connection configs. Tool permissions are controlled
 * by agent frontmatter, not by .mcp.json.
 */
export function loadMcpJson(path: string): LoadedMcpConfig {
  const empty: LoadedMcpConfig = { servers: {} };
  if (!existsSync(path)) return empty;
  try {
    const raw = readFileSync(path, 'utf-8');
    const substituted = raw.replace(/\$\{(MCP_[A-Z0-9_]+)\}/g, (_, name) => {
      const value = process.env[name];
      if (!value) logger.warn('system', `MCP config: env var ${name} is not set (${path})`);
      return value ?? '';
    });
    const parsed = JSON.parse(substituted);
    const rawServers: Record<string, any> = parsed.mcpServers ?? {};

    const servers: Record<string, any> = {};
    for (const [name, config] of Object.entries(rawServers)) {
      servers[name] = config;
    }

    return { servers };
  } catch {
    logger.warn('system', `MCP config: failed to parse ${path}`);
    return empty;
  }
}

export interface PluginRepoConfig {
  githubRepo: string;
  baseBranch?: string;
  repoPath?: string;
  prompt: string;
}

export interface PluginAgentDef {
  /** Filename without .md, e.g., 'copywriter' */
  key: string;
  /** From frontmatter */
  role: string;
  /** From frontmatter */
  expertise: string;
  /** Optional model override from frontmatter */
  model?: string;
  /** Markdown body (domain-specific instructions) */
  prompt: string;
  /** Repo metadata from frontmatter (if present, agent is a repo agent) */
  repo?: {
    github: string;
    baseBranch?: string;
  };
  /** MCP server names this agent should have access to (from plugin's .mcp.json) */
  mcpServers?: string[];
  /** Tool allowlist from frontmatter */
  tools?: string[];
  /** Tool denylist from frontmatter */
  disallowedTools?: string[];
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  /** Parsed repo-config.json if present (legacy, kept for reference) */
  repoConfigs: Record<string, PluginRepoConfig> | null;
  /** Agent definitions from agents/*.md — repo or plugin track based on frontmatter */
  agents: PluginAgentDef[];
  /** Absolute path to skills/ directory (null if none) */
  skillsPath: string | null;
}

/**
 * Scan plugins directory and load all plugins.
 * A plugin is any subdirectory of PLUGINS_DIR.
 * Called once at startup (sync reads are fine).
 */
function scanPlugins(): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];

  if (!existsSync(PLUGINS_DIR)) {
    return plugins;
  }

  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const pluginName = entry.name;
    const pluginDir = join(PLUGINS_DIR, pluginName);

    // Load repo-config.json if present
    let repoConfigs: Record<string, PluginRepoConfig> | null = null;
    const repoConfigPath = join(pluginDir, 'repo-config.json');
    if (existsSync(repoConfigPath)) {
      repoConfigs = JSON.parse(readFileSync(repoConfigPath, 'utf-8'));
    }

    // Scan agents/*.md for all plugins
    const agents: PluginAgentDef[] = [];
    const agentsDir = join(pluginDir, 'agents');
    if (existsSync(agentsDir)) {
      for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!agentEntry.isFile() || !agentEntry.name.endsWith('.md')) continue;

        const key = agentEntry.name.replace(/\.md$/, '');
        const agentContent = readFileSync(join(agentsDir, agentEntry.name), 'utf-8');
        const { data, content } = matter(agentContent);

        const agentDef: PluginAgentDef = {
          key,
          role: data.role || '',
          expertise: data.expertise || '',
          model: data.model || undefined,
          prompt: content.trim(),
        };

        // If frontmatter has repo metadata, this is a repo agent
        const repoMeta = data.metadata?.archie?.repo;
        if (repoMeta && typeof repoMeta === 'object' && repoMeta.github) {
          agentDef.repo = {
            github: repoMeta.github,
            baseBranch: repoMeta.baseBranch || undefined,
          };
        }

        // MCP servers and tool permissions from frontmatter
        if (Array.isArray(data.mcpServers)) {
          agentDef.mcpServers = data.mcpServers;
        }
        if (Array.isArray(data.tools)) {
          agentDef.tools = data.tools;
        }
        if (Array.isArray(data.disallowedTools)) {
          agentDef.disallowedTools = data.disallowedTools;
        }

        agents.push(agentDef);
      }
    }

    // Check for skills/ directory (agent craft skills)
    const skillsDir = join(pluginDir, 'skills');
    const hasSkills = existsSync(skillsDir);


    plugins.push({
      name: pluginName,
      dir: pluginDir,
      repoConfigs,
      agents,
      skillsPath: hasSkills ? skillsDir : null,
    });
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
 * All agents resolve their MCP servers from this single config.
 */
export function getRootMcpConfig(): LoadedMcpConfig {
  return loadMcpJson(join(PLUGINS_DIR, '.mcp.json'));
}

/**
 * Get all loaded plugins
 */
export function getPlugins(): LoadedPlugin[] {
  return loadedPlugins;
}

/**
 * Get plugins that have repo agent configs
 */
export function getPluginsWithRepoConfigs(): LoadedPlugin[] {
  return loadedPlugins.filter((p) => p.repoConfigs !== null);
}

/**
 * Get the PM plugin overlay (agents/pm.md from the "pm" plugin).
 * Returns the parsed agent def if found, or null.
 */
export function getPmOverlay(): PluginAgentDef | null {
  const pmPlugin = loadedPlugins.find((p) => p.name === 'pm');
  if (!pmPlugin) return null;
  const pmAgent = pmPlugin.agents.find((a) => a.key === 'pm');
  return pmAgent || null;
}
