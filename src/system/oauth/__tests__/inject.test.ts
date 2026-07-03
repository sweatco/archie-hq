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
    const result = await inject.applyOAuthBindings(mcp);
    expect(result.injected).toEqual([]);
    expect(result.requestable).toEqual([]);
    expect((mcp.no_creds as any).headers).toBeUndefined();
    expect(mcp.no_creds).toBeDefined();
  });

  it('holds back credential-less servers that require OAuth as requestable', async () => {
    const { inject } = await load();
    // Spec probe: 401 with resource_metadata → the server needs OAuth.
    globalThis.fetch = vi.fn(async () => new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://oauth.example.com/.well-known/oauth-protected-resource"' },
    })) as any;
    const mcp: Record<string, any> = {
      needs_auth: { type: 'http', url: 'https://oauth.example.com/mcp' },
    };
    const result = await inject.applyOAuthBindings(mcp);
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

  // ---- Per-user precedence (the binding is the policy boundary) ----

  const nowSec = () => Math.floor(Date.now() / 1000);

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
    await storage.writeUserOAuthRecord(
      {
        server_name: server,
        slack_user_id: uid,
        expires_at: nowSec() + expiresInSec,
        created_at: nowSec(), updated_at: nowSec(),
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: accessToken, refresh_token: 'RT-u', token_type: 'Bearer' },
    );
  }

  it('a bound pair uses the acting user\'s token even when a shared token exists', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, { bindings: { notion: 'U1' } });

    expect(result.injected).toEqual(['notion']);
    expect(result.sharedInjected).toEqual([]);
    expect(mcp.notion.headers.Authorization).toBe('Bearer USER-TOKEN');
  });

  it('a bound pair with a revoked token re-walls — no silent shared fallback', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    // U1 is bound but has NO stored record (revoked).

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, { bindings: { notion: 'U1' } });

    expect(result.requestable).toEqual(['notion']);
    expect(result.injected).toEqual([]);
    expect(mcp.notion).toBeUndefined(); // NOT injected with the shared token
  });

  it('a bound pair whose refresh fails re-walls — no silent shared fallback', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');
    const nsec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      { server_name: 'notion', issuer: 'https://auth.example.com', created_at: nsec, updated_at: nsec },
      { client_id: 'shared-client' },
    );
    await seedUser(storage, 'U1', 'notion', 'STALE', 5); // within refresh leeway
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, { bindings: { notion: 'U1' } });

    expect(result.requestable).toEqual(['notion']);
    expect(result.dropped.map((d) => d.serverName)).toEqual(['notion']);
    expect(mcp.notion).toBeUndefined();
  });

  it('auto-binds a single human\'s stored token on an unbound server and reports the bind', async () => {
    const { inject, storage } = await load();
    await seedUser(storage, 'U1', 'notion', 'USER-TOKEN');

    const autoBinds: Array<[string, string]> = [];
    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, {
      autoBindUser: 'U1',
      onAutoBind: (server, uid) => { autoBinds.push([server, uid]); },
    });

    expect(result.injected).toEqual(['notion']);
    expect(autoBinds).toEqual([['notion', 'U1']]);
    expect(mcp.notion.headers.Authorization).toBe('Bearer USER-TOKEN');
  });

  it('unbound servers use the shared token cold and are reported as sharedInjected', async () => {
    const { inject, storage } = await load();
    await seedShared(storage, 'notion', 'SHARED');

    const mcp: Record<string, any> = { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } };
    const result = await inject.applyOAuthBindings(mcp, { autoBindUser: 'U-no-token' });

    expect(result.injected).toEqual(['notion']);
    expect(result.sharedInjected).toEqual(['notion']);
    expect(mcp.notion.headers.Authorization).toBe('Bearer SHARED');
  });
});
