/**
 * Plugin Loader
 *
 * Scans the plugins directory and loads plugin metadata.
 * Each plugin is a directory under plugins/ that may contain:
 *   - repo-config.json  — repo agent infrastructure configs
 *   - agents/*.md       — agent prompts with frontmatter (role, expertise)
 *   - pm-skills/        — PM skill directories (each subdir has SKILL.md)
 *   - .claude-plugin/plugin.json — optional plugin metadata
 *
 * Consumers (repo-configs, task-manager) pull what they need from loaded plugins.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

export const PLUGINS_DIR = join(process.cwd(), process.env.ARCHIE_PLUGINS_DIR || 'plugins');

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
}

export interface PmSkillEntry {
  /** Namespaced skill name: {pluginName}-{skillDirName}, e.g. "engineering-workflow" */
  namespacedName: string;
  /** Absolute path to the skill source directory */
  sourcePath: string;
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  /** Parsed repo-config.json if present — keyed by agent key (e.g. "backend") */
  repoConfigs: Record<string, PluginRepoConfig> | null;
  /** PM skills with namespaced names and source paths */
  pmSkills: PmSkillEntry[];
  /** Generic plugin agent definitions (only for plugins WITHOUT repo-config.json) */
  agents: PluginAgentDef[];
  /** Absolute path to skills/ directory (for agent craft skills) */
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
    if (!entry.isDirectory()) continue;

    const pluginName = entry.name;
    const pluginDir = join(PLUGINS_DIR, pluginName);

    // Load repo-config.json if present
    let repoConfigs: Record<string, PluginRepoConfig> | null = null;
    const repoConfigPath = join(pluginDir, 'repo-config.json');
    if (existsSync(repoConfigPath)) {
      repoConfigs = JSON.parse(readFileSync(repoConfigPath, 'utf-8'));
    }

    // Check for pm-skills/ directory and build namespaced skill entries
    const pmSkillsDir = join(pluginDir, 'pm-skills');
    const pmSkills: PmSkillEntry[] = [];
    if (existsSync(pmSkillsDir)) {
      for (const skillEntry of readdirSync(pmSkillsDir, { withFileTypes: true })) {
        if (skillEntry.isDirectory()) {
          pmSkills.push({
            namespacedName: `${pluginName}-${skillEntry.name}`,
            sourcePath: join(pmSkillsDir, skillEntry.name),
          });
        }
      }
    }

    // Scan agents/*.md for generic plugins (plugins WITHOUT repo-config.json)
    const agents: PluginAgentDef[] = [];
    if (!repoConfigs) {
      const agentsDir = join(pluginDir, 'agents');
      if (existsSync(agentsDir)) {
        for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agentEntry.isFile() || !agentEntry.name.endsWith('.md')) continue;

          const key = agentEntry.name.replace(/\.md$/, '');
          const agentContent = readFileSync(join(agentsDir, agentEntry.name), 'utf-8');
          const { data, content } = matter(agentContent);

          agents.push({
            key,
            role: data.role || '',
            expertise: data.expertise || '',
            model: data.model || undefined,
            prompt: content.trim(),
          });
        }
      }
    }

    // Check for skills/ directory (agent craft skills)
    const skillsDir = join(pluginDir, 'skills');
    const hasSkills = existsSync(skillsDir);

    plugins.push({
      name: pluginName,
      dir: pluginDir,
      repoConfigs,
      pmSkills,
      agents,
      skillsPath: hasSkills ? skillsDir : null,
    });
  }

  return plugins;
}

// Load at module initialization
const loadedPlugins = scanPlugins();

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
 * Get plugins that have PM skills
 */
export function getPluginsWithPmSkills(): LoadedPlugin[] {
  return loadedPlugins.filter((p) => p.pmSkills.length > 0);
}
