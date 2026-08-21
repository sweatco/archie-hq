import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// IMPORTANT: set ARCHIE_SECRETS_DIR before importing modules that resolve
// SECRETS_DIR at import time.
process.env.ARCHIE_SECRETS_DIR = join(tmpdir(), 'archie-refresh-user-tests');
process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('ensureFreshUserToken', () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-refresh-user-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  async function load() {
    const refresh = await import('../refresh.js');
    const storage = await import('../storage.js');
    return { refresh, storage };
  }

  async function seedClient(
    storage: Awaited<ReturnType<typeof load>>['storage'],
    overrides: Partial<{ issuer: string; resource: string; redirect_uri: string }> = {},
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      {
        server_name: 'notion',
        issuer: 'https://auth.example.com',
        resource: 'https://mcp.example.com/mcp',
        redirect_uri: 'https://archie.example.com/oauth/callback',
        created_at: nowSec,
        updated_at: nowSec,
        ...overrides,
      },
      { client_id: 'shared-client', client_secret: 'sec' },
    );
  }

  function seedUserMeta(
    expiresInSec: number,
    overrides: Partial<{ issuer: string; resource: string; redirect_uri: string }> = {},
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      server_name: 'notion',
      slack_user_id: 'U1',
      expires_at: nowSec + expiresInSec,
      created_at: nowSec - 3600,
      updated_at: nowSec - 3600,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: ['read'],
      resource: 'https://mcp.example.com/mcp',
      redirect_uri: 'https://archie.example.com/oauth/callback',
      ...overrides,
    };
  }

  it('throws OAuthUserRecordMissingError when the user has no record', async () => {
    const { refresh } = await load();
    await expect(refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp'))
      .rejects.toBeInstanceOf(refresh.OAuthUserRecordMissingError);
  });

  it('returns the cached token when not near expiry, without touching the network', async () => {
    const { refresh, storage } = await load();
    await seedClient(storage);
    await storage.writeUserOAuthRecord(seedUserMeta(3600), {
      access_token: 'AT-fresh', refresh_token: 'RT', token_type: 'Bearer',
    });
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => { fetchCalled = true; return new Response('', { status: 500 }); }) as any;

    const result = await refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp');
    expect(result.accessToken).toBe('AT-fresh');
    expect(fetchCalled).toBe(false);
  });

  it('refreshes near expiry using the shared client credentials and persists the rotation', async () => {
    const { refresh, storage } = await load();
    await seedClient(storage);
    await storage.writeUserOAuthRecord(seedUserMeta(10), {
      access_token: 'AT-old', refresh_token: 'RT-old', token_type: 'Bearer',
    });

    let authHeader = '';
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      authHeader = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(
        JSON.stringify({
          access_token: 'AT-new', refresh_token: 'RT-new', token_type: 'Bearer',
          expires_in: 3600, scope: 'write read',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const result = await refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp');
    expect(result.accessToken).toBe('AT-new');
    // The refresh must authenticate as the SHARED client (Basic auth carries
    // the client record's id/secret), not per-user creds.
    expect(authHeader).toMatch(/^Basic /);
    // RFC 6749 §2.3.1: id/secret are URL-encoded before base64.
    const decoded = decodeURIComponent(Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf-8'));
    expect(decoded).toBe('shared-client:sec');

    const record = await storage.readUserOAuthRecord('U1', 'notion');
    const sealed = await storage.readUserOAuthSealed(record!);
    expect(sealed.access_token).toBe('AT-new');
    expect(sealed.refresh_token).toBe('RT-new');
    expect(record?.scopes).toEqual(['read', 'write']);
  });

  it('fails with OAuthRefreshError when the shared client registration is missing', async () => {
    const { refresh, storage } = await load();
    await storage.writeUserOAuthRecord(seedUserMeta(10), {
      access_token: 'AT-old', refresh_token: 'RT-old', token_type: 'Bearer',
    });
    await expect(refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp'))
      .rejects.toThrow(/Shared client registration missing/);
  });

  it('fails with OAuthRefreshError when no refresh_token is stored', async () => {
    const { refresh, storage } = await load();
    await seedClient(storage);
    await storage.writeUserOAuthRecord(seedUserMeta(10), {
      access_token: 'AT-old', token_type: 'Bearer',
    });
    await expect(refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp'))
      .rejects.toThrow(/re-authorization required/);
  });

  it.each([
    {
      name: 'configured resource',
      client: {},
      expectedResource: 'https://replacement.example.com/mcp',
    },
    {
      name: 'client issuer',
      client: { issuer: 'https://different-auth.example.com' },
      expectedResource: 'https://mcp.example.com/mcp',
    },
    {
      name: 'client resource',
      client: { resource: 'https://different-mcp.example.com/mcp' },
      expectedResource: 'https://mcp.example.com/mcp',
    },
    {
      name: 'client redirect URI',
      client: { redirect_uri: 'https://different.example.com/oauth/callback' },
      expectedResource: 'https://mcp.example.com/mcp',
    },
  ])('rejects a fresh token whose $name binding does not match', async ({ client, expectedResource }) => {
    const { refresh, storage } = await load();
    await seedClient(storage, client);
    await storage.writeUserOAuthRecord(seedUserMeta(3600), {
      access_token: 'AT-fresh', refresh_token: 'RT', token_type: 'Bearer',
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(refresh.ensureFreshUserToken('U1', 'notion', expectedResource))
      .rejects.toThrow(/do not match the configured resource or client registration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for a legacy user record missing redirect binding', async () => {
    const { refresh, storage } = await load();
    await seedClient(storage);
    const legacyMeta = seedUserMeta(3600) as Partial<ReturnType<typeof seedUserMeta>>;
    delete legacyMeta.redirect_uri;
    await storage.writeUserOAuthRecord(legacyMeta as any, {
      access_token: 'AT-fresh', refresh_token: 'RT', token_type: 'Bearer',
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(refresh.ensureFreshUserToken('U1', 'notion', 'https://mcp.example.com/mcp'))
      .rejects.toThrow(/do not match the configured resource or client registration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
