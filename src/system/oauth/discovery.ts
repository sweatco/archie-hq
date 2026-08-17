/**
 * OAuth discovery primitives.
 *
 * Thin layer around `oauth4webapi` for:
 *   - Probing an MCP server URL for `WWW-Authenticate: Bearer
 *     resource_metadata="<url>"` (RFC 9728 §5.1). The lib exposes parsed
 *     challenges only via thrown errors during its requests; for our
 *     plain probe we still parse the header by hand.
 *   - Fetching RFC 9728 protected-resource metadata from a known URL.
 *   - Fetching RFC 8414 authorization-server metadata, with an OIDC
 *     `.well-known/openid-configuration` fallback for issuers that
 *     don't advertise the OAuth document.
 */

import * as oauth from 'oauth4webapi';
import { oauthFetch } from './http.js';

export type AuthorizationServer = oauth.AuthorizationServer;
export type ResourceServer = oauth.ResourceServer;

const ACCEPT_JSON = { Accept: 'application/json' } as const;

export interface OAuthChallenge {
  resourceMetadataUrl: string | null;
  scopes: string[];
  status: number;
}

/**
 * Issue a GET against the MCP server URL and parse the
 * `WWW-Authenticate` header for a `resource_metadata` parameter.
 *
 * Returns null if the server didn't return that header.
 */
export async function probeOAuthChallenge(serverUrl: string): Promise<OAuthChallenge> {
  const res = await oauthFetch(serverUrl, {
    method: 'GET',
    headers: { Accept: 'application/json, text/event-stream' },
  });
  await res.body?.cancel().catch(() => {});

  const header = res.headers.get('www-authenticate');
  return {
    resourceMetadataUrl: header ? parseResourceMetadataParam(header) : null,
    scopes: header ? parseScopeParam(header) : [],
    status: res.status,
  };
}

export async function probeResourceMetadataUrl(serverUrl: string): Promise<string | null> {
  return (await probeOAuthChallenge(serverUrl)).resourceMetadataUrl;
}

/**
 * Parse `WWW-Authenticate` header values for the first `resource_metadata`
 * parameter (RFC 9728 §5.1). The header may contain multiple challenges
 * separated by commas; we accept any Bearer challenge.
 */
