/**
 * `GET /oauth/callback` is public: anyone who can reach the host can call it.
 * These cases pin that only a matching, fresh, unused pending attempt turns a
 * code into stored credentials, over a real Express app and the real encrypted
 * store in a temporary directory. Only the provider's token endpoint is mocked.
 */

import { randomBytes } from 'crypto';
import { createRequire } from 'module';
import type { Server } from 'http';
import { rm } from 'fs/promises';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);

vi.mock('../../../system/workdir.js', async () => {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = join(tmpdir(), `archie-oauth-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { OAUTH_DIR: dir, OAUTH_PENDING_DIR: join(dir, '.pending') };
});
vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../../../system/oauth/flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../system/oauth/flow.js')>()),
  exchangeCodeForTokens: vi.fn(),
}));

import { mountOAuthRoutes } from '../routes.js';
import { exchangeCodeForTokens } from '../../../system/oauth/flow.js';
import {
  writePendingRecord,
  readPendingRecord,
  readOAuthRecord,
  readOAuthSealed,
} from '../../../system/oauth/storage.js';
import { OAUTH_DIR } from '../../../system/workdir.js';
import { expectDefined } from '../../../test-support/assertions.js';

const express = require('express') as typeof import('express');

const STATE = 'state_Ab-9';
const nowSeconds = () => Math.floor(Date.now() / 1000);

let server: Server;
let baseUrl: string;

async function writePending(createdAt = nowSeconds()): Promise<void> {
  await writePendingRecord(
    {
      state: STATE,
      server_name: 'tracker',
      issuer: 'https://auth.example.test',
      token_endpoint: 'https://auth.example.test/token',
      authorization_endpoint: 'https://auth.example.test/authorize',
      scopes: ['read'],
      redirect_uri: 'https://archie.example.test/oauth/callback',
      created_at: createdAt,
    },
    { code_verifier: 'verifier', client_id: 'client-1' },
  );
}

async function callback(query: Record<string, string>) {
  const res = await fetch(`${baseUrl}/oauth/callback?${new URLSearchParams(query)}`);
  return { status: res.status, html: await res.text() };
}

beforeAll(() => {
  process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');
});

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(OAUTH_DIR, { recursive: true, force: true });
  vi.mocked(exchangeCodeForTokens).mockResolvedValue({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    token_type: 'bearer',
    expires_in: 600,
  });

  const app = express();
  mountOAuthRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(OAUTH_DIR, { recursive: true, force: true });
});

describe('GET /oauth/callback', () => {
  it('exchanges the code with the stored verifier and saves encrypted credentials', async () => {
    await writePending();
    const res = await callback({ state: STATE, code: 'code-1' });

    expect(res.status).toBe(200);
    expect(res.html).toContain('Connected');
    expect(exchangeCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'code-1',
        state: STATE,
        codeVerifier: 'verifier',
        redirectUri: 'https://archie.example.test/oauth/callback',
        client: { client_id: 'client-1' },
      }),
    );

    const record = expectDefined(await readOAuthRecord('tracker'));
    expect(record.expires_at - record.created_at).toBe(600);
    expect(JSON.stringify(record)).not.toContain('access-1');
    expect(await readOAuthSealed(record)).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      client_id: 'client-1',
    });
    expect(await readPendingRecord(STATE)).toBeNull();
  });

  it('refuses a replayed callback once the attempt has been consumed', async () => {
    await writePending();
    await callback({ state: STATE, code: 'code-1' });
    const replay = await callback({ state: STATE, code: 'code-1' });

    expect(replay.html).toContain('Unknown state');
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1);
  });

  it('refuses a state with no pending attempt without contacting the provider', async () => {
    const res = await callback({ state: 'never-issued', code: 'code-1' });

    expect(res.html).toContain('Unknown state');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(await readOAuthRecord('tracker')).toBeNull();
  });

  it('expires an attempt older than an hour and removes it', async () => {
    await writePending(nowSeconds() - 3601);
    const res = await callback({ state: STATE, code: 'code-1' });

    expect(res.html).toContain('Authorization expired');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(await readPendingRecord(STATE)).toBeNull();
  });

  it('records a provider refusal on the pending attempt for the CLI to report', async () => {
    await writePending();
    const res = await callback({
      state: STATE,
      error: 'access_denied',
      error_description: 'user said no',
    });

    expect(res.status).toBe(400);
    expect(expectDefined(await readPendingRecord(STATE)).error).toBe('access_denied: user said no');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('records a failed token exchange and stores no credentials', async () => {
    await writePending();
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(new Error('invalid_grant'));
    const res = await callback({ state: STATE, code: 'code-1' });

    expect(res.html).toContain('Token exchange failed');
    expect(expectDefined(await readPendingRecord(STATE)).error).toBe('invalid_grant');
    expect(await readOAuthRecord('tracker')).toBeNull();

    const retry = await callback({ state: STATE, code: 'code-2' });
    expect(retry.html).toContain('Already used');
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing state', { code: 'code-1' }],
    ['a missing code', { state: STATE }],
  ])('answers 400 to %s', async (_label, query) => {
    const res = await callback(query);
    expect(res.status).toBe(400);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('escapes provider-supplied text in the result page', async () => {
    const res = await callback({ state: STATE, error: '<script>alert(1)</script>' });
    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
