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

import type { AgentDef } from '../types/agent.js';
import { isPmAgent } from '../types/agent.js';

export interface ActivityContext {
  /** The PM coordinator speaks for the whole team — it has no single domain. */
  isPm: boolean;
  /** Repo agent with edit access — distinguishes "working on" from "checking". */
  editMode: boolean;
  /** Short domain noun for a specialist ("mobile", "backend"); '' for the PM. */
  domain: string;
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
  void input; // reserved for future, more specific phrasing
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
      return ctx.editMode && ctx.domain ? `working on the ${ctx.domain}` : 'running some checks';
    case 'Skill':
      return 'getting up to speed';
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

  // Internal coordination + user comms — deliberately invisible in status text.
  // Delegating, posting to the user, assigning owners and logging findings are
  // bookkeeping; the indicator should reflect the *work*, not the plumbing.
  if (
    server === 'comms-tools' ||
    server === 'agent-tools' ||
    server === 'orchestration-tools' ||
    server === 'scheduling-tools'
  ) {
    return null;
  }

  // External integrations (plugin MCP servers) — phrase by the system involved.
  return integrationPhrase(server, here);
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

function repoToolPhrase(tool: string, domain: string): string {
  switch (tool) {
    case 'push_branch': return 'pushing the changes';
    case 'create_pull_request': return 'opening a pull request';
    case 'merge_pull_request': return 'merging the changes';
    case 'close_pull_request': return 'wrapping up the pull request';
    case 'update_pr':
    case 'add_pr_comment':
    case 'add_review_comment':
    case 'reply_to_review_comment':
    case 'resolve_review_thread':
    case 'request_re_review':
      return 'updating the pull request';
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

function integrationPhrase(server: string, here: string): string {
  const s = server.toLowerCase();
  if (s.includes('rollbar')) return 'checking the error reports';
  if (s.includes('atlassian') || s.includes('jira') || s.includes('rovo')) return 'checking Jira';
  if (s.includes('confluence')) return 'checking Confluence';
  if (s.includes('monday')) return 'updating the board';
  if (s.includes('clickhouse') || s.includes('analytics')) return 'querying the data';
  if (s.includes('admin')) return 'working in the admin panel';
  if (s.includes('gws') || s.includes('sheet') || s.includes('google')) return 'checking the spreadsheet';
  if (s.includes('github')) return 'checking GitHub';
  if (s.includes('slack')) return 'checking Slack';
  if (s.includes('firebase')) return 'checking Firebase';
  if (s.includes('teamcity')) return 'checking the build';
  if (s.includes('smartbear')) return 'checking the tests';
  if (s.includes('n8n')) return 'checking the workflow';
  if (s.includes('gmail') || s.includes('mail')) return 'checking email';
  if (s.includes('notion')) return 'checking Notion';
  return `working on ${here}`;
}
