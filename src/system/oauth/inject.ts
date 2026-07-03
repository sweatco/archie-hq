/**
 * Spawn-time OAuth credential injection with per-user precedence.
 *
 * For each http/sse entry the acting-user binding is the policy boundary:
 *
 *   bound (task, server → user)  → that user's token only; failure re-walls,
 *                                  NEVER falls back to the shared operator token
 *   unbound + auto-bind user     → bind and inject their existing stored token
 *   unbound + shared record      → inject the shared operator token (cold default)
 *   unbound + no credentials     → spec probe; OAuth-requiring servers are
 *                                  removed from the map and surfaced as
 *                                  `requestable` (agents may request_mcp_auth)
 *
 * Entries whose .mcp.json already carries an Authorization header are left
 * alone — explicit operator intent wins. Built-in in-process SDK servers
 * (`createBaseAgentMcpServer`, etc.) have no http/sse type and are untouched;
 * stdio entries keep their existing `${MCP_*}` env-var substitution path.
 */

import { logger } from '../logger.js';
import { hasOAuthRecord, hasUserOAuthRecord } from './storage.js';
import { ensureFreshToken, ensureFreshUserToken, type FreshToken } from './refresh.js';
import { classifyServerAuth } from './discovery.js';

export interface OAuthBindingFailure {
  serverName: string;
  error: Error;
}

export interface OAuthInjectContext {
  /** Completed (task, server) → Slack user bindings. Bound pairs are user-scoped. */
  bindings?: Record<string, string>;
  /** The task's single resolvable human, if any — the auto-bind candidate. */
  autoBindUser?: string | null;
  /** Invoked when an unbound server auto-binds to `autoBindUser` (persist + log). */
  onAutoBind?: (serverName: string, slackUserId: string) => void | Promise<void>;
}

export interface OAuthBindingResult {
  injected: string[];
  /** Subset of `injected` that used the shared operator token (cold fallback). */
  sharedInjected: string[];
  dropped: OAuthBindingFailure[];
  /**
   * Referenced servers that require auth but have no usable credential —
   * removed from the map so the SDK doesn't spew 401s; surfaced to the agent
   * as requestable via `request_mcp_auth`.
   */
  requestable: string[];
}

/**
 * Mutates `mcpServers` in place, injecting Authorization headers and deleting
 * entries that have no usable credential. Returns a summary so callers can
 * log, and the `requestable` set for prompt injection.
 */
export async function applyOAuthBindings(
  mcpServers: Record<string, any>,
  context: OAuthInjectContext = {},
): Promise<OAuthBindingResult> {
  const bindings = context.bindings ?? {};
  const injected: string[] = [];
  const sharedInjected: string[] = [];
  const dropped: OAuthBindingFailure[] = [];
  const requestable: string[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isHttpLike(config)) continue;
    // Only act if the .mcp.json author hasn't already supplied a token.
    // (Hand-managed creds win — operator intent is explicit.)
    if (hasExplicitAuthHeader(config)) continue;

    const boundUser = bindings[name];
    if (boundUser) {
      // User-scoped: the binding is the policy boundary — no shared fallback.
      // A missing/revoked/unrefreshable token re-walls instead of silently
      // downgrading the agent to broad shared access.
      try {
        setAuthHeader(config, await ensureFreshUserToken(boundUser, name));
        injected.push(name);
      } catch (err) {
        dropped.push({ serverName: name, error: toError(err) });
        requestable.push(name);
        delete mcpServers[name];
        logger.error(
          'oauth',
          `MCP "${name}": bound user ${boundUser}'s token unusable — held back for re-authorization (no shared fallback)`,
          err,
        );
      }
      continue;
    }

    // Unbound + a single resolvable human with a stored usable token → bind
    // and use it (returning users skip the wall).
    if (context.autoBindUser && (await hasUserOAuthRecord(context.autoBindUser, name))) {
      try {
        const token = await ensureFreshUserToken(context.autoBindUser, name);
        setAuthHeader(config, token);
        await context.onAutoBind?.(name, context.autoBindUser);
        injected.push(name);
        continue;
      } catch (err) {
        // Stored token is dead and the pair was never bound — cold rules apply.
        logger.error(
          'oauth',
          `MCP "${name}": auto-bind for ${context.autoBindUser} failed — falling through to cold resolution`,
          err,
        );
      }
    }

    // Cold: shared operator token when present.
    if (await hasOAuthRecord(name)) {
      try {
        setAuthHeader(config, await ensureFreshToken(name));
        injected.push(name);
        sharedInjected.push(name);
      } catch (err) {
        dropped.push({ serverName: name, error: toError(err) });
        requestable.push(name);
        delete mcpServers[name];
        logger.error('oauth', `Failed to bind shared credentials for MCP server "${name}", dropping`, err);
      }
      continue;
    }

    // No credentials at all: the spec probe decides. OAuth-requiring servers
    // would only produce connect noise — hold them back as requestable.
    // 'open'/'unknown' entries are left untouched (genuinely open, static-key
    // via non-Authorization headers, or transiently unreachable).
    const url = typeof config.url === 'string' ? config.url : null;
    if (url && (await classifyServerAuth(url)) === 'oauth') {
      requestable.push(name);
      delete mcpServers[name];
      logger.system(`MCP "${name}" requires OAuth and has no credentials — held back as requestable`);
    }
  }

  return { injected, sharedInjected, dropped, requestable };
}

function isHttpLike(config: unknown): config is { type?: string; url?: string; headers?: Record<string, string> } {
  if (!config || typeof config !== 'object') return false;
  const type = (config as { type?: unknown }).type;
  return type === 'http' || type === 'sse';
}

function hasExplicitAuthHeader(config: { headers?: Record<string, string> }): boolean {
  const headers = config.headers ?? {};
  return 'Authorization' in headers || 'authorization' in headers;
}

function setAuthHeader(config: { headers?: Record<string, string> }, token: FreshToken): void {
  // RFC 6750 says scheme is case-insensitive, but real-world servers
  // (Notion, etc.) strict-match — normalize "bearer" to "Bearer".
  const scheme = /^bearer$/i.test(token.tokenType) ? 'Bearer' : token.tokenType;
  config.headers = { ...(config.headers ?? {}), Authorization: `${scheme} ${token.accessToken}` };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
