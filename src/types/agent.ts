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
 * Agent track — determines spawning behavior, tools, and CWD
 */
export type AgentTrack = 'pm' | 'repo' | 'plugin';

/**
 * Repo-specific fields (only for track='repo')
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
 * PM-specific fields (only for track='pm')
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
 * One type for all three tracks: PM, repo, plugin.
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

  /** Model override (default per track: opus for PM, sonnet for repo/plugin) */
  model?: string;

  /** Reasoning effort level (default: 'high') */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Maximum agentic turns before stopping (default: 100) */
  maxTurns?: number;

  /** Which track: pm, repo, or plugin */
  track: AgentTrack;

  /** Plugin name this agent belongs to */
  pluginName: string;

  /** Domain-specific prompt body (Layer 3) from agents/<key>.md */
  agentPrompt?: string;

  /** Repo-specific fields (track='repo' only) */
  repo?: AgentRepoDef;

  /** Absolute path to plugin directory (track='plugin' only) */
  pluginPath?: string;

  /** Absolute path to plugin's persistent data directory (workdir/plugins-data/<name>/) */
  pluginDataPath?: string;

  /** Absolute path to plugin's skills/ directory (track='plugin' only) */
  skillsPath?: string;

  /** PM-specific fields (track='pm' only) — built dynamically from team */
  pmConfig?: AgentPmDef;

  /** Extra prompt from pm plugin overlay (track='pm' only) */
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
