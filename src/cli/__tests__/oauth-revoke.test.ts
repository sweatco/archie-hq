import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

describe('oauth:revoke argument safety', () => {
  let secretsDir: string;
  let secretsKey: string;

  beforeEach(async () => {
    secretsDir = await mkdtemp(join(tmpdir(), 'archie-oauth-revoke-'));
    secretsKey = randomBytes(32).toString('base64');
    process.env.ARCHIE_SECRETS_DIR = secretsDir;
    process.env.ARCHIE_SECRETS_KEY = secretsKey;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(secretsDir, { recursive: true, force: true });
  });

  async function storage() {
    return import('../../system/oauth/storage.js');
  }

  async function run(args: string[]) {
    return execFileAsync('npm', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ARCHIE_SECRETS_DIR: secretsDir,
        ARCHIE_SECRETS_KEY: secretsKey,
      },
    });
  }

  it('does not revoke the shared record when npm consumes a missing --user separator', async () => {
    const vault = await storage();
    const now = Math.floor(Date.now() / 1000);
    await vault.writeOAuthRecord({
      server_name: 'notion',
      expires_at: now + 3600,
      created_at: now,
      updated_at: now,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: [],
    }, {
      access_token: 'shared',
      client_id: 'client',
      token_type: 'Bearer',
    });

    await expect(run(['run', 'oauth:revoke', 'notion', '--user', 'U123'])).rejects.toMatchObject({
      code: 1,
    });
    expect(await vault.hasOAuthRecord('notion')).toBe(true);
  }, 15_000);

  it('revokes only the user record with npm argument separation', async () => {
    const vault = await storage();
    const now = Math.floor(Date.now() / 1000);
    await vault.writeOAuthRecord({
      server_name: 'notion',
      expires_at: now + 3600,
      created_at: now,
      updated_at: now,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: [],
    }, {
      access_token: 'shared',
      client_id: 'client',
      token_type: 'Bearer',
    });
    await vault.writeUserOAuthRecord({
      server_name: 'notion',
      slack_user_id: 'U123',
      expires_at: now + 3600,
      created_at: now,
      updated_at: now,
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      scopes: [],
      resource: 'https://mcp.example.com/mcp',
      redirect_uri: 'https://archie.example.com/oauth/callback',
    }, {
      access_token: 'personal',
      token_type: 'Bearer',
    });

    await run(['run', 'oauth:revoke', '--', 'notion', '--user', 'U123']);
    expect(await vault.hasUserOAuthRecord('U123', 'notion')).toBe(false);
    expect(await vault.hasOAuthRecord('notion')).toBe(true);
  }, 15_000);
});
