/** Spawn-time OAuth injection. Shared tokens are the default; DMs can escalate per server. */

import { logger } from '../logger.js';
import { hasOAuthRecord, hasUserOAuthRecord } from './storage.js';
import {
  ensureFreshToken,
  ensureFreshUserToken,
  OAuthRecordMissingError,
  OAuthRefreshError,
  OAuthUserRecordMissingError,
  type FreshToken,
} from './refresh.js';
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
    const selectedPersonal = Boolean(dmUserId && personal.has(name));

    const injectUser = async (): Promise<void> => {
      try {
        setAuthHeader(config, await ensureFreshUserToken(dmUserId!, name, config.url!));
        injected.push(name);
      } catch (err) {
        const safeError = sanitizeBindingError(err, 'personal');
        dropped.push({ serverName: name, error: safeError });
        requestable.push(name);
        delete mcpServers[name];
        logger.error('oauth', `MCP "${name}": personal credentials are unusable`, safeError);
      }
    };

    if (selectedPersonal) {
      await injectUser();
      continue;
    }

    // A configured header remains authoritative until this task explicitly
    // selects personal credentials for the server.
    if (hasExplicitAuthHeader(config)) continue;

    if (await hasOAuthRecord(name)) {
      try {
        setAuthHeader(config, await ensureFreshToken(name));
        injected.push(name);
        sharedInjected.push(name);
      } catch (err) {
        if (dmUserId && (await hasUserOAuthRecord(dmUserId, name))) {
          logger.error(
            'oauth',
            `Shared credentials for MCP "${name}" failed; trying the DM participant's token`,
            sanitizeBindingError(err, 'shared'),
          );
          await injectUser();
        } else {
          const safeError = sanitizeBindingError(err, 'shared');
          dropped.push({ serverName: name, error: safeError });
          if (dmUserId) requestable.push(name);
          delete mcpServers[name];
          logger.error('oauth', `Failed to bind shared credentials for MCP server "${name}", dropping`, safeError);
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
  return Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
}

function setAuthHeader(config: { headers?: Record<string, string> }, token: FreshToken): void {
  // RFC 6750 says scheme is case-insensitive, but real-world servers
  // (Notion, etc.) strict-match — normalize "bearer" to "Bearer".
  const scheme = /^bearer$/i.test(token.tokenType) ? 'Bearer' : token.tokenType;
  const headers = Object.fromEntries(
    Object.entries(config.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  config.headers = { ...headers, Authorization: `${scheme} ${token.accessToken}` };
}

function sanitizeBindingError(err: unknown, kind: 'shared' | 'personal'): Error {
  const action = kind === 'shared' ? 'reconnect it as an operator' : 'authorize it again in the DM';
  if (err instanceof OAuthRecordMissingError || err instanceof OAuthUserRecordMissingError) {
    return new Error(`OAuth credentials are missing; ${action}`);
  }
  if (err instanceof OAuthRefreshError) {
    return new Error(`OAuth token refresh failed; ${action}`);
  }
  return new Error(`OAuth credentials could not be loaded; ${action}`);
}
