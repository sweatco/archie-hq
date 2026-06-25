/**
 * Activity derivation — turns an agent's tool calls into a short, first-person
 * status fragment for the Slack assistant-thread status indicator.
 *
 * This is the engine behind the "Archie is …" loading line. It is intentionally
 * a pure, dependency-light mapping so it can run on every agent's tool call with
 * negligible cost and be unit-tested in isolation. Two rules shape every phrase:
 *
 *   1. Single persona. Output is always first person and never names an agent or
 *      reveals that more than one is at work. Specialists are referred to only by
 *      their DOMAIN ("the backend"), never their identity ("the backend agent").
 *   2. Slack prepends the app name. The fragments here are the part after it, so
 *      "digging into the backend" renders to the user as "Archie is digging into
 *      the backend…". The caller composes the surrounding "is …".
 */

import type { AgentDef, McpToolMeta } from '../types/agent.js';
import { isPmAgent } from '../types/agent.js';

export interface ActivityContext {
  /** The PM coordinator speaks for the whole team — it has no single domain. */
  isPm: boolean;
  /** Repo agent with edit access — distinguishes "working on" from "checking". */
  editMode: boolean;
  /** Short domain noun for a specialist ("mobile", "backend"); '' for the PM. */
  domain: string;
  /**
   * MCP server descriptions from `.mcp.json` (server name → "Rollbar — …"),
   * used to phrase external-integration activity without a hardcoded map.
   */
  mcpDescriptions?: Record<string, string>;
  /**
   * Server-reported per-tool metadata (namespaced tool name → meta), captured
   * from the live MCP connection. `readOnly` picks the verb; `serverName` is a
   * label fallback.
   */
  mcpTools?: Map<string, McpToolMeta>;
  /**
   * Resolves a target agent id (e.g. from `send_message_to_agent`) to its domain
   * noun, so a delegation reads as the single persona turning to that area
   * ("looking into the backend") rather than naming an agent. Returns '' for the
   * PM (no domain) and undefined for an unknown id.
   */
  resolveAgentDomain?: (agentId: string) => string | undefined;
}

/**
 * Short, user-facing domain noun for an agent, used in status text. Never the
 * agent id or role — those would leak the multi-agent structure.
 *
 * Resolution: explicit `statusLabel` frontmatter wins; otherwise the agent key
 * is used when it already reads as a domain (engineering keys: mobile, backend,
 * infrastructure), and role-style keys (copywriter, qa-analyst, …) fall back to
 * a cleaned plugin name. The PM has no domain.
 */
export function agentDomainLabel(def: AgentDef): string {
  if (isPmAgent(def)) return '';
  if (def.statusLabel && def.statusLabel.trim()) return def.statusLabel.trim();

  const key = def.key;
  // Keys that name a person/role rather than a domain — defer to the plugin.
  const roleLikeKeys = new Set([
    'copywriter', 'tov-reviewer', 'reviewer', 'analyst',
    'qa-analyst', 'qa-reviewer', 'data-analyst', 'specialist', 'assistant',
  ]);
  if (key && !roleLikeKeys.has(key)) return key;
  return normalizePluginDomain(def.pluginName);
}

function normalizePluginDomain(plugin: string): string {
  switch (plugin) {
    case 'data-analytics': return 'data';
    case 'qa': return 'QA';
    case 'pm': return '';
    default: return plugin || '';
  }
}

/**
 * Map a single tool call to a status fragment, or null when the call is not
 * worth surfacing (internal bookkeeping, delegating, posting to the user — the
 * status for those is handled by the caller's lifecycle, not here).
 */
