/**
 * High-level orchestration for connecting an MCP server.
 *
 * Used by the CLI: discover → register → write pending → return
 * authorize URL. The HTTP callback handler in
 * `src/connectors/oauth/routes.ts` picks up the pending record and
 * finishes the exchange.
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
} from './discovery.js';
import { registerClient } from './dcr.js';
import { generatePkcePair, generateState, buildAuthorizeUrl } from './flow.js';
import { writePendingRecord } from './storage.js';

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

export async function beginConnect(input: ConnectInput): Promise<ConnectResult> {
  const { serverName, redirectUri } = input;
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

  // Acquire client credentials: prefer caller-supplied, otherwise DCR.
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

  const pkce = await generatePkcePair();
  const state = generateState();
  const scopes = resource.scopes_supported ?? [];

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: authServer.authorization_endpoint,
    clientId,
    redirectUri,
    scope: scopes.length ? scopes.join(' ') : undefined,
    state,
    codeChallenge: pkce.challenge,
    resource: resource.resource || serverUrl,
  });

  await writePendingRecord(
    {
      state,
      server_name: serverName,
      label: input.label,
      issuer: authServer.issuer,
      token_endpoint: authServer.token_endpoint,
      authorization_endpoint: authServer.authorization_endpoint,
      scopes,
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
