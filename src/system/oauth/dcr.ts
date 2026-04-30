/**
 * RFC 7591 Dynamic Client Registration via `oauth4webapi`.
 *
 * Announces our redirect URI to the authorization server and returns
 * the credentials it issues. If the server returns 4xx (no support,
 * manual approval required, etc.) the caller surfaces a clear error
 * and offers the manual `--client-id`/`--client-secret` fallback.
 */

import * as oauth from 'oauth4webapi';

export interface DcrRequest {
  redirectUri: string;
  /** Client name shown to admins on consent screens. */
  clientName?: string;
  /** Scope string (space-separated) or omitted to let the server choose. */
  scope?: string;
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

export async function registerClient(
  as: oauth.AuthorizationServer,
  req: DcrRequest,
): Promise<RegisteredClient> {
  if (!as.registration_endpoint) {
    throw new Error(
      `Authorization server "${as.issuer}" does not advertise a registration_endpoint`,
    );
  }

  const metadata: Record<string, unknown> = {
    redirect_uris: [req.redirectUri],
    client_name: req.clientName ?? 'archie-hq',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    application_type: 'web',
  };
  if (req.scope) metadata.scope = req.scope;

  const res = await oauth.dynamicClientRegistrationRequest(as, metadata as any);
  const registered = await oauth.processDynamicClientRegistrationResponse(res);

  return {
    client_id: registered.client_id,
    client_secret: typeof registered.client_secret === 'string' ? registered.client_secret : undefined,
  };
}
