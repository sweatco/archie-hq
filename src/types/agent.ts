/**
 * Agent-related type definitions
 */

import type { AgentName, TaskMetadata } from './task.js';

export interface AgentMessage {
  from: AgentName;
  to: AgentName;
  content: string;
  timestamp: string;
}

export interface AgentContext {
  taskId: string;
  metadata: TaskMetadata;
  isTaskOwner: boolean;
  sharedKnowledgePath: string;
}

export interface SendMessageToAgentParams {
  target: AgentName;
  message: string;
}

export interface LogFindingParams {
  entry: string;
  type: 'discovery' | 'decision' | 'completion' | 'blocker';
}

export interface PostToSlackParams {
  message: string;
}

export interface AskUserParams {
  question: string;
  options?: string[];
}

export type AgentModel = 'claude-sonnet-4-5-20250514' | 'claude-haiku-4-5-20250514';

export interface AgentConfig {
  name: AgentName;
  model: AgentModel;
  systemPrompt: string;
}

/**
 * Handle to a running agent
 * Allows checking if agent is running and stopping it
 */
export interface AgentHandle {
  /** Promise that resolves when the agent finishes processing */
  running: Promise<void>;
  /** Whether the agent is still processing messages */
  isRunning: boolean;
}

/**
 * Repo-specific fields (present only when the agent has repo access attached)
 */
export interface AgentRepoDef {
  /** GitHub repository identifier, e.g., 'sweatco/backend' */
  githubRepo: string;
  /** Base branch for PRs and merges. Defaults to 'main' if not specified. */
  baseBranch?: string;
  /** Default repository path on disk */
  defaultPath: string;
  /** Key in TaskMetadata.repositories, e.g., 'backend', 'mobile' */
  repoKey: string;
}

/**
 * PM-specific fields (present only on the PM coordinator agent)
 */
export interface AgentPmDef {
  /** Formatted team list for prompt template */
  teamList: string;
  /** Formatted team expertise for prompt template */
  teamExpertise: string;
}

/**
 * Unified agent definition — replaces RepoAgentConfig + PluginAgentConfig
 *
 * Scanned fresh from plugins at startup and on every task start/restart.
 * There is a single kind of agent; capabilities are additive:
 *   - repo access is attached when `repo` is set
 *   - the PM coordinator is the one agent with `isPm` set (overlaid by the pm plugin)
 */
export interface AgentDef {
  /** Unique agent identifier, e.g., 'backend-agent', 'pm-agent' */
  id: string;

  /** Short key, e.g., 'backend', 'copywriter' */
  key: string;

  /** Short role description */
  role: string;

  /** Detailed expertise */
  expertise: string;

  /** Model override (default: opus for PM, sonnet otherwise) */
  model?: string;

  /** Reasoning effort level (default: 'high') */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Maximum agentic turns before stopping (default: 100) */
  maxTurns?: number;

  /** True only for the PM coordinator agent (the core agent overlaid by the pm plugin) */
  isPm?: boolean;

  /** Plugin name this agent belongs to */
  pluginName: string;

  /**
   * Addressing scope.
   * - 'global': any agent (in any plugin) can address this agent and PM can dispatch to it.
   * - 'local': only same-plugin agents can address it via send_message_to_agent.
   *   Repo agents marked 'local' still receive webhook-routed events (external entry).
   */
  visibility: 'global' | 'local';

  /** Domain-specific prompt body (Layer 3) from agents/<key>.md */
  agentPrompt?: string;

  /** Repo-specific fields — set only when the agent has repo access */
  repo?: AgentRepoDef;

  /** Absolute path to plugin directory (not set on the PM coordinator) */
  pluginPath?: string;

  /** Absolute path to plugin's persistent data directory (workdir/plugins-data/<name>/) */
  pluginDataPath?: string;

  /** Absolute path to plugin's skills/ directory */
  skillsPath?: string;

  /** Absolute path to archie-hq's built-in skills/ directory (PM only). Symlinked alongside plugin skills. */
  coreSkillsPath?: string;

  /** PM-specific fields (PM only) — built dynamically from team */
  pmConfig?: AgentPmDef;

  /** Extra prompt from pm plugin overlay (PM only) */
  pmOverlayPrompt?: string;

  /** MCP server configs resolved from plugin's .mcp.json (server name → config) */
  mcpServers?: Record<string, any>;

  /** Additional tools to allow (from agent frontmatter) */
  tools?: string[];

  /** Tools to disallow (from agent frontmatter) */
  disallowedTools?: string[];

  /** Sandbox outbound-network whitelist (from agent frontmatter). Empty/undefined = deny all. */
  allowedNetworkDomains?: string[];

  /** Plugin hooks config (from plugin's hooks/hooks.json), written to .claude/settings.json */
  pluginHooks?: Record<string, any>;
}

// ---- Capability predicates ----
//
// There is one kind of agent: a plain agent is the default. What it can do on
// top of that is derived from its def:
//   - a repo agent is any agent with repo access attached
//   - the PM coordinator is the single agent with `isPm`

/** True when the agent has repository access attached. */
export function isRepoAgent(def: AgentDef): boolean {
  return def.repo != null;
}

/** True for the PM coordinator (the core agent overlaid by the pm plugin). */
export function isPmAgent(def: AgentDef): boolean {
  return def.isPm === true;
}
