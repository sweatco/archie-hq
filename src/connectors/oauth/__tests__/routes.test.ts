import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { createRequire } from 'module';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const express = require('express');

vi.mock('../../../system/oauth/flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../system/oauth/flow.js')>()),
  exchangeCodeForTokens: vi.fn(),
}));

vi.mock('../../slack/client.js', () => ({ postSlackMessage: vi.fn() }));

vi.mock('../../../system/oauth/discovery.js', () => ({
  probeResourceMetadataUrl: vi.fn(async () => 'https://mcp.example.com/.well-known/oauth-protected-resource'),
  fetchProtectedResourceMetadata: vi.fn(async () => ({
    resource: 'https://mcp.example.com/mcp',
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['read'],
  })),
  fetchAuthServerMetadata: vi.fn(async () => ({
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    registration_endpoint: 'https://auth.example.com/register',
    code_challenge_methods_supported: ['S256'],
  })),
}));

vi.mock('../../../system/oauth/dcr.js', () => ({
  registerClient: vi.fn(async () => ({ client_id: 'cli', client_secret: 'sec' })),
}));

process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

const USER = 'U0OWNER1';
const DM = 'D0OWNER1';
const THREAD = '1700000000.000100';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archie-oauth-routes-'));
  process.env.ARCHIE_SECRETS_DIR = dir;
  process.env.ARCHIE_WORKDIR = dir;
  // SECRETS_DIR and WORKDIR are captured at import, so every test imports fresh modules.
  vi.resetModules();
  // Mocked modules survive resetModules, so their call history has to be cleared too.
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /oauth/callback', () => {
  let server: Server;
  let baseUrl: string;

  async function setup() {
    const routes = await import('../routes.js');
    const storage = await import('../../../system/oauth/storage.js');
    const flow = await import('../../../system/oauth/flow.js');
    const slack = await import('../../slack/client.js');
    const app = express();
    routes.mountOAuthRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s: Server = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const exchange = vi.mocked(flow.exchangeCodeForTokens);
    exchange.mockResolvedValue({
      access_token: 'AT-new',
      refresh_token: 'RT-new',
      token_type: 'bearer',
      expires_in: 3600,
    } as Awaited<ReturnType<typeof flow.exchangeCodeForTokens>>);
    const post = vi.mocked(slack.postSlackMessage);
    post.mockResolvedValue('1700000001.000200');
    return { storage, exchange, post };
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function writePending(
    storage: typeof import('../../../system/oauth/storage.js'),
    state: string,
    person?: { slack_user_id: string; dm_channel_id?: string; thread_ts?: string },
  ) {
    await storage.writePendingRecord(
      {
        state,
        server_name: 'notion',
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        authorization_endpoint: 'https://auth.example.com/authorize',
        scopes: ['read'],
        resource: 'https://mcp.example.com/mcp',
        redirect_uri: 'https://archie.example.com/oauth/callback',
        created_at: Math.floor(Date.now() / 1000),
        ...person,
      },
      { code_verifier: 'verifier', client_id: 'cli', client_secret: 'sec' },
    );
  }

  function callback(state: string) {
    return fetch(`${baseUrl}/oauth/callback?state=${state}&code=the-code`);
  }

  it('stores a reconnect after a refresh already in flight, so the reconnect is what remains', async () => {
    const { storage } = await setup();
    const { ensureFreshPersonalToken } = await import('../../../system/oauth/refresh.js');
    const nowSec = Math.floor(Date.now() / 1000);
    await storage.writePersonalRecord(
      {
        server_name: 'notion', slack_user_id: USER, expires_at: nowSec + 10, created_at: nowSec - 3600, updated_at: nowSec - 3600,
        issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token', scopes: ['read'],
      },
      { access_token: 'AT-old', refresh_token: 'RT-old', client_id: 'cli', client_secret: 'sec', token_type: 'Bearer' },
    );
    await writePending(storage, 'state-reconnect', { slack_user_id: USER, dm_channel_id: DM });

    const realFetch = globalThis.fetch;
    let respond!: () => void;
    const tokenEndpointHit = new Promise<void>((hit) => {
      globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith('https://auth.example.com/')) return realFetch(input, init);
        hit();
        return new Promise<Response>((resolve) => {
          respond = () => resolve(new Response(
            JSON.stringify({ access_token: 'AT-refreshed', token_type: 'Bearer', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ));
        });
      }) as typeof fetch;
    });
    try {
      const refreshing = ensureFreshPersonalToken(USER, 'notion');
      await tokenEndpointHit;
      const reconnecting = callback('state-reconnect');
      await new Promise((resolve) => setTimeout(resolve, 50));
      respond();
      await refreshing;
      expect((await reconnecting).status).toBe(200);
      const record = await storage.readPersonalRecord(USER, 'notion');
      expect((await storage.readOAuthSealed(record!)).access_token).toBe('AT-new');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('stores a personal record, confirms in the DM thread and writes no shared record', async () => {
    const { storage, post } = await setup();
    await writePending(storage, 'state-personal', { slack_user_id: USER, dm_channel_id: DM, thread_ts: THREAD });

    const res = await callback('state-personal');
    expect(res.status).toBe(200);

    const record = await storage.readPersonalRecord(USER, 'notion');
    expect(record).not.toBeNull();
    expect(record!.slack_user_id).toBe(USER);
    expect(await storage.readOAuthSealed(record!)).toEqual({
      access_token: 'AT-new',
      refresh_token: 'RT-new',
      client_id: 'cli',
      client_secret: 'sec',
      token_type: 'bearer',
    });
    expect(await storage.readPendingRecord('state-personal')).toBeNull();
    expect(await storage.readOAuthRecord('notion')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ channel: DM, threadTs: THREAD }));
  });

  it('keeps the personal record and answers 200 when the Slack confirmation fails', async () => {
    const { storage, post } = await setup();
    post.mockRejectedValue(new Error('not_in_channel'));
    await writePending(storage, 'state-slack-down', { slack_user_id: USER, dm_channel_id: DM, thread_ts: THREAD });

    const res = await callback('state-slack-down');
    expect(res.status).toBe(200);
    expect(await storage.readPersonalRecord(USER, 'notion')).not.toBeNull();
  });

  it('marks the pending with the error and stores nothing when the exchange fails', async () => {
    const { storage, exchange } = await setup();
    exchange.mockRejectedValue(new Error('invalid_grant'));
    await writePending(storage, 'state-bad-code', { slack_user_id: USER, dm_channel_id: DM, thread_ts: THREAD });

    await callback('state-bad-code');
    expect((await storage.readPendingRecord('state-bad-code'))!.error).toBe('invalid_grant');
    expect(await storage.readPersonalRecord(USER, 'notion')).toBeNull();
    expect(await storage.readOAuthRecord('notion')).toBeNull();
  });

  it('writes the shared record for a pending without a person', async () => {
    const { storage, post } = await setup();
    await writePending(storage, 'state-shared');

    const res = await callback('state-shared');
    expect(res.status).toBe(200);

    const record = await storage.readOAuthRecord('notion');
    expect(record).not.toBeNull();
    const sealed = await storage.readOAuthSealed(record!);
    expect(sealed.access_token).toBe('AT-new');
    expect(sealed.refresh_token).toBe('RT-new');
    expect(await storage.readPendingRecord('state-shared')).toBeNull();
    expect(await storage.listPersonalRecords(USER)).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('stores a personal record, never the shared one, for a person without a DM to confirm in', async () => {
    const { storage, post } = await setup();
    await writePending(storage, 'state-no-dm', { slack_user_id: USER });

    const res = await callback('state-no-dm');
    expect(res.status).toBe(200);
    expect(await storage.readPersonalRecord(USER, 'notion')).not.toBeNull();
    expect(await storage.readOAuthRecord('notion')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('beginConnect', () => {
  const originalPublicUrl = process.env.ARCHIE_PUBLIC_URL;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.ARCHIE_PUBLIC_URL;
    else process.env.ARCHIE_PUBLIC_URL = originalPublicUrl;
  });

  async function setup() {
    await mkdir(join(dir, 'plugins'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', '.mcp.json'),
      JSON.stringify({ mcpServers: { notion: { type: 'http', url: 'https://mcp.example.com/mcp' } } }),
    );
    const connect = await import('../../../system/oauth/connect.js');
    const storage = await import('../../../system/oauth/storage.js');
    return { connect, storage };
  }

  it('records the person on the pending when one is given', async () => {
    const { connect, storage } = await setup();
    const result = await connect.beginConnect({
      serverName: 'notion',
      redirectUri: 'https://archie.example.com/oauth/callback',
      person: { slackUserId: USER, channelId: DM, threadTs: THREAD },
    });

    const pending = await storage.readPendingRecord(result.state);
    expect(pending!.slack_user_id).toBe(USER);
    expect(pending!.dm_channel_id).toBe(DM);
    expect(pending!.thread_ts).toBe(THREAD);
  });

  it('leaves the person fields off the pending without one', async () => {
    const { connect, storage } = await setup();
    const result = await connect.beginConnect({
      serverName: 'notion',
      redirectUri: 'https://archie.example.com/oauth/callback',
    });

    const pending = await storage.readPendingRecord(result.state);
    expect(pending).not.toBeNull();
    expect(pending).not.toHaveProperty('slack_user_id');
    expect(pending).not.toHaveProperty('dm_channel_id');
    expect(pending).not.toHaveProperty('thread_ts');
  });

  it('builds the redirect URI from ARCHIE_PUBLIC_URL without its trailing slash', async () => {
    const { connect } = await setup();
    process.env.ARCHIE_PUBLIC_URL = 'https://archie.example.com/';
    expect(connect.publicRedirectUri()).toBe('https://archie.example.com/oauth/callback');
  });

  it('throws when ARCHIE_PUBLIC_URL is unset', async () => {
    const { connect } = await setup();
    delete process.env.ARCHIE_PUBLIC_URL;
    expect(() => connect.publicRedirectUri()).toThrow('ARCHIE_PUBLIC_URL is not set');
  });
});
