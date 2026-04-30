/**
 * Spawn-time OAuth header injection.
 *
 * Walks the SDK `mcpServers` map. For each http/sse entry that has a
 * vault record, refresh-if-needed and write `Authorization: Bearer <token>`
 * into the entry's headers. Drops entries whose refresh fails so the
 * SDK doesn't try to use them with stale credentials.
 *
 * Built-in MCP servers created in-process (`createBaseAgentMcpServer`,
 * `createResearchMcpServer`, etc.) don't have an `http`/`sse` type, so
 * this function leaves them untouched.
 */

import { logger } from '../logger.js';
import { hasOAuthRecord } from './storage.js';
import { ensureFreshToken } from './refresh.js';

export interface OAuthBindingFailure {
  serverName: string;
  error: Error;
}

export interface OAuthBindingResult {
  injected: string[];
  dropped: OAuthBindingFailure[];
}

/**
 * Mutates `mcpServers` in place, injecting Authorization headers and
 * deleting entries whose refresh fails. Returns a summary so callers
 * can log or alert.
 */
export async function applyOAuthBindings(
  mcpServers: Record<string, any>,
): Promise<OAuthBindingResult> {
  const injected: string[] = [];
  const dropped: OAuthBindingFailure[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isHttpLike(config)) continue;
    if (!(await hasOAuthRecord(name))) continue;

    try {
      const token = await ensureFreshToken(name);
      const existingHeaders = (config.headers ?? {}) as Record<string, string>;
      // Only set if the .mcp.json author hasn't already supplied a token.
      // (Hand-managed creds win — operator intent is explicit.)
      if (!('Authorization' in existingHeaders) && !('authorization' in existingHeaders)) {
        // RFC 6750 says scheme is case-insensitive, but real-world servers
        // (Notion, etc.) strict-match — normalize "bearer" to "Bearer".
        const scheme = /^bearer$/i.test(token.tokenType) ? 'Bearer' : token.tokenType;
        config.headers = { ...existingHeaders, Authorization: `${scheme} ${token.accessToken}` };
      }
      injected.push(name);
    } catch (err) {
      dropped.push({ serverName: name, error: err instanceof Error ? err : new Error(String(err)) });
      delete mcpServers[name];
      logger.error('oauth', `Failed to bind credentials for MCP server "${name}", dropping`, err);
    }
  }

  return { injected, dropped };
}

function isHttpLike(config: unknown): config is { type?: string; headers?: Record<string, string> } {
  if (!config || typeof config !== 'object') return false;
  const type = (config as { type?: unknown }).type;
  return type === 'http' || type === 'sse';
}
