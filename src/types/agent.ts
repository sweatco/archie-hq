/**
 * Agent-related type definitions
 */

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
 * "Max mode" spec — the model and effort an agent upgrades to when the task has
 * max mode approved. See resolveAgentModel / resolveAgentEffort.
 */
export interface MaxModeSpec {
  /** Model to run on in max mode (e.g. 'claude-fable-5-1'). Omit to keep the normal model. */
  model?: string;
  /** Reasoning effort in max mode. Omit to keep the normal effort. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Agent definition. A task runs exactly one agent — the PM — so in practice
 * this describes the PM: `getPmDef()` in `src/agents/registry.ts` is the only
 * thing that builds one. Rebuilt at startup and on every task start/restart so
 * a changed plugins-repo root is picked up.
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

  /**
   * Max-mode upgrade. When the task has max mode approved these override the
   * agent's normal model and effort (see resolveAgentModel /
   * resolveAgentEffort). The PM's come from the engine constants in
   * `registry.ts`, overridable by `ARCHIE_PM_MAX_MODEL` / `ARCHIE_PM_MAX_EFFORT`.
   */
  maxMode?: MaxModeSpec;

  /**
   * Tool approval policy for the MCP servers this agent mounts, resolved from
   * each server's `archie` block in the plugins repo's `.mcp.json`. When
   * present, a PreToolUse gate intercepts calls to those servers: `allow` tools
   * pass ungated, `ask` tools require a per-call Slack approval, `deny` tools
   * never run. See docs/architecture/tool-approvals.md.
   */
  mcpPolicy?: import('../agents/tool-approval-gate.js').McpToolPolicy;

  /** Maximum agentic turns before stopping (default: 100) */
  maxTurns?: number;

  /** True only for the PM coordinator agent (the core agent overlaid by the pm plugin) */
  isPm?: boolean;

  /** Plugin name this agent belongs to */
  pluginName: string;

  /**
   * Addressing scope. Vestigial now that a task runs one agent — always
   * 'global' on the PM definition.
   */
  visibility: 'global' | 'local';

  /** Domain-specific prompt body (Layer 3) from agents/<key>.md */
  agentPrompt?: string;

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

  /** Sandbox outbound-network whitelist (from archie.json). Empty/undefined = deny all. */
  allowedNetworkDomains?: string[];
}

// ---- Capability predicates ----

/** True for the PM coordinator (the core agent overlaid by the pm plugin). */
export function isPmAgent(def: AgentDef): boolean {
  return def.isPm === true;
}
