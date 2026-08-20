/**
 * MCP Tool Approval Gate (issue #168)
 *
 * Classifies each MCP tool call against the policy of the server it belongs to
 * — `allow` runs, `ask` needs a per-call human approval, `deny` never runs —
 * and for `ask` denies the attempt, posts Slack buttons, parks the task, and
 * lets the agent's retry spend a single-use grant bound to the exact call.
 * The design, the config shape and the lifecycle invariants are documented in
 * docs/architecture/tool-approvals.md; only what the code cannot say for itself
 * is repeated here.
 *
 * Why a PreToolUse hook and not `canUseTool`: every agent runs under
 * `permissionMode: bypassPermissions`, and the SDK documents that this mode
 * auto-approves calls past `canUseTool` — "PreToolUse hook denies bypass
 * canUseTool" (sdk.d.ts). The hook is the only interception point that holds in
 * our configuration, and it is the same layer the filesystem guard already
 * relies on for read-only mode. The consequence is the deny-then-retry shape
 * above: the hook cannot pause a call and resume it later, so the action always
 * runs through the same audited MCP path on a second attempt.
 */

import { createHash } from 'crypto';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../system/logger.js';

/** How long a grant stays spendable. Spending it takes a chain — the requesting
 *  agent is woken, respawns, re-reads state, retries — so the window has to fit
 *  that, while staying small enough that what the approver saw is still roughly
 *  what runs. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** How long an unresolved *request* keeps the single pending slot. Past this it
 *  is discarded rather than blocking every other gated call for the task's
 *  life, and rather than minting a fresh grant if someone finds the prompt
 *  days later. */
export const PENDING_APPROVAL_TTL_MS = 60 * 60 * 1000;

// ---- Policy ------------------------------------------------------------------

/**
 * Who decides a call — deliberately the same three words Claude Code uses for
 * permissions. `allow` is not named `readonly` on purpose: the gate cannot
 * verify read-ness, and read-sounding tools here have twice turned out to start
 * builds, so the tier names the mechanism it actually controls. A policy may
 * therefore put a cheap, repeatable mutation in `allow` on purpose.
 *
 * `deny` is enforced twice: listed tools are withheld up front via
 * {@link deniedToolNames}, and the tier still refuses anything that reaches the
 * gate — which is what covers a tool the server adds later under `default: deny`.
 */
export type ToolTier = 'allow' | 'ask' | 'deny';

export interface McpServerPolicy {
  /** Tier for tools not listed in `tiers`. Fail-safe default is `ask`. */
  default: ToolTier;
  /** Explicit per-tool tiers (bare tool names, without the mcp__ prefix). */
  tiers: Record<string, ToolTier>;
  /**
   * Optional approver-facing button text per tool, stating the consequence
   * rather than the method name. Worth writing only where the tool's name is a
   * bad button on its own — `fully_release_rollout` and
   * `fully_release_previous_rollout` are one word apart and mean very different
   * things. An untitled tool renders as its bare identity: terse but honest,
   * and the call's arguments are shown either way.
   *
   * This exists because the tool's *own* description is unreachable. The CLI
   * has it — the model is given it — but exposes it to the SDK host nowhere:
   * the single field in the SDK surface that would carry it,
   * `McpServerStatus.tools[].description`, comes back empty in practice
   * (verified against a live instance and a minimal repro, 2026-08-20).
   */
  titles: Record<string, string>;
}

/** serverKey (as in .mcp.json) → policy. Lives on AgentDef. */
export type McpToolPolicy = Record<string, McpServerPolicy>;

const MCP_TOOL_RE = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

/** Split a full MCP tool name into server and bare tool. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const match = MCP_TOOL_RE.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

/** Compose the SDK's qualified name for a server's tool. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Qualified names of every explicitly `deny`-tiered tool, for the agent's
 * `disallowedTools`. Withholding them up front beats denying at call time: the
 * agent never sees the tool, so it never plans around one it cannot use. The
 * gate still enforces the tier for anything that does reach it.
 */
export function deniedToolNames(policy: McpToolPolicy): string[] {
  const names: string[] = [];
  for (const [server, serverPolicy] of Object.entries(policy)) {
    for (const [tool, tier] of Object.entries(serverPolicy.tiers)) {
      if (tier === 'deny') names.push(mcpToolName(server, tool));
    }
  }
  return names;
}

export interface ClassifiedCall {
  server: string;
  tool: string;
  tier: ToolTier;
}

