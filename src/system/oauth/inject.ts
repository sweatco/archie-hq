/** Spawn-time OAuth injection. Shared tokens are the default; DMs can escalate per server. */

import { logger } from '../logger.js';
import { hasOAuthRecord, hasUserOAuthRecord } from './storage.js';
import { ensureFreshToken, ensureFreshUserToken, type FreshToken } from './refresh.js';
import { classifyServerAuth } from './discovery.js';

export interface OAuthBindingFailure {
  serverName: string;
  error: Error;
}

export interface OAuthBindingResult {
  injected: string[];
  sharedInjected: string[];
  dropped: OAuthBindingFailure[];
  /** OAuth servers awaiting authorization by the current DM participant. */
  requestable: string[];
}

/**
 * Mutates `mcpServers` in place, injecting Authorization headers and deleting
 * entries that have no usable credential. Returns a summary so callers can
 * log, and the `requestable` set for prompt injection.
 */
export async function applyOAuthBindings(
  mcpServers: Record<string, any>,
  dmUserId: string | null = null,
  personalServers: readonly string[] = [],
): Promise<OAuthBindingResult> {
  const injected: string[] = [];
  const sharedInjected: string[] = [];
  const dropped: OAuthBindingFailure[] = [];
  const requestable: string[] = [];
  const personal = new Set(personalServers);

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isHttpLike(config)) continue;
    // Only act if the .mcp.json author hasn't already supplied a token.
    // (Hand-managed creds win — operator intent is explicit.)
    if (hasExplicitAuthHeader(config)) continue;

    const injectUser = async (): Promise<void> => {
      try {
        setAuthHeader(config, await ensureFreshUserToken(dmUserId!, name));
        injected.push(name);
      } catch (err) {
        dropped.push({ serverName: name, error: toError(err) });
        requestable.push(name);
        delete mcpServers[name];
        logger.error('oauth', `MCP "${name}": user token for ${dmUserId} is unusable`, err);
      }
    };

    if (dmUserId && personal.has(name)) {
      await injectUser();
      continue;
    }

    if (await hasOAuthRecord(name)) {
      try {
        setAuthHeader(config, await ensureFreshToken(name));
        injected.push(name);
        sharedInjected.push(name);
      } catch (err) {
        if (dmUserId && (await hasUserOAuthRecord(dmUserId, name))) {
          logger.error('oauth', `Shared credentials for MCP "${name}" failed; trying ${dmUserId}'s token`, err);
          await injectUser();
        } else {
          dropped.push({ serverName: name, error: toError(err) });
          if (dmUserId) requestable.push(name);
          delete mcpServers[name];
          logger.error('oauth', `Failed to bind shared credentials for MCP server "${name}", dropping`, err);
        }
      }
      continue;
    }

    if (dmUserId) {
      if (await hasUserOAuthRecord(dmUserId, name)) {
        await injectUser();
      } else {
        const url = typeof config.url === 'string' ? config.url : null;
        if (url && (await classifyServerAuth(url)) === 'oauth') {
          requestable.push(name);
          delete mcpServers[name];
        }
      }
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
