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

export type AuthorizationServer = oauth.AuthorizationServer;
export type ResourceServer = oauth.ResourceServer;

const ACCEPT_JSON = { Accept: 'application/json' } as const;

/**
 * Issue a GET against the MCP server URL and parse the
 * `WWW-Authenticate` header for a `resource_metadata` parameter.
 *
 * Returns null if the server didn't return that header.
 */
export async function probeResourceMetadataUrl(serverUrl: string): Promise<string | null> {
  const res = await fetch(serverUrl, {
    method: 'GET',
    headers: { Accept: 'application/json, text/event-stream' },
  });
  await res.body?.cancel().catch(() => {});

  const header = res.headers.get('www-authenticate');
  if (!header) return null;
  return parseResourceMetadataParam(header);
}

/**
 * Parse `WWW-Authenticate` header values for the first `resource_metadata`
 * parameter (RFC 9728 §5.1). The header may contain multiple challenges
 * separated by commas; we accept any Bearer challenge.
 */
export function parseResourceMetadataParam(header: string): string | null {
  const match = header.match(/resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
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
  const res = await fetch(metadataUrl, { headers: ACCEPT_JSON });
  if (!res.ok) {
    throw new Error(`Failed to fetch protected-resource metadata at ${metadataUrl}: HTTP ${res.status}`);
  }
  return oauth.processResourceDiscoveryResponse(new URL(expectedResource), res);
}

/**
 * Fetch RFC 8414 authorization-server metadata. Tries the OAuth 2.0
 * well-known URL first, then OIDC's.
 */
export async function fetchAuthServerMetadata(issuer: string): Promise<AuthorizationServer> {
  const issuerUrl = new URL(issuer);
  let lastError: unknown = null;
  for (const algorithm of ['oauth2', 'oidc'] as const) {
    try {
      const res = await oauth.discoveryRequest(issuerUrl, { algorithm });
      return await oauth.processDiscoveryResponse(issuerUrl, res);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not fetch authorization-server metadata from ${issuer}: ${stringifyError(lastError)}`,
  );
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return 'unknown error';
  return String(err);
}