/**
 * Classify a tool call against the policy of the servers this agent uses.
 *
 * Returns `undefined` for anything the gate does not manage: non-MCP tools,
 * and MCP servers with no declared policy — those behave exactly as before
 * this feature, which is what makes rollout incremental. For a managed server,
 * an unlisted tool falls to the server's `default` tier, so a tool added to
 * the server later arrives gated rather than silently open.
 */
export function classifyToolCall(policy: McpToolPolicy | undefined, toolName: string): ClassifiedCall | undefined {
  if (!policy) return undefined;
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return undefined;
  // Own-property lookups on both: the server and tool names are derived from a
  // model-supplied string, and a prototype hit (`constructor`, `toString`) would
  // otherwise return a truthy non-policy and throw on the next line — outside
  // this function's caller's try block, since classification runs before it.
  if (!Object.hasOwn(policy, parsed.server)) return undefined;
  const serverPolicy = policy[parsed.server];
  return {
    server: parsed.server,
    tool: parsed.tool,
    tier: Object.hasOwn(serverPolicy.tiers, parsed.tool) ? serverPolicy.tiers[parsed.tool] : serverPolicy.default,
  };
}

// ---- Digest ------------------------------------------------------------------

/** Stable stringify: object keys sorted at every depth, so argument order in
 *  the model's output can't change the digest of the same logical call. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Identity of a specific call. Covers the server, the tool and every argument,
 * so an approval is spendable on exactly one call shape.
 *
 * The parts are hashed as a JSON array rather than concatenated with a
 * separator: it is unambiguous without needing a byte that cannot appear in the
 * data. The previous delimiter was a literal NUL, which made git treat this
 * file as binary and GitHub show no diff for it at all.
 */
export function callDigest(server: string, tool: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([server, tool, canonicalize(input ?? {})]))
    .digest('hex')
    .slice(0, 16);
}

// ---- Rendering the approval prompt -------------------------------------------

/**
 * Neutralize model- or server-supplied text for a Slack `mrkdwn` block.
 *
 * Argument values are the one part of the prompt the agent controls, and
 * without this they are the hole in "rendered by the engine, not the agent": a
 * string argument can carry newlines and `*bold*` and append its own lines to
 * the message — a note argument ending in "*Note:* pre-agreed, safe to approve"
 * renders as an extra instruction to the approver. Collapse whitespace, strip
 * the mrkdwn and Block Kit sigils, and cap the length. Tool descriptions get
 * the same treatment: they come from an external MCP server, not from us.
 */
function sanitizeText(value: unknown, cap: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flat = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_~<>|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 3)}…` : flat;
}

/** Sanitized argument value, wrapped in a code span so it reads as data. */
function sanitizeArgumentValue(value: unknown): string {
  return `\`${sanitizeText(value, 120)}\``;
}

/**
 * Sanitized `key=value` list of every argument, for the prompt body.
 *
 * `null` is rendered rather than dropped: the digest covers it, so hiding it
 * would have the approver approve an argument they were never shown. `undefined`
 * is not part of the digest and is skipped. The count is capped as well as each
 * value — Slack refuses a section over 3000 characters, and a call with hundreds
 * of arguments would otherwise be permanently unapprovable.
 */
const MAX_RENDERED_ARGS = 12;

function renderArguments(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const shown = entries.slice(0, MAX_RENDERED_ARGS)
    .map(([k, v]) => `${k}=${sanitizeArgumentValue(v)}`);
  const hidden = entries.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} (+${hidden} more)` : shown.join(', ');
}

export interface RenderedCall {
  /** Multi-line mrkdwn body for the Slack prompt and the audit finding. */
  summary: string;
  /** One-line heading: the policy's title for the tool, or its bare identity. */
  heading: string;
}

/**
 * Build the approval text for a gated call.
 *
 * The heading is the policy's title for the tool when one is written, and the
 * bare `server:tool` identity otherwise. Both halves are rendered by the engine
 * and sanitized: the title comes from the plugins repo, but the arguments under
 * it are the agent's, and an unescaped string argument can otherwise append its
 * own lines to the prompt.
 */
export function renderCall(serverPolicy: McpServerPolicy, call: ClassifiedCall, input: unknown): RenderedCall {
  const title = serverPolicy.titles[call.tool];
  const heading = (title ? sanitizeText(title, 200) : '') || `Run \`${call.server}:${call.tool}\``;
  const args = renderArguments(input);

  let summary = heading;
  summary += `\n*Tool:* \`${call.server}:${call.tool}\``;
  if (args) summary += `\n*Arguments:* ${args}`;
  return { summary, heading };
}