export function deriveActivity(
  toolName: string,
  input: unknown,
  ctx: ActivityContext,
): string | null {
  const here = ctx.domain ? `the ${ctx.domain}` : 'this';

  // ---- Built-in SDK tools (bare names) ----
  switch (toolName) {
    case 'Read':
    case 'Grep':
    case 'Glob':
      return ctx.domain ? `digging into the ${ctx.domain}` : 'going through the details';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ctx.domain ? `making changes to the ${ctx.domain}` : 'drafting changes';
    case 'Bash':
      // Always say *where* for a specialist; only the PM (no domain) is vague.
      if (ctx.domain) return ctx.editMode ? `working on the ${ctx.domain}` : `running some checks on the ${ctx.domain}`;
      return 'running some checks';
    case 'Skill':
      return ctx.domain ? `getting up to speed on the ${ctx.domain}` : 'getting up to speed';
    case 'Task':
      return ctx.domain ? `working on the ${ctx.domain}` : 'working through this';
    case 'TodoWrite':
    case 'WebSearch':
    case 'WebFetch':
      return null;
  }

  // ---- MCP tools: mcp__<server>__<tool> ----
  const mcp = parseMcpTool(toolName);
  if (!mcp) return null;
  const { server, tool } = mcp;

  // Universal research tool (available to all agents).
  if (server === 'research-tools') return tool === 'web_research' ? 'researching' : null;

  // Repo / git / PR tools (engineering & other repo agents).
  if (server === 'repo-tools') return repoToolPhrase(tool, ctx.domain);

  // Inter-agent coordination + shared-log activity — surfaced, but phrased
  // generically so the single-persona voice never names another agent.
  if (server === 'agent-tools') return agentToolPhrase(tool, input, ctx);

  // PM comms / orchestration / scheduling — surface the user-meaningful actions;
  // the rest (post_to_user, owner assignment, completion, reactions, …) is
  // plumbing and stays hidden.
  if (server === 'comms-tools') return commsToolPhrase(tool);
  if (server === 'orchestration-tools') return orchestrationToolPhrase(tool);
  if (server === 'scheduling-tools') return schedulingToolPhrase(tool);

  // External integrations (plugin MCP servers) — phrase from metadata, no map.
  return integrationPhrase(toolName, server, here, ctx);
}

/**
 * Walk an SDK `assistant` event and return the fragment for its last surfaced
 * tool call (a single event can carry several parallel tool_use blocks). Returns
 * null when the event has no status-worthy tool call.
 */
export function deriveActivityFromEvent(event: unknown, ctx: ActivityContext): string | null {
  const e = event as { type?: string; message?: { content?: unknown } } | null;
  if (!e || e.type !== 'assistant') return null;
  const content = e.message?.content;
  if (!Array.isArray(content)) return null;

  let phrase: string | null = null;
  for (const block of content) {
    if (block && (block as { type?: string }).type === 'tool_use') {
      const b = block as { name: string; input?: unknown };
      const p = deriveActivity(b.name, b.input ?? {}, ctx);
      if (p) phrase = p;
    }
  }
  return phrase;
}

// ---- helpers ----

