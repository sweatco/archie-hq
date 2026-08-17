import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import type { OAuthPendingMeta } from '../types.js';

process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('OAuth pending outbox storage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-oauth-pending-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function pending(state: string, overrides: Partial<OAuthPendingMeta> = {}): OAuthPendingMeta {
    return {
      state,
      server_name: 'notion',
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      authorization_endpoint: 'https://auth.example.com/authorize',
      scopes: ['read'],
      resource: 'https://mcp.example.com/mcp',
      redirect_uri: 'https://archie.example.com/oauth/callback',
      created_at: Math.floor(Date.now() / 1000),
      slack_user_id: 'U1',
      task_id: 'task-1',
      ...overrides,
    };
  }

  it('finds only the current incomplete attempt for the exact task, user, and server', async () => {
    const storage = await import('../storage.js');
    await storage.writePendingRecord(pending('matching'), { code_verifier: 'v', client_id: 'c' });
    await storage.writePendingRecord(pending('other-task', { task_id: 'task-2' }), { code_verifier: 'v', client_id: 'c' });
    await storage.writePendingRecord(pending('expired', {
      created_at: Math.floor((Date.now() - storage.OAUTH_PENDING_TTL_MS - 1_000) / 1000),
    }), { code_verifier: 'v', client_id: 'c' });
    await storage.writePendingRecord(pending('done'), { code_verifier: 'v', client_id: 'c' });
    await storage.markPendingCompleted('done', {
      access_token: 'AT', token_type: 'Bearer', expires_at: 9_999_999_999, scopes: ['read'],
    });

    await expect(storage.findPendingUserAttempt('task-1', 'U1', 'notion'))
      .resolves.toMatchObject({ state: 'matching' });
  });

  it('keeps a completed DM wake past the pending TTL while reaping stale attempts', async () => {
    const storage = await import('../storage.js');
    const old = Math.floor((Date.now() - storage.OAUTH_PENDING_TTL_MS - 1_000) / 1000);
    await storage.writePendingRecord(pending('outbox', { created_at: old }), { code_verifier: 'v', client_id: 'c' });
    await storage.markPendingCompleted('outbox', {
      access_token: 'AT', token_type: 'Bearer', expires_at: 9_999_999_999, scopes: ['read'],
    });
    await storage.writePendingRecord(pending('abandoned', { created_at: old }), { code_verifier: 'v', client_id: 'c' });

    await expect(storage.reapStalePending(storage.OAUTH_PENDING_TTL_MS)).resolves.toBe(1);
    expect(await storage.readPendingRecord('outbox')).not.toBeNull();
    expect(await storage.readPendingRecord('abandoned')).toBeNull();
    const outbox = await storage.readPendingRecord('outbox');
    expect(JSON.stringify(outbox)).not.toContain('"access_token"');
    expect((await storage.readPendingSealed(outbox!)).user_grant?.access_token).toBe('AT');
  });

  it('cleans up only incomplete link attempts', async () => {
    const storage = await import('../storage.js');
    await storage.writePendingRecord(pending('incomplete'), { code_verifier: 'v', client_id: 'c' });
    await storage.writePendingRecord(pending('completed'), { code_verifier: 'v', client_id: 'c' });
    await storage.markPendingCompleted('completed', {
      access_token: 'AT', token_type: 'Bearer', expires_at: 9_999_999_999, scopes: ['read'],
    });

    await expect(storage.deletePendingIfIncomplete('incomplete')).resolves.toBe(true);
    await expect(storage.deletePendingIfIncomplete('completed')).resolves.toBe(false);
    expect(await storage.readPendingRecord('completed')).not.toBeNull();
  });

  it('does not list empty per-user directories as connected users', async () => {
    const storage = await import('../storage.js');
    const now = Math.floor(Date.now() / 1000);
    await storage.writeUserOAuthRecord({
      server_name: 'notion', slack_user_id: 'U1', expires_at: now + 3600,
      created_at: now, updated_at: now, issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token', scopes: ['read'],
      resource: 'https://mcp.example.com/mcp', redirect_uri: 'https://archie.example.com/oauth/callback',
    }, { access_token: 'AT', token_type: 'Bearer' });
    await storage.deleteUserOAuthRecord('U1', 'notion');

    await expect(storage.listOAuthUserIds()).resolves.toEqual([]);
  });
});
