import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// IMPORTANT: set ARCHIE_SECRETS_DIR before importing modules that resolve
// SECRETS_DIR at import time.
const tempDirPlaceholder = join(tmpdir(), 'archie-refresh-tests');
process.env.ARCHIE_SECRETS_DIR = tempDirPlaceholder;
process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

const { ensureFreshToken, OAuthRecordMissingError, OAuthRefreshError } = await import('../refresh.js');
const { writeOAuthRecord, readOAuthRecord, readOAuthSealed } = await import('../storage.js');

describe('ensureFreshToken', () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-refresh-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    // reload storage module since SECRETS_DIR is captured at import
    vi.resetModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  async function importFresh() {
    const refresh = await import('../refresh.js');
    const storage = await import('../storage.js');
    return { refresh, storage };
  }

  it('throws OAuthRecordMissingError when no record exists', async () => {
    const { refresh } = await importFresh();
    await expect(refresh.ensureFreshToken('absent')).rejects.toBeInstanceOf(refresh.OAuthRecordMissingError);
  });

  it('returns the cached token when not near expiry', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'cached',
        expires_at: nowSec + 3600,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => { fetchCalled = true; return new Response('', { status: 500 }); }) as any;

    const result = await refresh.ensureFreshToken('cached');
    expect(result.accessToken).toBe('AT-old');
    expect(fetchCalled).toBe(false);
  });

  it('refreshes when near expiry, persists the new token, and rotates refresh_token if rotated', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'expiring',
        expires_at: nowSec + 10, // within leeway
        created_at: nowSec - 3600, updated_at: nowSec - 3600,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: ['read'],
      },
      { access_token: 'AT-old', refresh_token: 'RT-old', client_id: 'cli', client_secret: 'sec', token_type: 'Bearer' },
    );

    let bodyCaptured: URLSearchParams | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodyCaptured = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-new' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const result = await refresh.ensureFreshToken('expiring');
    expect(result.accessToken).toBe('AT-new');
    expect(bodyCaptured!.get('grant_type')).toBe('refresh_token');
    expect(bodyCaptured!.get('refresh_token')).toBe('RT-old');

    // Persisted state should reflect the new tokens and a fresh expires_at.
    const reread = await storage.readOAuthRecord('expiring');
    expect(reread).not.toBeNull();
    expect(reread!.expires_at).toBeGreaterThan(nowSec + 60);
    const sealed = await storage.readOAuthSealed(reread!);
    expect(sealed.access_token).toBe('AT-new');
    expect(sealed.refresh_token).toBe('RT-new');
  });

  it('force-refreshes a token that is nowhere near expiry and stamps real timestamps', async () => {
    // Regression: the `oauth:refresh` CLI used to force a refresh by passing a
    // fake far-future `now`, which leaked into updated_at/expires_at (the
    // "-31535788s ago" / "in 372d" bug). With `force`, timestamps stay real.
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'forced',
        expires_at: nowSec + 3600, // plenty of life left — would normally be cached
        created_at: nowSec - 600, updated_at: nowSec - 600,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const result = await refresh.ensureFreshToken('forced', { force: true });
    expect(fetchCalled).toBe(true); // force bypasses the freshness short-circuit
    expect(result.accessToken).toBe('AT-new');

    const reread = await storage.readOAuthRecord('forced');
    // updated_at must be ~real now, never a far-future sentinel.
    expect(reread!.updated_at).toBeGreaterThanOrEqual(nowSec);
    expect(reread!.updated_at).toBeLessThan(nowSec + 5);
    // expires_at must be ~now + expires_in (600s), not a year-plus out.
    expect(reread!.expires_at).toBeGreaterThanOrEqual(nowSec + 595);
    expect(reread!.expires_at).toBeLessThan(nowSec + 700);
    expect(result.expiresAt).toBe(reread!.expires_at);
  });

  it('replays the stored RFC 8707 resource indicator on refresh and carries it forward', async () => {
    // Regression: without resource on the refresh request, an audience-enforcing
    // resource server (e.g. Monday) rejects the rotated token with 401 even
    // though the refresh itself returned 200.
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'audience',
        expires_at: nowSec + 5,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
        resource: 'https://mcp.example.com/mcp',
      },
      { access_token: 'AT-old', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    let bodyCaptured: URLSearchParams | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodyCaptured = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    await refresh.ensureFreshToken('audience');
    expect(bodyCaptured!.get('grant_type')).toBe('refresh_token');
    expect(bodyCaptured!.get('resource')).toBe('https://mcp.example.com/mcp');
    // The indicator survives the rotated record so the next refresh replays it too.
    const reread = await storage.readOAuthRecord('audience');
    expect(reread!.resource).toBe('https://mcp.example.com/mcp');
  });

  it('omits the resource parameter on refresh for legacy records without one', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'legacy',
        expires_at: nowSec + 5,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    let bodyCaptured: URLSearchParams | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodyCaptured = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    await refresh.ensureFreshToken('legacy');
    expect(bodyCaptured!.has('resource')).toBe(false);
  });

  it('keeps the old refresh_token when the issuer does not rotate it', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'no-rotation',
        expires_at: nowSec + 5,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'RT-keep', client_id: 'cli', token_type: 'Bearer' },
    );
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    await refresh.ensureFreshToken('no-rotation');
    const reread = await storage.readOAuthRecord('no-rotation');
    const sealed = await storage.readOAuthSealed(reread!);
    expect(sealed.refresh_token).toBe('RT-keep');
  });

  it('wraps refresh failures in OAuthRefreshError', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'broken',
        expires_at: nowSec + 5,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'BAD', client_id: 'cli', token_type: 'Bearer' },
    );
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    await expect(refresh.ensureFreshToken('broken')).rejects.toBeInstanceOf(refresh.OAuthRefreshError);
  });

  it('serialises concurrent refreshes for the same server', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthRecord(
      {
        server_name: 'concurrent',
        expires_at: nowSec + 5,
        created_at: nowSec, updated_at: nowSec,
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        scopes: [],
      },
      { access_token: 'AT-old', refresh_token: 'RT', client_id: 'cli', token_type: 'Bearer' },
    );
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({ access_token: `AT-${calls}`, token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const results = await Promise.all([
      refresh.ensureFreshToken('concurrent'),
      refresh.ensureFreshToken('concurrent'),
      refresh.ensureFreshToken('concurrent'),
    ]);
    // The first call refreshes; the next two see a fresh token and skip the network.
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
  });
});
