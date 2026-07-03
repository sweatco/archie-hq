/**
 * High-level orchestration for connecting an MCP server.
 *
 * Two entry points share the discovery pipeline:
 *
 *   - `beginConnect` — operator CLI: discover → register (or manual client) →
 *     write pending → return authorize URL. Produces a legacy shared record
 *     via the callback handler.
 *   - `beginUserConnect` — daemon-side, Slack-initiated: discover → shared
 *     DCR client (read-or-register `oauth/_clients/<server>.json`) → write a
 *     pending record carrying the (task, request, user) correlation → return
 *     the authorize URL for ephemeral delivery to the clicking user only.
 *
 * The HTTP callback handler in `src/connectors/oauth/routes.ts` picks up the
 * pending record and finishes the exchange for both.
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import * as oauth from 'oauth4webapi';
import { PLUGINS_DIR } from '../workdir.js';
import { logger } from '../logger.js';
import {
  probeResourceMetadataUrl,
  fetchProtectedResourceMetadata,
  fetchAuthServerMetadata,
  type ResourceServer,
} from './discovery.js';
import { registerClient } from './dcr.js';
import { generatePkcePair, generateState, buildAuthorizeUrl } from './flow.js';
import {
  writePendingRecord,
  readOAuthClientRecord,
  readOAuthClientSealed,
  writeOAuthClientRecord,
} from './storage.js';
import { withKeyMutex } from '../secrets-vault.js';
import type { OAuthClientSealed } from './types.js';

export interface ConnectInput {
  serverName: string;
  /** Where the OAuth provider should redirect (the daemon's public URL). */
  redirectUri: string;
  label?: string;
  /** Manual client credentials when the server does not expose DCR. */
  clientId?: string;
  clientSecret?: string;
  /** Optional override for the client_name advertised during DCR. */
  clientName?: string;
}

export interface ConnectResult {
  authorizeUrl: string;
  state: string;
  scopes: string[];
  authServer: oauth.AuthorizationServer;
}

/**
 * Looks up the MCP server's URL in the root .mcp.json (the same file
 * the rest of Archie reads).
 */
