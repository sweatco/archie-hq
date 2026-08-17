import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

process.env.ARCHIE_SECRETS_DIR = join(tmpdir(), 'archie-inject-tests-placeholder');
process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('applyOAuthBindings', () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-inject-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  async function load() {
    const inject = await import('../inject.js');
    const storage = await import('../storage.js');
    return { inject, storage };
  }

  it('injects Bearer headers on http servers with vault records', async () => {
    const { inject, storage } = await load();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'notion',
        expires_at: nowSec + 3600,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.notion.com',
        token_endpoint: 'https://auth.notion.com/token',
        scopes: [],
      },
      { access_token: 'AT', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );

    const mcp = {
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      builtin: { type: 'sdk', tools: [] },
    };
    const result = await inject.applyOAuthBindings(mcp);
    expect(result.injected).toEqual(['notion']);
    expect(mcp.notion).toMatchObject({
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
      headers: { Authorization: 'Bearer AT' },
    });
    // Built-in (non-http) servers are untouched.
    expect(mcp.builtin).toEqual({ type: 'sdk', tools: [] });
  });

  it('leaves credential-less servers untouched when the probe says no OAuth', async () => {
    const { inject } = await load();
    // Probe returns 200 without WWW-Authenticate → 'open' → untouched.
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as any;
    const mcp = {
      no_creds: { type: 'http', url: 'https://open.example.com/mcp' },
    };
    const result = await inject.applyOAuthBindings(mcp, 'U1');
    expect(result.injected).toEqual([]);
    expect(result.requestable).toEqual([]);
    expect((mcp.no_creds as any).headers).toBeUndefined();
    expect(mcp.no_creds).toBeDefined();
  });

  it('holds back credential-less servers that require OAuth as requestable', async () => {
    const { inject } = await load();
    // Spec probe: 401 with resource_metadata → the server needs OAuth.
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://oauth.example.com/mcp') {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://oauth.example.com/.well-known/oauth-protected-resource"' },
        });
      }
      return new Response(JSON.stringify({
        resource: 'https://oauth.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const mcp: Record<string, any> = {
      needs_auth: { type: 'http', url: 'https://oauth.example.com/mcp' },
    };
    const result = await inject.applyOAuthBindings(mcp, 'U1');
    expect(result.requestable).toEqual(['needs_auth']);
    expect(mcp.needs_auth).toBeUndefined();
  });

  it('does not overwrite operator-supplied Authorization headers', async () => {
    const { inject, storage } = await load();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'manual',
        expires_at: nowSec + 3600,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
        resource: 'https://mcp.example.com/mcp',
        redirect_uri: 'https://archie.example.com/oauth/callback',
      },
      { access_token: 'VAULT', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    const mcp = {
      manual: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer manual-token' } },
    };
    await inject.applyOAuthBindings(mcp);
    expect((mcp.manual as any).headers.Authorization).toBe('Bearer manual-token');
  });

  it('drops servers whose refresh fails', async () => {
    const { inject, storage } = await load();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'broken',
        expires_at: nowSec + 5, // within leeway → triggers refresh
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT', refresh_token: 'BAD', client_id: 'cli', token_type: 'Bearer' },
    );
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    const mcp: Record<string, any> = {
      broken: { type: 'http', url: 'https://example.com' },
      keep: { type: 'sdk', tools: [] },
    };
    const result = await inject.applyOAuthBindings(mcp);
    expect(result.dropped.map((d) => d.serverName)).toEqual(['broken']);
    expect(mcp.broken).toBeUndefined();
    expect(mcp.keep).toBeDefined();
  });

  // ---- DM-only per-user tokens ----

  const nowSec = () => Math.floor(Date.now() / 1000);
  const resource = 'https://mcp.example.com/mcp';
  const redirectUri = 'https://archie.example.com/oauth/callback';

  async function seedShared(storage: any, server: string, accessToken: string) {
    await storage.writeOAuthRecord(
      {
        server_name: server,
        expires_at: nowSec() + 3600,
        created_at: nowSec(), updated_at: nowSec(),
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: accessToken, refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
  }

  async function seedUser(storage: any, uid: string, server: string, accessToken: string, expiresInSec = 3600) {
    await storage.writeOAuthClientRecord(
      {
        server_name: server,
        issuer: 'https://auth.example.com',
        resource,
        redirect_uri: redirectUri,
        created_at: nowSec(),
        updated_at: nowSec(),
      },
      { client_id: 'shared-client' },
    );
    await storage.writeUserOAuthRecord(
      {
        server_name: server,
        slack_user_id: uid,
        expires_at: nowSec() + expiresInSec,
        created_at: nowSec(), updated_at: nowSec(),
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
        resource,
        redirect_uri: redirectUri,
      },
      { access_token: accessToken, refresh_token: 'RT-u', token_type: 'Bearer' },
    );
  }

  it('a DM prefers usable shared credentials even when a personal token exists', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1');

    expect(result.injected).toEqual(['notion']);
    expect(result.sharedInjected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer SHARED');
  });

  it('a DM uses the personal token after that server is explicitly escalated', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1', ['notion']);

    expect(result.injected).toEqual(['notion']);
    expect(result.sharedInjected).toEqual([]);
    expect(mcp.notion.headers.Authorization).toBe('Bearer USER-TOKEN');
  });

  it.each(['Authorization', 'authorization'])(
    'personal selection overrides a configured %s header',
    async (headerName) => {
      const { inject, storage } = await load();
      await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');
      const mcp: Record<string, any> = {
        notion: {
          type: 'http',
          url: resource,
          headers: { [headerName]: 'Bearer STATIC', 'X-Keep': 'yes' },
        },
      };

      const result = await inject.applyOAuthBindings(mcp, 'U1', ['notion']);

      expect(result.injected).toEqual(['notion']);
      expect(result.sharedInjected).toEqual([]);
      expect(mcp.notion.headers).toEqual({ 'X-Keep': 'yes', Authorization: 'Bearer USER-TOKEN' });
    },
  );

  it('does not fall back to a configured header when selected personal credentials are missing', async () => {
    const { inject } = await load();
    const mcp: Record<string, any> = {
      notion: { type: 'http', url: resource, headers: { Authorization: 'Bearer STATIC' } },
    };

    const result = await inject.applyOAuthBindings(mcp, 'U1', ['notion']);

    expect(result.requestable).toEqual(['notion']);
    expect(result.dropped.map((failure) => failure.serverName)).toEqual(['notion']);
    expect(mcp.notion).toBeUndefined();
  });

  it('does not inject a personal token bound to a different resource', async () => {
    const { inject, storage } = await load();
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');
    const mcp: Record<string, any> = {
      notion: { type: 'http', url: 'https://replacement.example.com/mcp' },
    };

    const result = await inject.applyOAuthBindings(mcp, 'U1', ['notion']);

    expect(result.requestable).toEqual(['notion']);
    expect(result.dropped.map((failure) => failure.serverName)).toEqual(['notion']);
    expect(mcp.notion).toBeUndefined();
  });

  it('a DM without a user token continues with usable shared credentials', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1');

    expect(result.requestable).toEqual([]);
    expect(result.injected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer SHARED');
  });

  it('a DM whose user-token refresh fails requests authorization again', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    const nsec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      {
        server_name: 'notion',
        issuer: 'https://auth.example.com',
        resource: 'https://mcp.example.com/mcp',
        redirect_uri: 'https://archie.example.com/oauth/callback',
        created_at: nsec,
        updated_at: nsec,
      },
      { client_id: 'shared-client' },
    );
    await seedUser(storage, 'U1', 'notion', 'STALE', 5); // within refresh leeway
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1', ['notion']);

    expect(result.requestable).toEqual(['notion']);
    expect(result.dropped.map((d) => d.serverName)).toEqual(['notion']);
    expect(mcp.notion).toBeUndefined();
  });

  it('uses the DM participant\'s stored token when no shared record exists', async () => {
    const { inject, storage } = await load();
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1');

    expect(result.injected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer USER-TOKEN');
  });

  it('falls back to a DM personal token when shared credentials cannot refresh', async () => {
    const { inject, storage } = await load();
    const nsec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'notion',
        expires_at: nsec + 5,
        created_at: nsec, updated_at: nsec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'STALE', refresh_token: 'BAD', client_id: 'cli', token_type: 'Bearer' },
    );
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, 'U1');

    expect(result.sharedInjected).toEqual([]);
    expect(result.injected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer USER-TOKEN');
  });

  it('non-DM tasks continue to use the shared token', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp);

    expect(result.injected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer SHARED');
  });

  it('non-DM tasks ignore per-user token records', async () => {
    const { inject, storage } = await load();
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp);

    expect(result.injected).toEqual([]);
    expect(mcp.notion.headers).toBeUndefined();
  });
});
