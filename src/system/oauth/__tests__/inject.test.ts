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

  it('skips http servers without a vault record', async () => {
    const { inject } = await load();
    const mcp = {
      no_creds: { type: 'http', url: 'https://example.com' },
    };
    const result = await inject.applyOAuthBindings(mcp);
    expect(result.injected).toEqual([]);
    expect((mcp.no_creds as any).headers).toBeUndefined();
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
});