export function readMcpServerUrl(serverName: string): string {
  const path = join(PLUGINS_DIR, '.mcp.json');
  if (!existsSync(path)) {
    throw new Error(`Plugins .mcp.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const substituted = raw.replace(/\$\{(MCP_[A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
  const parsed = JSON.parse(substituted) as { mcpServers?: Record<string, { type?: string; url?: string }> };
  const entry = parsed.mcpServers?.[serverName];
  if (!entry) {
    throw new Error(`MCP server "${serverName}" not found in ${path}`);
  }
  if (entry.type !== 'http' && entry.type !== 'sse') {
    throw new Error(
      `MCP server "${serverName}" has type "${entry.type ?? 'stdio'}" — OAuth only applies to http/sse transports`,
    );
  }
  if (!entry.url) {
    throw new Error(`MCP server "${serverName}" has no URL in ${path}`);
  }
  return entry.url;
}

/**
 * Public redirect URI for this deployment — where providers send the browser
 * back. Shared by the CLI and daemon flows so both register/authorize against
 * the same callback.
 */
export function resolveRedirectUri(): string {
  const publicUrl = process.env.ARCHIE_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error(
      'ARCHIE_PUBLIC_URL is not set. Set it to the public HTTPS URL where the daemon is reachable, ' +
      'e.g. https://archie.example.com',
    );
  }
  return new URL(`${publicUrl.replace(/\/+$/, '')}/oauth/callback`).toString();
}

export interface DiscoveredServer {
  serverUrl: string;
  resource: ResourceServer;
  authServer: oauth.AuthorizationServer;
  scopes: string[];
  /** RFC 8707 resource indicator — the audience the resource server enforces. */
  resourceIndicator: string;
}

/**
 * The MCP authorization discovery pipeline for a configured server:
 * probe → protected-resource metadata → auth-server metadata → sanity checks
 * (S256 PKCE, required endpoints). Shared by the operator CLI connect and the
 * daemon-side per-user connect.
 */
export async function discoverServer(serverName: string): Promise<DiscoveredServer> {
  const serverUrl = readMcpServerUrl(serverName);
  logger.system(`OAuth connect "${serverName}": probing ${serverUrl}`);

  const resourceMetadataUrl = await probeResourceMetadataUrl(serverUrl);
  if (!resourceMetadataUrl) {
    throw new Error(
      `MCP server "${serverName}" did not advertise a WWW-Authenticate header with resource_metadata. ` +
      `It may not require OAuth or may not be spec-compliant.`,
    );
  }
  logger.system(`OAuth connect "${serverName}": fetching resource metadata from ${resourceMetadataUrl}`);
  const resource = await fetchProtectedResourceMetadata(resourceMetadataUrl, serverUrl);

  const authServerUrl = resource.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error(
      `Protected-resource metadata at ${resourceMetadataUrl} did not advertise any authorization_servers`,
    );
  }
  logger.system(`OAuth connect "${serverName}": fetching auth-server metadata from ${authServerUrl}`);
  const authServer = await fetchAuthServerMetadata(authServerUrl);

  // The MCP spec mandates S256 PKCE. If the server advertises supported
  // methods at all, refuse to proceed unless S256 is in the list.
  if (
    authServer.code_challenge_methods_supported &&
    !authServer.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error(
      `Authorization server at ${authServer.issuer} does not advertise S256 PKCE — refusing to use plaintext`,
    );
  }
  if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
    throw new Error(
      `Authorization server at ${authServer.issuer} is missing required endpoints`,
    );
  }

  return {
    serverUrl,
    resource,
    authServer,
    scopes: resource.scopes_supported ?? [],
    // Persisted so it can be replayed on every token-endpoint request (initial
    // exchange + refresh), not just the authorize step.
    resourceIndicator: resource.resource || serverUrl,
  };
}

export async function beginConnect(input: ConnectInput): Promise<ConnectResult> {
  const { serverName, redirectUri } = input;
  const discovered = await discoverServer(serverName);
  const { authServer, resource, scopes, resourceIndicator } = discovered;

  // Acquire client credentials: prefer caller-supplied, otherwise DCR.
  // The operator path deliberately does NOT touch the shared client record —
  // legacy shared connects keep their client bundled in the vault record.
  let clientId = input.clientId;
  let clientSecret = input.clientSecret;
  if (!clientId) {
    if (!authServer.registration_endpoint) {
      throw new Error(
        `Server "${serverName}" does not expose a registration_endpoint. ` +
        `Re-run with --client-id and --client-secret using a manually-registered client.`,
      );
    }
    logger.system(`OAuth connect "${serverName}": registering dynamic client`);
    const registered = await registerClient(authServer, {
      redirectUri,
      clientName: input.clientName ?? `archie-hq (${serverName})`,
      scope: resource.scopes_supported?.join(' '),
    });
    clientId = registered.client_id;
    clientSecret = registered.client_secret;
  }

  const pkce = await generatePkcePair();
  const state = generateState();

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: authServer.authorization_endpoint!,
    clientId,
    redirectUri,
    scope: scopes.length ? scopes.join(' ') : undefined,
    state,
    codeChallenge: pkce.challenge,
    resource: resourceIndicator,
  });

  await writePendingRecord(
    {
      state,
      server_name: serverName,
      label: input.label,
      issuer: authServer.issuer,
      token_endpoint: authServer.token_endpoint!,
      authorization_endpoint: authServer.authorization_endpoint!,
      scopes,
      resource: resourceIndicator,
      redirect_uri: redirectUri,
      created_at: Math.floor(Date.now() / 1000),
    },
    {
      code_verifier: pkce.verifier,
      client_id: clientId,
      client_secret: clientSecret,
    },
  );

  return { authorizeUrl, state, scopes, authServer };
}

// ---- Daemon-side per-user connect --------------------------------------------

/**
 * Read-or-register the shared DCR client for a server. Registered once on the
 * first-ever per-user authorization, then reused by every user (one client,
 * N authorization-code flows). Mutexed so concurrent first clicks share a
 * single registration round-trip.
 */
async function ensureSharedClient(
  serverName: string,
  authServer: oauth.AuthorizationServer,
  resource: ResourceServer,
  redirectUri: string,
): Promise<OAuthClientSealed> {
  return withKeyMutex(`oauth:client:${serverName}`, async () => {
    const existing = await readOAuthClientRecord(serverName);
    if (existing) return readOAuthClientSealed(existing);

    if (!authServer.registration_endpoint) {
      throw new Error(
        `Server "${serverName}" does not expose a registration_endpoint (Dynamic Client Registration). ` +
        `An operator must connect it once via the CLI with --client-id/--client-secret.`,
      );
    }
    logger.system(`OAuth: registering shared dynamic client for "${serverName}"`);
    const registered = await registerClient(authServer, {
      redirectUri,
      clientName: `archie-hq (${serverName})`,
      scope: resource.scopes_supported?.join(' '),
    });
    const nowSec = Math.floor(Date.now() / 1000);
    await writeOAuthClientRecord(
      { server_name: serverName, issuer: authServer.issuer, created_at: nowSec, updated_at: nowSec },
      { client_id: registered.client_id, client_secret: registered.client_secret },
    );
    return { client_id: registered.client_id, client_secret: registered.client_secret };
  });
}

export interface UserConnectInput {
  serverName: string;
  /** The Slack user who clicked the wall button — the future token owner. */
  slackUserId: string;
  /** Correlation back to the parked (task, server) request — see D5a. */
  taskId: string;
  authRequestId: string;
  agentId?: string;
  channelKey?: string;
}

export interface UserConnectResult {
  authorizeUrl: string;
  state: string;
}

/**
 * Daemon-side, Slack-initiated connect for one user, triggered by the wall
 * button click. Runs discovery + shared-client resolution + PKCE/state in the
 * daemon (no operator CLI), and writes a pending record carrying the durable
 * correlation tuple so the callback can bind the token to this user and wake
 * exactly this task.
 */
export async function beginUserConnect(input: UserConnectInput): Promise<UserConnectResult> {
  const redirectUri = resolveRedirectUri();
  const discovered = await discoverServer(input.serverName);
  const client = await ensureSharedClient(
    input.serverName,
    discovered.authServer,
    discovered.resource,
    redirectUri,
  );

  const pkce = await generatePkcePair();
  const state = generateState();

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovered.authServer.authorization_endpoint!,
    clientId: client.client_id,
    redirectUri,
    scope: discovered.scopes.length ? discovered.scopes.join(' ') : undefined,
    state,
    codeChallenge: pkce.challenge,
    resource: discovered.resourceIndicator,
  });

  await writePendingRecord(
    {
      state,
      server_name: input.serverName,
      issuer: discovered.authServer.issuer,
      token_endpoint: discovered.authServer.token_endpoint!,
      authorization_endpoint: discovered.authServer.authorization_endpoint!,
      scopes: discovered.scopes,
      resource: discovered.resourceIndicator,
      redirect_uri: redirectUri,
      created_at: Math.floor(Date.now() / 1000),
      slack_user_id: input.slackUserId,
      auth_request_id: input.authRequestId,
      task_id: input.taskId,
      agent_id: input.agentId,
      channel_key: input.channelKey,
    },
    {
      code_verifier: pkce.verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    },
  );

  logger.system(`OAuth: pending authorize for "${input.serverName}" minted for user ${input.slackUserId} (task ${input.taskId})`);
  return { authorizeUrl, state };
}