function parseMcpTool(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const idx = rest.indexOf('__');
  if (idx === -1) return { server: rest, tool: '' };
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

/**
 * Base agent-tools (every agent): inter-agent messaging, shared-log findings,
 * and artifact publishing. Never names another agent — a message to a domain
 * specialist reads as the single persona turning to that area ("looking into the
 * backend"); a message to the coordinator (or an unknown target) stays generic.
 */
function agentToolPhrase(tool: string, input: unknown, ctx: ActivityContext): string | null {
  switch (tool) {
    case 'send_message_to_agent': {
      const target = (input as { target?: unknown } | null)?.target;
      const domain = typeof target === 'string' ? ctx.resolveAgentDomain?.(target) : undefined;
      return domain ? `looking into the ${domain}` : 'coordinating';
    }
    case 'log_finding': return ctx.domain ? `making a note on the ${ctx.domain}` : 'making a note';
    case 'share_artifact': return ctx.domain ? `writing up the ${ctx.domain}` : 'writing things up';
    default: return null;
  }
}

/** PM Slack lookups — other comms tools (post_to_user, reactions, mute) stay hidden. */
function commsToolPhrase(tool: string): string | null {
  switch (tool) {
    case 'find_slack_user': return 'looking someone up';
    case 'find_slack_channel': return 'finding the right channel';
    default: return null;
  }
}

/** PM orchestration — surface progress checks and task launches; hide the rest. */
function orchestrationToolPhrase(tool: string): string | null {
  switch (tool) {
    case 'get_agents_status': return 'checking on progress';
    case 'launch_task': return 'kicking off a task';
    default: return null;
  }
}

/** PM scheduling — reminders are user-meaningful; datetime parsing is not. */
function schedulingToolPhrase(tool: string): string | null {
  switch (tool) {
    case 'set_reminder': return 'setting a reminder';
    case 'cancel_reminder': return 'clearing a reminder';
    default: return null;
  }
}

function repoToolPhrase(tool: string, domain: string): string {
  switch (tool) {
    case 'push_branch': return domain ? `pushing the ${domain} changes` : 'pushing the changes';
    case 'create_pull_request': return domain ? `opening a ${domain} pull request` : 'opening a pull request';
    case 'merge_pull_request': return domain ? `merging the ${domain} changes` : 'merging the changes';
    case 'close_pull_request': return domain ? `wrapping up the ${domain} pull request` : 'wrapping up the pull request';
    case 'update_pr':
    case 'add_pr_comment':
    case 'add_review_comment':
    case 'reply_to_review_comment':
    case 'resolve_review_thread':
    case 'request_re_review':
      return domain ? `updating the ${domain} pull request` : 'updating the pull request';
    case 'list_prs':
    case 'get_pr':
    case 'get_pr_status':
    case 'get_pr_checks':
    case 'get_check_run':
    case 'get_pr_reviews':
    case 'get_pr_comments':
    case 'get_review_threads':
      return domain ? `reviewing the ${domain} PR` : 'reviewing the pull request';
    case 'fetch':
    case 'switch_branch':
    case 'list_branches':
    case 'create_branch':
      return domain ? `digging into the ${domain}` : 'getting the code ready';
    default:
      return domain ? `working on the ${domain}` : 'working on the code';
  }
}

/**
 * Phrase an external-integration tool call without any per-server map.
 *
 *   • Verb  — from the server-reported `readOnly` annotation: read → "checking",
 *     mutating → "updating", unknown → "checking" (most MCP calls are reads).
 *   • Label — the `.mcp.json` description (already maintained for the PM roster),
 *     falling back to the server's self-reported name, then a cleaned server key.
 *
 * So a new integration self-describes: give its server a one-line description (or
 * let it report a sensible serverInfo.name) and it gets a phrase for free.
 */
function integrationPhrase(toolName: string, server: string, here: string, ctx: ActivityContext): string {
  const meta = ctx.mcpTools?.get(toolName);
  const label =
    labelFromDescription(ctx.mcpDescriptions?.[server]) ??
    cleanServerLabel(meta?.serverName) ??
    cleanServerLabel(server);
  if (!label) return `working on ${here}`;
  const verb = meta?.readOnly === false ? 'updating' : 'checking';
  return `${verb} ${label}`;
}

/**
 * Pull a short label from a `.mcp.json` description. Descriptions follow the
 * convention "<Label> — <details>", so take the part before the first separator
 * and drop a trailing parenthetical qualifier:
 *   "Jira & Confluence (Atlassian) — issues, …" → "Jira & Confluence"
 *   "BugSnag (SmartBear) — crash reports"       → "BugSnag"
 *   "Rollbar — backend error tracking"          → "Rollbar"
 */
function labelFromDescription(desc?: string): string | undefined {
  if (!desc) return undefined;
  let label = desc.split(/\s[—–-]\s|:|,/)[0].trim();
  label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return label || undefined;
}

/** Tidy a server slug / self-reported name into a usable label, or undefined. */
function cleanServerLabel(name?: string): string | undefined {
  if (!name) return undefined;
  const s = name
    .trim()
    .replace(/^plugin[_-]/i, '')
    .replace(/[-_](mcp|server|context[-_]?grabber)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return s || undefined;
}
