import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// IMPORTANT: set ARCHIE_SECRETS_DIR before importing modules that resolve
// SECRETS_DIR at import time.
process.env.ARCHIE_SECRETS_DIR = join(tmpdir(), 'archie-storage-user-tests');
process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('per-user + shared-client OAuth storage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-storage-user-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load() {
    return import('../storage.js');
  }

  const userMeta = (uid: string, server: string) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      server_name: server,
      slack_user_id: uid,
      expires_at: nowSec + 3600,
      created_at: nowSec,
      updated_at: nowSec,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: ['read'],
      resource: 'https://mcp.example.com/mcp',
    };
  };

  it('round-trips a per-user token record (seal/unseal) with 0o600 perms', async () => {
    const storage = await load();
    await storage.writeUserOAuthRecord(userMeta('U012ABC', 'notion'), {
      access_token: 'AT-u1',
      refresh_token: 'RT-u1',
      token_type: 'Bearer',
    });

    const record = await storage.readUserOAuthRecord('U012ABC', 'notion');
    expect(record).not.toBeNull();
    expect(record!.slack_user_id).toBe('U012ABC');
    // Sensitive fields are not in the plaintext portion.
    expect(JSON.stringify({ ...record, envelope: undefined })).not.toContain('AT-u1');

    const sealed = await storage.readUserOAuthSealed(record!);
    expect(sealed).toEqual({ access_token: 'AT-u1', refresh_token: 'RT-u1', token_type: 'Bearer' });

    const mode = (await stat(storage.userVaultPathFor('U012ABC', 'notion'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips a shared client record', async () => {
    const storage = await load();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      { server_name: 'notion', issuer: 'https://auth.example.com', created_at: nowSec, updated_at: nowSec },
      { client_id: 'client-1', client_secret: 'shh' },
    );
    const record = await storage.readOAuthClientRecord('notion');
    expect(record).not.toBeNull();
    expect(await storage.readOAuthClientSealed(record!)).toEqual({ client_id: 'client-1', client_secret: 'shh' });
    expect(await storage.readOAuthClientRecord('linear')).toBeNull();
  });

  it('rejects path-unsafe user ids and server names', async () => {
    const storage = await load();
    expect(() => storage.userVaultPathFor('../evil', 'notion')).toThrow(/Invalid Slack user id/);
    expect(() => storage.userVaultPathFor('U1/..', 'notion')).toThrow(/Invalid Slack user id/);
    expect(() => storage.userVaultPathFor('U012ABC', '../evil')).toThrow(/Invalid MCP server name/);
    expect(() => storage.clientPathFor('a/b')).toThrow(/Invalid MCP server name/);
    await expect(storage.listUserServers('..')).rejects.toThrow(/Invalid Slack user id/);
  });

  it('isolates users: revoking one leaves others and the shared client intact', async () => {
    const storage = await load();
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      { server_name: 'notion', issuer: 'https://auth.example.com', created_at: nowSec, updated_at: nowSec },
      { client_id: 'client-1' },
    );
    await storage.writeUserOAuthRecord(userMeta('U1', 'notion'), { access_token: 'A1', token_type: 'Bearer' });
    await storage.writeUserOAuthRecord(userMeta('U2', 'notion'), { access_token: 'A2', token_type: 'Bearer' });
    await storage.writeUserOAuthRecord(userMeta('U2', 'linear'), { access_token: 'A3', token_type: 'Bearer' });

    expect(await storage.deleteUserOAuthRecord('U1', 'notion')).toBe(true);

    expect(await storage.hasUserOAuthRecord('U1', 'notion')).toBe(false);
    expect(await storage.hasUserOAuthRecord('U2', 'notion')).toBe(true);
    expect(await storage.readOAuthClientRecord('notion')).not.toBeNull();
    expect(await storage.listUserServers('U2')).toEqual(['linear', 'notion']);
  });

  it('anyOAuthRecordExists sees legacy, per-user, and client records', async () => {
    const storage = await load();
    expect(await storage.anyOAuthRecordExists()).toBe(false);

    await storage.writeUserOAuthRecord(userMeta('U1', 'notion'), { access_token: 'A', token_type: 'Bearer' });
    expect(await storage.anyOAuthRecordExists()).toBe(true);

    await storage.deleteUserOAuthRecord('U1', 'notion');
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writeOAuthClientRecord(
      { server_name: 'notion', issuer: 'https://x', created_at: nowSec, updated_at: nowSec },
      { client_id: 'c' },
    );
    expect(await storage.anyOAuthRecordExists()).toBe(true);
  });

  it('per-user records do not appear in the legacy server listing', async () => {
    const storage = await load();
    await storage.writeUserOAuthRecord(userMeta('U1', 'notion'), { access_token: 'A', token_type: 'Bearer' });
    expect(await storage.listOAuthServers()).toEqual([]);
  });
});
