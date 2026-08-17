import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('user OAuth grant/refresh serialization', () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-user-token-lock-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('prevents an old in-flight refresh from overwriting a new callback grant', async () => {
    const storage = await import('../storage.js');
    const refresh = await import('../refresh.js');
    const now = Math.floor(Date.now() / 1000);
    const resource = 'https://mcp.example.com/mcp';
    const redirectUri = 'https://archie.example.com/oauth/callback';
    await storage.writeOAuthClientRecord({
      server_name: 'notion', issuer: 'https://auth.example.com', resource,
      redirect_uri: redirectUri, created_at: now, updated_at: now,
    }, { client_id: 'client', client_secret: 'secret' });
    await storage.writeUserOAuthRecord({
      server_name: 'notion', slack_user_id: 'U1', expires_at: now - 1,
      created_at: now - 3600, updated_at: now - 3600, issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token', scopes: ['read'], resource,
      redirect_uri: redirectUri,
    }, { access_token: 'AT-old', refresh_token: 'RT-old', token_type: 'Bearer' });

    let releaseRefresh!: () => void;
    const refreshResponse = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    globalThis.fetch = vi.fn(async () => {
      await refreshResponse;
      return new Response(JSON.stringify({
        access_token: 'AT-refreshed-old', refresh_token: 'RT-refreshed-old',
        token_type: 'Bearer', expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const refreshing = refresh.ensureFreshUserToken('U1', 'notion', resource);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());

    let callbackStored = false;
    const callback = refresh.storeUserOAuthGrant({
      server_name: 'notion', slack_user_id: 'U1', expires_at: now + 7200,
      created_at: now, updated_at: now, issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token', scopes: ['read', 'write'], resource,
      redirect_uri: redirectUri,
    }, { access_token: 'AT-callback', refresh_token: 'RT-callback', token_type: 'Bearer' })
      .then(() => { callbackStored = true; });

    await Promise.resolve();
    expect(callbackStored).toBe(false);
    releaseRefresh();
    await Promise.all([refreshing, callback]);

    const finalRecord = await storage.readUserOAuthRecord('U1', 'notion');
    const finalSealed = await storage.readUserOAuthSealed(finalRecord!);
    expect(finalSealed.access_token).toBe('AT-callback');
    expect(finalSealed.refresh_token).toBe('RT-callback');
    expect(finalRecord?.scopes).toEqual(['read', 'write']);
  });
});
