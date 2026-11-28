import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parsePersonaConfig } from './config.js';
import {
  buildAuthorizeUrl,
  checkGrant,
  exchangeAuthorizationCode,
  PERSONA_USER_SCOPES,
  readAuthorizationCode,
} from './oauth-grant.js';

const config = parsePersonaConfig(
  JSON.stringify({
    environment: 'staging',
    teamId: 'T0TEST00001',
    archieBotUserId: 'U0ARCHIE001',
    personaApp: {
      clientId: '111.222',
      clientSecret: 'env:PERSONA_CLIENT_SECRET',
      redirectUrl: 'https://localhost/archie-personas/oauth',
    },
    personas: [{ key: 'alice', slackUserId: 'U0ALICE0001', token: 'env:ALICE' }],
  }),
);
const expected = { teamId: config.teamId, persona: config.personas[0] };
const allScopes = PERSONA_USER_SCOPES.join(',');

describe('buildAuthorizeUrl', () => {
  it('asks for user scopes in the configured workspace and carries the state', () => {
    const url = new URL(buildAuthorizeUrl(config, 'state-1'));
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(allScopes);
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('team')).toBe('T0TEST00001');
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost/archie-personas/oauth');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('requests exactly the scopes the manifest declares', () => {
    const manifest = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'slack-manifest.yaml'),
      'utf-8',
    );
    const userScopes = manifest.slice(manifest.indexOf('    user:'), manifest.indexOf('settings:'));
    const declared = [...userScopes.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]);
    expect(declared).toEqual([...PERSONA_USER_SCOPES]);
  });
});

describe('readAuthorizationCode', () => {
  it('reads the code from the redirected URL', () => {
    const pasted = ' https://localhost/archie-personas/oauth?code=abc.123&state=state-1 \n';
    expect(readAuthorizationCode(pasted, 'state-1')).toBe('abc.123');
  });

  it('refuses a URL from another run', () => {
    expect(() =>
      readAuthorizationCode('https://localhost/x?code=abc&state=other', 'state-1'),
    ).toThrow(/state does not match/);
  });

  it('explains a denial, a missing code and a non-URL', () => {
    expect(() =>
      readAuthorizationCode('https://localhost/x?error=access_denied&state=state-1', 'state-1'),
    ).toThrow(/access_denied/);
    expect(() => readAuthorizationCode('https://localhost/x?state=state-1', 'state-1')).toThrow(
      /no code parameter/,
    );
    expect(() => readAuthorizationCode('abc.123', 'state-1')).toThrow(/not a URL/);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code with the app credentials and the same redirect URL to oauth.v2.access', async () => {
    const sent: Array<{ url: string; method?: string; body: string }> = [];
    const send = ((url: string, init: { method?: string; body: URLSearchParams }) => {
      sent.push({ url, method: init.method, body: init.body.toString() });
      return Promise.resolve(Response.json({ ok: true, team: { id: 'T0TEST00001' } }));
    }) as typeof fetch;

    const response = await exchangeAuthorizationCode(
      config.personaApp,
      'app-secret',
      'abc.123',
      send,
    );
    expect(response).toEqual({ ok: true, team: { id: 'T0TEST00001' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://slack.com/api/oauth.v2.access', method: 'POST' });
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
      client_id: '111.222',
      client_secret: 'app-secret',
      code: 'abc.123',
      redirect_uri: 'https://localhost/archie-personas/oauth',
    });
  });

  it('fails on a transport-level error instead of treating it as a grant', async () => {
    const send = (() => Promise.resolve(new Response('', { status: 503 }))) as typeof fetch;
    await expect(
      exchangeAuthorizationCode(config.personaApp, 'app-secret', 'abc', send),
    ).rejects.toThrow(/answered 503/);
  });
});

describe('checkGrant', () => {
  const grant = {
    ok: true,
    team: { id: 'T0TEST00001' },
    authed_user: { id: 'U0ALICE0001', scope: allScopes, access_token: 'xoxp-test' },
  };

  it('accepts a grant for the configured workspace and member', () => {
    expect(checkGrant(grant, expected)).toEqual({
      ok: true,
      token: 'xoxp-test',
      missingScopes: [],
    });
  });

  it('refuses a grant made while signed in as another member', () => {
    const asAdmin = { ...grant, authed_user: { ...grant.authed_user, id: 'U0ADMIN0001' } };
    const result = checkGrant(asAdmin, expected);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('xoxp-test');
  });

  it('refuses a grant for another workspace', () => {
    expect(checkGrant({ ...grant, team: { id: 'T0OTHER0001' } }, expected)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('T0OTHER0001') as string,
    });
  });

  it('refuses a failed exchange and a grant without a user token', () => {
    expect(checkGrant({ ok: false, error: 'invalid_code' }, expected)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('invalid_code') as string,
    });
    const tokenless = { ...grant, authed_user: { id: 'U0ALICE0001', scope: allScopes } };
    expect(checkGrant(tokenless, expected)).toMatchObject({ ok: false });
  });

  it('names scopes the workspace did not grant', () => {
    const partial = { ...grant, authed_user: { ...grant.authed_user, scope: 'chat:write' } };
    const result = checkGrant(partial, expected);
    expect(result.ok && result.missingScopes).toContain('im:write');
  });
});
