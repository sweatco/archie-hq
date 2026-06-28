/**
 * Agent-related type definitions
 */

import type { AgentName, TaskMetadata } from './task.js';

/**
 * Per-tool metadata as reported by a connected MCP server (subset of the SDK's
 * `McpServerStatus`). Used to phrase the Slack status line without a per-server
 * map: `readOnly` picks the verb (checking vs updating) and `serverName` is a
 * fallback label.
 */
export interface McpToolMeta {
  /** Server's self-reported name (serverInfo.name), if any. */
  serverName?: string;
  /** Tool annotation: true = read-only, false = mutating, undefined = unknown. */
  readOnly?: boolean;
}

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
  /**
   * Hard-abort the SDK subprocess (via its AbortController). Task teardown
   * calls this after stopping the queue, to kill an agent that is mid-turn when
   * its stream is closed — otherwise it loops on "Stream closed" control
   * requests until maxTurns.
   */
  abort(): void;
}

/**
 * A single repo entry declared by a repo agent in its frontmatter.
 * The `github` identifier (e.g. 'acme/backend') doubles as the entry's key —
 * no separate repoKey field, no short-name derivation.
 */
export interface RepoEntry {
  /** GitHub repository identifier, e.g., 'acme/backend'. Also the key. */
  github: string;
  /** Base branch for PRs and merges. Defaults applied at consume sites. */
  baseBranch: string;
}

/**
 * Repo-specific fields (present only when the agent has repo access attached).
 *
 * Multi-repo: each repo agent declares one or more repos in its frontmatter.
 * ALL of them are mounted at spawn; `primary` is the default target for
 * repo-tools when the `github` arg is omitted.
 */
export interface AgentRepoDef {
  /** All repos this agent works with — every entry is mounted at spawn. At least one. */
  repos: RepoEntry[];
  /** Github identifier of the primary repo. Must match one entry's `github`. */
  primary: string;
}

/**
 * PM-specific fields (present only on the PM coordinator agent)
 */
export interface AgentPmDef {
  /**
   * Formatted team list for prompt template. Each teammate's line is annotated
   * with the external systems it can reach via MCP, so the PM knows which agent
   * to route an integration request to instead of assuming Archie lacks access.
   */
  teamList: string;
  /** Formatted team expertise for prompt template */
  teamExpertise: string;
  /**
   * One sentence naming the integrations the PM can query directly (the PM is
   * not part of its own roster). Empty string when it has no MCP servers.
   */
  pmIntegrations: string;
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

  /**
   * Optional short domain noun for the first-person Slack status indicator
   * (e.g. 'mobile', 'backend', 'marketing'). From `metadata.archie.statusLabel`.
   * When absent, a label is derived from the key/plugin (see agentDomainLabel).
   * Never expose the agent id or role in status text — only this domain noun.
   */
  statusLabel?: string;

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

  /**
   * Human-readable descriptions for this agent's MCP servers (server name →
   * description), from `.mcp.json`. Authored for the PM roster; also used to
   * phrase the Slack status line ("checking Rollbar") without a hardcoded map.
   */
  mcpDescriptions?: Record<string, string>;

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
