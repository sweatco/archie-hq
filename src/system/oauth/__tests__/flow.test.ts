import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import * as oauth from 'oauth4webapi';
import {
  generatePkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  clientAuthFor,
} from '../flow.js';

describe('PKCE primitives', () => {
  it('generates a verifier of the recommended length and a matching S256 challenge', async () => {
    const pair = await generatePkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.method).toBe('S256');
    const expectedChallenge = createHash('sha256')
      .update(pair.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pair.challenge).toBe(expectedChallenge);
  });

  it('produces fresh verifiers each call', async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('generates state tokens with url-safe characters', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('embeds all required params and PKCE challenge', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: 'https://auth.example.com/auth',
      clientId: 'cli',
      redirectUri: 'https://archie.example.com/oauth/callback',
      scope: 'read write',
      state: 'abc',
      codeChallenge: 'chal',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/auth');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('cli');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://archie.example.com/oauth/callback');
    expect(parsed.searchParams.get('scope')).toBe('read write');
    expect(parsed.searchParams.get('state')).toBe('abc');
    expect(parsed.searchParams.get('code_challenge')).toBe('chal');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('preserves existing query string on the authorization endpoint', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: 'https://auth.example.com/auth?audience=x',
      clientId: 'cli',
      redirectUri: 'https://example.com/cb',
      state: 's',
      codeChallenge: 'c',
    });
    expect(new URL(url).searchParams.get('audience')).toBe('x');
  });
});

describe('clientAuthFor', () => {
  it('returns ClientSecretBasic when a secret is provided', () => {
    expect(typeof clientAuthFor('s')).toBe('function');
    expect(clientAuthFor('s')).not.toBe(clientAuthFor(undefined));
  });
});

describe('exchangeCodeForTokens', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const baseAS: oauth.AuthorizationServer = {
    issuer: 'https://auth.example.com',
    token_endpoint: 'https://auth.example.com/token',
  };

  it('POSTs form-encoded params with PKCE verifier and parses the response', async () => {
    let captured: { url: string; body: URLSearchParams; auth: string | null } | null = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const params = new URLSearchParams(init.body);
      const headers = new Headers(init.headers);
      captured = { url: String(url), body: params, auth: headers.get('authorization') };
      return new Response(
        JSON.stringify({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const tokens = await exchangeCodeForTokens({
      as: baseAS,
      client: { client_id: 'cli' },
      clientAuth: clientAuthFor('sec'),
      code: 'CODE',
      state: 'STATE',
      redirectUri: 'https://archie.example.com/oauth/callback',
      codeVerifier: 'VERIFIER',
    });

    expect(tokens.access_token).toBe('AT');
    expect(tokens.refresh_token).toBe('RT');
    expect(tokens.expires_in).toBe(3600);
    expect(captured!.url).toBe('https://auth.example.com/token');
    expect(captured!.body.get('grant_type')).toBe('authorization_code');
    expect(captured!.body.get('code')).toBe('CODE');
    expect(captured!.body.get('code_verifier')).toBe('VERIFIER');
    expect(captured!.body.get('redirect_uri')).toBe('https://archie.example.com/oauth/callback');
    // ClientSecretBasic sends credentials in the Authorization header, not the body.
    expect(captured!.auth).toContain('Basic ');
    expect(captured!.body.has('client_secret')).toBe(false);
  });

  it('omits client_secret for public clients', async () => {
    let body: URLSearchParams | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      body = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({ access_token: 'A', token_type: 'Bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    await exchangeCodeForTokens({
      as: baseAS,
      client: { client_id: 'public' },
      clientAuth: clientAuthFor(undefined),
      code: 'C', state: 's', redirectUri: 'https://archie.example.com/oauth/callback', codeVerifier: 'V',
    });
    expect(body!.has('client_secret')).toBe(false);
  });

  it('surfaces error / error_description from the issuer', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    await expect(exchangeCodeForTokens({
      as: baseAS,
      client: { client_id: 'cli' },
      clientAuth: clientAuthFor(undefined),
      code: 'C', state: 's', redirectUri: 'https://archie.example.com/oauth/callback', codeVerifier: 'V',
    })).rejects.toThrow();
  });
});

describe('refreshAccessToken', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const baseAS: oauth.AuthorizationServer = {
    issuer: 'https://auth.example.com',
    token_endpoint: 'https://auth.example.com/token',
  };

  it('POSTs grant_type=refresh_token with the stored refresh token', async () => {
    let body: URLSearchParams | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      body = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({ access_token: 'A2', token_type: 'Bearer', expires_in: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const tokens = await refreshAccessToken({
      as: baseAS,
      client: { client_id: 'cli' },
      clientAuth: clientAuthFor(undefined),
      refreshToken: 'OLD',
    });
    expect(tokens.access_token).toBe('A2');
    expect(body!.get('grant_type')).toBe('refresh_token');
    expect(body!.get('refresh_token')).toBe('OLD');
    expect(body!.get('client_id')).toBe('cli');
  });

  it('throws on 4xx with the issuer error', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;
    await expect(refreshAccessToken({
      as: baseAS,
      client: { client_id: 'cli' },
      clientAuth: clientAuthFor(undefined),
      refreshToken: 'X',
    })).rejects.toThrow();
  });
});
