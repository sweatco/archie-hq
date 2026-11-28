/**
 * Authorizing a persona: the URL the member opens, reading the code off the URL Slack
 * redirects to, exchanging it, and deciding whether the resulting grant belongs to that persona.
 */

import type { Persona, PersonaConfig } from './config.js';

// Must match oauth_config.scopes.user in slack-manifest.yaml: Slack grants only scopes the
// app declares.
export const PERSONA_USER_SCOPES = [
  'chat:write',
  'reactions:read',
  'reactions:write',
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'users:read',
] as const;

export function buildAuthorizeUrl(config: PersonaConfig, state: string): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', config.personaApp.clientId);
  url.searchParams.set('user_scope', PERSONA_USER_SCOPES.join(','));
  url.searchParams.set('redirect_uri', config.personaApp.redirectUrl);
  url.searchParams.set('team', config.teamId);
  url.searchParams.set('state', state);
  return url.toString();
}

/** Read the authorization code from the URL the browser landed on after the member approved. */
export function readAuthorizationCode(redirectedUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirectedUrl.trim());
  } catch (error) {
    throw new Error('that is not a URL: paste the whole address from the browser', {
      cause: error,
    });
  }
  const denied = url.searchParams.get('error');
  if (denied) throw new Error(`Slack reported "${denied}": the member did not approve the app`);
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('the state does not match this run: open the URL printed by this command');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('the URL has no code parameter');
  return code;
}

/** The fields of an `oauth.v2.access` response this tool relies on. */
export interface OAuthAccessResponse {
  ok?: boolean;
  error?: string;
  team?: { id?: string };
  authed_user?: { id?: string; scope?: string; access_token?: string };
}

/** Trade the authorization code for the member's user token. The code is valid for ten minutes. */
export async function exchangeAuthorizationCode(
  app: PersonaConfig['personaApp'],
  clientSecret: string,
  code: string,
  send: typeof fetch = fetch,
): Promise<OAuthAccessResponse> {
  const response = await send('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: app.redirectUrl,
    }),
  });
  if (!response.ok) throw new Error(`Slack answered ${response.status} to the code exchange`);
  return (await response.json()) as OAuthAccessResponse;
}

export type GrantCheck =
  { ok: true; token: string; missingScopes: string[] } | { ok: false; detail: string };

/**
 * Accept a grant only when it is for the configured workspace and the intended member.
 * The browser decides who approves, so a grant made while signed in as someone else must
 * never be stored under this persona.
 */
export function checkGrant(
  response: OAuthAccessResponse,
  expected: { teamId: string; persona: Persona },
): GrantCheck {
  if (!response.ok) return { ok: false, detail: `Slack refused the code: ${response.error}` };
  if (response.team?.id !== expected.teamId) {
    return {
      ok: false,
      detail: `the grant is for workspace ${response.team?.id ?? 'unknown'}, not the configured ${expected.teamId}`,
    };
  }
  const user = response.authed_user;
  if (user?.id !== expected.persona.slackUserId) {
    return {
      ok: false,
      detail: `the browser was signed in as ${user?.id ?? 'unknown'}, not "${expected.persona.key}" (${expected.persona.slackUserId})`,
    };
  }
  if (!user.access_token) return { ok: false, detail: 'the grant carries no user token' };
  const granted = new Set((user.scope ?? '').split(','));
  const missingScopes = PERSONA_USER_SCOPES.filter((scope) => !granted.has(scope));
  return { ok: true, token: user.access_token, missingScopes };
}
