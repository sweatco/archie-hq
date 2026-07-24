/**
 * Shared types for the OAuth subsystem.
 *
 * The vocabulary follows the relevant RFCs:
 *   - RFC 6749 / OAuth 2.1 — authorization code grant
 *   - RFC 7591 — Dynamic Client Registration
 *   - RFC 7636 — PKCE
 *   - RFC 8414 — Authorization Server Metadata
 *   - RFC 9728 — Protected Resource Metadata
 */

import type { EncryptedEnvelope } from '../secrets-vault.js';

/** Plaintext metadata in an OAuth vault record. */
export interface OAuthRecordMeta {
  server_name: string;
  label?: string;
  expires_at: number;        // unix seconds
  created_at: number;
  updated_at: number;
  /** Authorization-server issuer URL — needed to reconstruct an AS for refresh. */
  issuer: string;
  token_endpoint: string;
  scopes: string[];
  /**
   * RFC 8707 resource indicator (the MCP server's canonical URL). Replayed on
   * every token-endpoint request so refreshed tokens keep the audience binding
   * the resource server enforces. Optional: records connected before this was
   * tracked won't have it — reconnect to populate.
   */
  resource?: string;
}

/** What we encrypt inside the OAuth vault record. */
export interface OAuthSealed {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret?: string;
  token_type: string;        // typically "Bearer"
}

/** On-disk representation of a connected MCP server. */
export interface OAuthRecord extends OAuthRecordMeta {
  envelope: EncryptedEnvelope;
}

/**
 * Plaintext metadata for a per-user token record
 * (`oauth/users/<slackUserId>/<server>.json`).
 */
export interface OAuthUserRecordMeta extends OAuthRecordMeta {
  slack_user_id: string;
}

/**
 * What we encrypt inside a per-user token record. Unlike the legacy shared
 * `OAuthSealed`, client credentials are NOT bundled here — they live in the
 * shared client record so one DCR registration serves every user.
 */
export interface OAuthUserSealed {
  access_token: string;
  refresh_token?: string;
  token_type: string;
}

/** On-disk representation of one user's connection to an MCP server. */
export interface OAuthUserRecord extends OAuthUserRecordMeta {
  envelope: EncryptedEnvelope;
}

/**
 * Plaintext metadata for a server's shared DCR client registration
 * (`oauth/_clients/<server>.json`). Registered once on the first per-user
 * authorization, then reused by every user of that server.
 */
export interface OAuthClientMeta {
  server_name: string;
  issuer: string;
  created_at: number;
  updated_at: number;
}

/** What we encrypt inside a shared client record. */
export interface OAuthClientSealed {
  client_id: string;
  client_secret?: string;
}

/** On-disk representation of a shared DCR client registration. */
export interface OAuthClientRecord extends OAuthClientMeta {
  envelope: EncryptedEnvelope;
}

/** What the CLI persists for the daemon's callback handler to pick up. */
export interface OAuthPendingMeta {
  state: string;
  server_name: string;
  label?: string;
  /** Authorization-server issuer URL — used to reconstruct the AS object. */
  issuer: string;
  token_endpoint: string;
  authorization_endpoint: string;
  scopes: string[];
  /** RFC 8707 resource indicator, carried from connect through to the token exchange. */
  resource?: string;
  redirect_uri: string;
  created_at: number;
  /** DM-only per-user flows. Absent on operator/CLI connects. */
  slack_user_id?: string;
  task_id?: string;
}

/** Encrypted half of a pending file (verifier + client creds). */
export interface OAuthPendingSealed {
  code_verifier: string;
  client_id: string;
  client_secret?: string;
}

/** On-disk representation of an in-flight OAuth attempt. */
export interface OAuthPendingRecord extends OAuthPendingMeta {
  envelope: EncryptedEnvelope;
  /** Set by the callback handler when the exchange fails — CLI surfaces it. */
  error?: string;
  /** Set by the callback handler on success — CLI uses it to detect completion. */
  completed_at?: number;
}
