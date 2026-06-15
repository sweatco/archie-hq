/**
 * Token-refresh logic and the `ensureFreshToken` API used at agent
 * spawn time. All concurrent calls for the same server name share one
 * refresh round-trip via the secrets-vault key mutex.
 */

import { withKeyMutex } from '../secrets-vault.js';
import { refreshAccessToken, clientAuthFor } from './flow.js';
import {
  readOAuthRecord,
  readOAuthSealed,
  writeOAuthRecord,
} from './storage.js';
import type { OAuthSealed } from './types.js';

/** Refresh if the token expires within this many seconds. */
const REFRESH_LEEWAY_SECONDS = 60;

export interface FreshToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export class OAuthRecordMissingError extends Error {
  constructor(public readonly serverName: string) {
    super(`No OAuth record for MCP server "${serverName}"`);
  }
}

export class OAuthRefreshError extends Error {
  constructor(public readonly serverName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to refresh OAuth token for "${serverName}": ${reason}`);
  }
}

export interface EnsureFreshTokenOptions {
  /** Current time as unix epoch ms. Overridable for tests; defaults to Date.now(). */
  now?: number;
  /**
   * Refresh regardless of how much life the cached token has left. Used by the
   * `oauth:refresh` CLI to rotate a token on demand. Without this, a caller
   * would have to fake `now` to force a refresh — and that fake value would
   * leak into the stamped `updated_at`/`expires_at`, corrupting the record.
   */
  force?: boolean;
}

/**
 * Read the vault record, refresh if near expiry (or when `force` is set), and
 * return a live access token. Writes back the rotated record atomically.
 * Concurrent callers for the same server name share one refresh.
 */
export async function ensureFreshToken(
  serverName: string,
  options: EnsureFreshTokenOptions = {},
): Promise<FreshToken> {
  const { now = Date.now(), force = false } = options;
  return withKeyMutex(`oauth:${serverName}`, async () => {
    const record = await readOAuthRecord(serverName);
    if (!record) throw new OAuthRecordMissingError(serverName);

    const nowSec = Math.floor(now / 1000);
    if (!force && record.expires_at - nowSec > REFRESH_LEEWAY_SECONDS) {
      const sealed = await readOAuthSealed(record);
      return {
        accessToken: sealed.access_token,
        tokenType: sealed.token_type,
        expiresAt: record.expires_at,
      };
    }

    const sealed = await readOAuthSealed(record);
    if (!sealed.refresh_token) {
      throw new OAuthRefreshError(serverName, new Error('No refresh_token stored — reconnect required'));
    }

    let response;
    try {
      response = await refreshAccessToken({
        as: { issuer: record.issuer, token_endpoint: record.token_endpoint },
        client: { client_id: sealed.client_id },
        clientAuth: clientAuthFor(sealed.client_secret),
        refreshToken: sealed.refresh_token,
        // Replay the RFC 8707 audience binding. Legacy records without a stored
        // resource send nothing (preserving prior behavior); reconnect to populate.
        resource: record.resource,
      });
    } catch (err) {
      throw new OAuthRefreshError(serverName, err);
    }

    const refreshedSealed: OAuthSealed = {
      access_token: response.access_token,
      refresh_token: typeof response.refresh_token === 'string' ? response.refresh_token : sealed.refresh_token,
      client_id: sealed.client_id,
      client_secret: sealed.client_secret,
      token_type: response.token_type,
    };

    const expiresAt = typeof response.expires_in === 'number'
      ? nowSec + response.expires_in
      : record.expires_at; // unknown lifetime — leave as-is so we re-try next time

    await writeOAuthRecord(
      {
        ...record,
        updated_at: nowSec,
        expires_at: expiresAt,
      },
      refreshedSealed,
    );

    return {
      accessToken: response.access_token,
      tokenType: response.token_type,
      expiresAt,
    };
  });
}
