/**
 * Generic OAuth 2.1 / PKCE primitives backed by `oauth4webapi`.
 *
 * The library handles:
 *   - PKCE verifier + S256 challenge generation
 *   - Issuer-validated token endpoint requests (auth-code + refresh)
 *   - `client_secret_basic` / `client_secret_post` / `none` selection
 *
 * We still build the authorize URL by hand — the spec is short, and
 * keeping it explicit makes the flow easy to read.
 */

import * as oauth from 'oauth4webapi';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export async function generatePkcePair(): Promise<PkcePair> {
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  return { verifier, challenge, method: 'S256' };
}

export function generateState(): string {
  return oauth.generateRandomState();
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  codeChallenge: string;
  /** Optional `resource` parameter (RFC 8707). */
  resource?: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.scope) url.searchParams.set('scope', input.scope);
  if (input.resource) url.searchParams.set('resource', input.resource);
  return url.toString();
}

/**
 * Build the authentication strategy for a token endpoint POST.
 * Confidential clients use HTTP Basic; public clients send `none`.
 */
export function clientAuthFor(clientSecret: string | undefined): oauth.ClientAuth {
  return clientSecret ? oauth.ClientSecretBasic(clientSecret) : oauth.None();
}

export interface TokenExchangeInput {
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  clientAuth: oauth.ClientAuth;
  code: string;
  state: string;
  redirectUri: string;
  codeVerifier: string;
  /** RFC 8707 resource indicator — audience-binds the issued token. */
  resource?: string;
}

/**
 * Exchange an authorization code for tokens at the token endpoint.
 * Validates the callback parameters (state + error checks) before the
 * exchange.
 */
export async function exchangeCodeForTokens(input: TokenExchangeInput): Promise<oauth.TokenEndpointResponse> {
  const params = new URLSearchParams({ code: input.code, state: input.state });
  const validated = oauth.validateAuthResponse(input.as, input.client, params, input.state);
  const res = await oauth.authorizationCodeGrantRequest(
    input.as,
    input.client,
    input.clientAuth,
    validated,
    input.redirectUri,
    input.codeVerifier,
    input.resource ? { additionalParameters: { resource: input.resource } } : undefined,
  );
  return await oauth.processAuthorizationCodeResponse(input.as, input.client, res);
}

export interface RefreshInput {
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  clientAuth: oauth.ClientAuth;
  refreshToken: string;
  /** RFC 8707 resource indicator — must be replayed so the rotated token keeps its audience. */
  resource?: string;
}

export async function refreshAccessToken(input: RefreshInput): Promise<oauth.TokenEndpointResponse> {
  const res = await oauth.refreshTokenGrantRequest(
    input.as,
    input.client,
    input.clientAuth,
    input.refreshToken,
    input.resource ? { additionalParameters: { resource: input.resource } } : undefined,
  );
  return await oauth.processRefreshTokenResponse(input.as, input.client, res);
}
