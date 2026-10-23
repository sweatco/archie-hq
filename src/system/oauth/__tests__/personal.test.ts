import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

const USER = 'U0OWNER1';

describe('personal OAuth records', () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-personal-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    // SECRETS_DIR is captured at import, so every test imports fresh modules.
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

  function meta(serverName: string, expiresAt: number, nowSec: number) {
    return {
      server_name: serverName,
      slack_user_id: USER,
      expires_at: expiresAt,
      created_at: nowSec,
      updated_at: nowSec,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: ['read'],
    };
  }

  const sealed = { access_token: 'AT-old', refresh_token: 'RT-old', client_id: 'cli', client_secret: 'sec', token_type: 'Bearer' };

  it('round-trips write, read, list and delete', async () => {
    const { storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writePersonalRecord(meta('notion', nowSec + 3600, nowSec), sealed);
    await storage.writePersonalRecord(meta('linear', nowSec + 3600, nowSec), sealed);

    const record = await storage.readPersonalRecord(USER, 'notion');
    expect(record).not.toBeNull();
    expect(record!.slack_user_id).toBe(USER);
    expect(await storage.readOAuthSealed(record!)).toEqual(sealed);

    const listed = await storage.listPersonalRecords(USER);
    expect(listed.map((m) => m.server_name).sort()).toEqual(['linear', 'notion']);
    for (const m of listed) {
      expect(m.slack_user_id).toBe(USER);
      expect(m).not.toHaveProperty('envelope');
    }

    expect(await storage.deletePersonalRecord(USER, 'notion')).toBe(true);
    expect(await storage.deletePersonalRecord(USER, 'notion')).toBe(false);
    expect(await storage.readPersonalRecord(USER, 'notion')).toBeNull();
    expect((await storage.listPersonalRecords(USER)).map((m) => m.server_name)).toEqual(['linear']);
  });

  it('counts a vault record only while a record file exists, shared or personal', async () => {
    const { storage } = await importFresh();
    const { OAUTH_DIR, OAUTH_PERSONAL_DIR } = await import('../../workdir.js');
    await mkdir(OAUTH_PERSONAL_DIR, { recursive: true });
    expect(storage.hasAnyVaultRecord()).toBe(false);

    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writePersonalRecord(meta('notion', nowSec + 3600, nowSec), sealed);
    expect(storage.hasAnyVaultRecord()).toBe(true);

    await storage.deletePersonalRecord(USER, 'notion');
    expect(await readdir(join(OAUTH_PERSONAL_DIR, USER))).toEqual([]);
    expect(storage.hasAnyVaultRecord()).toBe(false);

    await writeFile(join(OAUTH_DIR, 'linear.json'), '{}');
    expect(storage.hasAnyVaultRecord()).toBe(true);
  });

  it('keeps a disconnect that lands while a refresh is in flight', async () => {
    const { refresh, storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writePersonalRecord(meta('notion', nowSec + 10, nowSec - 3600), sealed);
    let respond!: () => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => {
      respond = () => resolve(new Response(
        JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    })) as any;

    const refreshing = refresh.ensureFreshPersonalToken(USER, 'notion');
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const disconnecting = storage.deletePersonalRecord(USER, 'notion');
    respond();
    await refreshing;
    expect(await disconnecting).toBe(true);
    expect(await storage.readPersonalRecord(USER, 'notion')).toBeNull();
  });

  it('lists nothing for a person with no directory', async () => {
    const { storage } = await importFresh();
    expect(await storage.listPersonalRecords('U0NOBODY1')).toEqual([]);
  });

  it('writes the file 0600 with the tokens sealed', async () => {
    const { storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writePersonalRecord(meta('notion', nowSec + 3600, nowSec), sealed);

    const path = storage.personalPathFor(USER, 'notion');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('envelope');
    expect(raw).not.toContain('AT-old');
    expect(raw).not.toContain('RT-old');
  });

  it('rejects unsafe ids and server names before building a path', async () => {
    const { storage } = await importFresh();
    const nowSec = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string]> = [['../x', 'notion'], ['u1', 'notion'], ['U1ABC', 'a/b']];
    for (const [user, server] of cases) {
      expect(() => storage.personalPathFor(user, server)).toThrow();
      await expect(
        storage.writePersonalRecord({ ...meta(server, nowSec + 3600, nowSec), slack_user_id: user }, sealed),
      ).rejects.toThrow();
    }
    expect(await readdir(dir, { recursive: true })).toEqual([]);
  });

  describe('ensureFreshPersonalToken', () => {
    it('returns null when the person has no record', async () => {
      const { refresh } = await importFresh();
      expect(await refresh.ensureFreshPersonalToken(USER, 'notion')).toBeNull();
    });

    it('returns the stored token without a network call when more than 60 s are left', async () => {
      const { refresh, storage } = await importFresh();
      const nowSec = Math.floor(Date.now() / 1000);
      await storage.writePersonalRecord(meta('notion', nowSec + 3600, nowSec), sealed);
      const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
      globalThis.fetch = fetchMock as any;

      const result = await refresh.ensureFreshPersonalToken(USER, 'notion');
      expect(result).toEqual({ accessToken: 'AT-old', tokenType: 'Bearer', expiresAt: nowSec + 3600 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes once for concurrent callers near expiry and keeps an unrotated refresh token', async () => {
      const { refresh, storage } = await importFresh();
      const nowSec = Math.floor(Date.now() / 1000);
      await storage.writePersonalRecord(meta('notion', nowSec + 10, nowSec - 3600), sealed);
      const fetchMock = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new Response(
          JSON.stringify({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      globalThis.fetch = fetchMock as any;

      const results = await Promise.all([
        refresh.ensureFreshPersonalToken(USER, 'notion'),
        refresh.ensureFreshPersonalToken(USER, 'notion'),
        refresh.ensureFreshPersonalToken(USER, 'notion'),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r!.accessToken)).toEqual(['AT-new', 'AT-new', 'AT-new']);

      const reread = await storage.readPersonalRecord(USER, 'notion');
      expect(reread!.expires_at).toBeGreaterThanOrEqual(nowSec + 3600);
      expect(reread!.expires_at).toBe(results[0]!.expiresAt);
      expect(reread!.slack_user_id).toBe(USER);
      const resealed = await storage.readOAuthSealed(reread!);
      expect(resealed.access_token).toBe('AT-new');
      expect(resealed.refresh_token).toBe('RT-old');
    });

    it('throws OAuthRefreshError and leaves the record untouched when the token endpoint fails', async () => {
      const { refresh, storage } = await importFresh();
      const nowSec = Math.floor(Date.now() / 1000);
      await storage.writePersonalRecord(meta('notion', nowSec + 10, nowSec), sealed);
      const path = storage.personalPathFor(USER, 'notion');
      const before = await readFile(path);
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ error: 'invalid_grant' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )) as any;

      await expect(refresh.ensureFreshPersonalToken(USER, 'notion')).rejects.toBeInstanceOf(refresh.OAuthRefreshError);
      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });
});
