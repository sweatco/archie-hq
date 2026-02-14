/**
 * Plugin Agent configuration type
 *
 * Defines the specialization for a generic plugin agent.
 * Plugin agents are lightweight, read-only agents for domains
 * that don't need git/worktree/GitHub infrastructure.
 */

export interface PluginAgentConfig {
  /** Unique agent identifier, e.g., 'copywriter-agent' */
  agentId: string;

  /** Key from filename without .md, e.g., 'copywriter' */
  key: string;

  /** Short role description, e.g., 'Senior copywriter' */
  role: string;

  /** Detailed expertise, e.g., 'Ad copy, landing pages, email campaigns' */
  expertise: string;

  /** Markdown body from agent definition file (domain-specific instructions) */
  prompt: string;

  /** Optional model override from frontmatter */
  model?: string;

  /** Plugin name, e.g., 'marketing' (from plugin.json or directory name) */
  pluginName: string;

  /** Absolute path to plugin directory */
  pluginPath: string;

  /** Absolute path to plugin's skills/ directory (if exists) */
  skillsPath?: string;
}