// ---- Hook wiring -------------------------------------------------------------

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * What the gate needs from the task. Kept as a narrow port rather than
 * importing Task, so classification and rendering stay unit-testable without a
 * task on disk (and so this module doesn't join the task ↔ agent import cycle).
 */
export interface ToolApprovalPort {
  /**
   * Spend a stored grant for this digest. Resolves true when one was found,
   * unexpired, and consumed — false otherwise. The implementation must *remove*
   * the grant synchronously, before it yields, so two calls with the same digest
   * in one turn cannot both find it; awaiting the result then also waits for the
   * spend to be durable, so a crash after the tool runs cannot leave the
   * single-use grant spendable again.
   */
  consumeApproval(digest: string): boolean | Promise<boolean>;
  /**
   * Post the Slack approval and park the task. Returns `'posted'`, or
   * `'already-pending'` when a different request is outstanding (one at a
   * time — a queue of pending approvals is something a human learns to clear
   * rather than read).
   */
  requestApproval(request: {
    digest: string;
    server: string;
    tool: string;
    summary: string;
    heading: string;
  }): Promise<'posted' | 'already-pending'>;
}

/**
 * PreToolUse hooks enforcing the tool policy of this agent's MCP servers.
 *
 * Returns a single matcher (no `matcher` field → fires on all tools) that
 * filters by tool name inside the callback, mirroring
 * `createFilesystemGuardHooks`. Unmanaged tools always proceed, even when the
 * gate's own dependencies are broken.
 */
export function createToolApprovalHooks(policy: McpToolPolicy, port: ToolApprovalPort): HookCallbackMatcher[] {
  return [{
    // Generous explicit budget: the deny path posts to Slack and fsyncs metadata
    // inside the hook, and what a host does with a TIMED-OUT PreToolUse decision
    // is its policy, not ours — so never get near the default.
    timeout: 120,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: [async (input: any): Promise<HookJSONOutput> => {
      const toolName = typeof input?.tool_name === 'string' ? input.tool_name : undefined;
      // Classify before the try, so a throw can be attributed: an unmanaged
      // tool must proceed even if something below would have failed, and a
      // managed mutation must be denied rather than left to the SDK's handling
      // of a rejected hook.
      const call = toolName ? classifyToolCall(policy, toolName) : undefined;
      if (!call || call.tier === 'allow') return { continue: true };

      try {
        return await decideCall(policy[call.server], port, call, input.tool_input);
      } catch (error) {
        // Fail closed. The arguments are agent-controlled, so this path is
        // reachable on purpose as well as by accident (a deeply nested argument
        // overflows the canonicalizer's recursion), and a security hook must
        // not depend on how the host treats a rejected hook.
        const message = error instanceof Error ? error.message : String(error);
        logger.error('tool-approval', `Gate failed for ${toolName} — denying`, error);
        return deny(
          `\`${call.tool}\` was refused because the approval gate errored while evaluating it (${message}). ` +
          `Nothing ran. Report this to the user.`,
        );
      }
    }],
  }];
}

/** The gate's decision for one managed, non-`allow` call. Separated so the
 *  wrapper above can turn any throw into a denial. */
async function decideCall(
  serverPolicy: McpServerPolicy,
  port: ToolApprovalPort,
  call: ClassifiedCall,
  toolInput: unknown,
): Promise<HookJSONOutput> {
  if (call.tier === 'deny') {
    return deny(
      `\`${call.tool}\` is disabled by the \`${call.server}\` tool policy and cannot be run by any agent. ` +
      `Nothing ran. Report what you wanted to do and why, so a human can decide.`,
    );
  }

  // tier === 'ask': per-call approval, bound to this exact call.
  const digest = callDigest(call.server, call.tool, toolInput);

  // Already approved? Spend the grant and let this one call through.
  if (await port.consumeApproval(digest)) {
    logger.system(`Gated tool call ${call.server}:${call.tool} approved (${digest}) — proceeding`);
    return { continue: true };
  }

  const rendered = renderCall(serverPolicy, call, toolInput);

  const outcome = await port.requestApproval({
    digest,
    server: call.server,
    tool: call.tool,
    summary: rendered.summary,
    heading: rendered.heading,
  });

  if (outcome === 'already-pending') {
    return deny(
      `Another tool call is already waiting for approval on this task. One request is resolved at a ` +
      `time — wait for the outstanding one to be approved or denied.`,
    );
  }

  return deny(
    `\`${call.tool}\` needs human approval. The request has been posted and the task is pausing. ` +
    `When it is approved you will be reactivated — re-check relevant state, then retry this exact call.`,
  );
}