export function parseResourceMetadataParam(header: string): string | null {
  const match = header.match(/(?:^|[,\s])resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

export function parseScopeParam(header: string): string[] {
  const match = header.match(/(?:^|[,\s])scope\s*=\s*(?:"([^"]*)"|([^,\s]+))/i);
  const raw = match?.[1] ?? match?.[2] ?? '';
  return [...new Set(raw.split(/\s+/).filter(Boolean))].sort();
}

class MetadataHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Fetch RFC 9728 protected-resource metadata from a known URL and let
 * `oauth4webapi` validate the document (issuer matches, required fields
 * present).
 *
 * `expectedResource` is the MCP server URL; the lib enforces that the
 * metadata's `resource` field matches it.
 */
export async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  expectedResource: string,
): Promise<ResourceServer> {
  const res = await oauthFetch(metadataUrl, { headers: ACCEPT_JSON });
  if (!res.ok) {
    throw new MetadataHttpError(
      res.status,
      `Failed to fetch protected-resource metadata at ${metadataUrl}: HTTP ${res.status}`,
    );
  }
  return oauth.processResourceDiscoveryResponse(new URL(expectedResource), res);
}

export interface ProtectedResourceDiscovery {
  metadataUrl: string;
  resource: ResourceServer;
  challengeScopes: string[];
}

const protectedResourceInFlight = new Map<string, Promise<ProtectedResourceDiscovery | null>>();

function wellKnownResourceUrls(serverUrl: string): string[] {
  const server = new URL(serverUrl);
  const suffix = server.pathname === '/' ? '' : server.pathname;
  return [...new Set([
    new URL(`/.well-known/oauth-protected-resource${suffix}`, server.origin).toString(),
    new URL('/.well-known/oauth-protected-resource', server.origin).toString(),
  ])];
}

async function discoverProtectedResourceUncached(
  serverUrl: string,
): Promise<ProtectedResourceDiscovery | null> {
  const challenge = await probeOAuthChallenge(serverUrl);
  if (challenge.resourceMetadataUrl) {
    return {
      metadataUrl: challenge.resourceMetadataUrl,
      resource: await fetchProtectedResourceMetadata(challenge.resourceMetadataUrl, serverUrl),
      challengeScopes: challenge.scopes,
    };
  }

  for (const metadataUrl of wellKnownResourceUrls(serverUrl)) {
    try {
      return {
        metadataUrl,
        resource: await fetchProtectedResourceMetadata(metadataUrl, serverUrl),
        challengeScopes: challenge.scopes,
      };
    } catch (err) {
      if (err instanceof MetadataHttpError && (err.status === 404 || err.status === 410)) continue;
      throw err;
    }
  }

  if (challenge.status >= 200 && challenge.status < 300) return null;
  throw new Error(
    `MCP server ${serverUrl} returned HTTP ${challenge.status} without usable protected-resource metadata`,
  );
}

export function discoverProtectedResource(
  serverUrl: string,
): Promise<ProtectedResourceDiscovery | null> {
  const key = new URL(serverUrl).toString();
  const existing = protectedResourceInFlight.get(key);
  if (existing) return existing;
  const pending = discoverProtectedResourceUncached(key).finally(() => {
    if (protectedResourceInFlight.get(key) === pending) protectedResourceInFlight.delete(key);
  });
  protectedResourceInFlight.set(key, pending);
  return pending;
}

/**
 * Fetch RFC 8414 authorization-server metadata. Tries the OAuth 2.0
 * well-known URL first, then OIDC's.
 */
const authServerInFlight = new Map<string, Promise<AuthorizationServer>>();

async function fetchAuthServerMetadataUncached(issuer: string): Promise<AuthorizationServer> {
  const issuerUrl = new URL(issuer);
  let lastError: unknown = null;
  for (const algorithm of ['oauth2', 'oidc'] as const) {
    try {
      const res = await oauth.discoveryRequest(issuerUrl, {
        algorithm,
        [oauth.customFetch]: oauthFetch,
      });
      return await oauth.processDiscoveryResponse(issuerUrl, res);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not fetch authorization-server metadata from ${issuer}: ${stringifyError(lastError)}`,
  );
}

export function fetchAuthServerMetadata(issuer: string): Promise<AuthorizationServer> {
  const key = new URL(issuer).toString();
  const existing = authServerInFlight.get(key);
  if (existing) return existing;
  const pending = fetchAuthServerMetadataUncached(key).finally(() => {
    if (authServerInFlight.get(key) === pending) authServerInFlight.delete(key);
  });
  authServerInFlight.set(key, pending);
  return pending;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return 'unknown error';
  return String(err);
}

// ---- Needs-auth classification ----------------------------------------------

export type ServerAuthClass = 'oauth' | 'open' | 'unknown';

interface AuthClassCacheEntry {
  cls: ServerAuthClass;
  at: number;
}

const authClassCache = new Map<string, AuthClassCacheEntry>();
const authClassInFlight = new Map<string, Promise<ServerAuthClass>>();
const AUTH_CLASS_TTL_MS = 10 * 60_000;
// Probe errors are transient (server down, network) — retry much sooner.
const AUTH_CLASS_ERROR_TTL_MS = 60_000;

/**
 * Classify whether an MCP server requires OAuth, using the spec probe
 * (401 + `WWW-Authenticate: … resource_metadata="…"`). Provider-agnostic:
 * this is the only signal, no per-service configuration. Cached per URL so
 * spawn-time checks don't hammer providers.
 */
async function classifyServerAuthUncached(serverUrl: string): Promise<ServerAuthClass> {
  let cls: ServerAuthClass;
  try {
    cls = (await discoverProtectedResource(serverUrl)) ? 'oauth' : 'open';
  } catch {
    cls = 'unknown';
  }
  authClassCache.set(serverUrl, { cls, at: Date.now() });
  return cls;
}

export async function classifyServerAuth(serverUrl: string): Promise<ServerAuthClass> {
  const cached = authClassCache.get(serverUrl);
  if (cached) {
    const ttl = cached.cls === 'unknown' ? AUTH_CLASS_ERROR_TTL_MS : AUTH_CLASS_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.cls;
  }
  const existing = authClassInFlight.get(serverUrl);
  if (existing) return existing;
  const pending = classifyServerAuthUncached(serverUrl).finally(() => {
    if (authClassInFlight.get(serverUrl) === pending) authClassInFlight.delete(serverUrl);
  });
  authClassInFlight.set(serverUrl, pending);
  return pending;
}

/** Test hook — drop all cached classifications. */
export function resetServerAuthClassCache(): void {
  authClassCache.clear();
  authClassInFlight.clear();
  protectedResourceInFlight.clear();
  authServerInFlight.clear();
}
