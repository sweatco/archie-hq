/**
 * Runs the persona actions through the real Slack `WebClient` against a local stand-in for
 * Slack's Web API. The other tests use an in-memory workspace that shares only an interface
 * with the client; this one pins what actually goes over the wire: the method called, the
 * parameter names, whose token is sent, and the shape of a refusal.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { WebClient } from '@slack/web-api';
import { parsePersonaConfig } from './config.js';
import {
  deleteAs,
  describeSlackFailure,
  dmArchieAs,
  editAs,
  postAs,
  reactAs,
  readAs,
} from './persona-actions.js';
import { connectPersonas } from './persona-clients.js';

interface RecordedCall {
  method: string;
  token: string;
  params: Record<string, string>;
}

const ALICE = 'U0ALICE0001';
const ARCHIE = 'U0ARCHIE001';
const calls: RecordedCall[] = [];
let slackApi: Server;
let slackApiUrl: string;

/** What Slack would answer, reduced to the fields the persona tools read. */
function answer(method: string, params: Record<string, string>): Record<string, unknown> {
  if (params.channel === 'G0HIDDEN001') return { ok: false, error: 'channel_not_found' };
  switch (method) {
    case 'auth.test':
      return { ok: true, team_id: 'T0TEST00001', user_id: ALICE };
    case 'chat.postMessage':
      return { ok: true, channel: params.channel, ts: '1800000005.000100' };
    case 'conversations.open':
      return { ok: true, channel: { id: 'D0ALICEARCH' } };
    case 'conversations.history':
      return {
        ok: true,
        messages: [
          { ts: '1800000002.000100', user: ARCHIE, bot_id: 'B0ARCHIE001', text: 'pong' },
          { ts: '1800000001.000100', user: ALICE, text: 'ping' },
        ],
      };
    case 'conversations.replies':
      return { ok: true, messages: [{ ts: params.ts, user: ALICE, text: 'root' }] };
    default:
      return { ok: true };
  }
}

beforeAll(async () => {
  slackApi = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const method = (request.url ?? '').replace(/^\/api\//, '').replace(/\?.*$/, '');
      const params = Object.fromEntries(new URLSearchParams(body));
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      calls.push({ method, token, params });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer(method, params)));
    });
  });
  await new Promise<void>((resolve) => slackApi.listen(0, '127.0.0.1', resolve));
  slackApiUrl = `http://127.0.0.1:${(slackApi.address() as AddressInfo).port}/api/`;
});

afterAll(async () => {
  await new Promise((resolve) => slackApi.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
});

const clientWith = (token: string): WebClient =>
  new WebClient(token, { slackApiUrl, retryConfig: { retries: 0 } });

describe('persona actions through the real Slack WebClient', () => {
  it('posts with the persona token and Slack parameter names', async () => {
    const posted = await postAs(clientWith('xoxp-alice'), {
      channel: 'C0PUBLIC001',
      text: 'hello [E2E-1]',
      threadTs: '1800000001.000100',
    });
    expect(posted).toEqual({ channel: 'C0PUBLIC001', ts: '1800000005.000100' });
    expect(calls).toEqual([
      {
        method: 'chat.postMessage',
        token: 'xoxp-alice',
        params: {
          channel: 'C0PUBLIC001',
          text: 'hello [E2E-1]',
          thread_ts: '1800000001.000100',
        },
      },
    ]);
  });

  it('opens the DM with Archie by user ID, then posts into the channel Slack returned', async () => {
    const posted = await dmArchieAs(clientWith('xoxp-alice'), ARCHIE, { text: 'dm [E2E-2]' });
    expect(posted.channel).toBe('D0ALICEARCH');
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['conversations.open', { users: ARCHIE }],
      ['chat.postMessage', { channel: 'D0ALICEARCH', text: 'dm [E2E-2]' }],
    ]);
  });

  it('edits, deletes and reacts with the parameters Slack expects', async () => {
    const slack = clientWith('xoxp-alice');
    const target = { channel: 'C0PUBLIC001', ts: '1800000001.000100' };
    await editAs(slack, { ...target, text: 'edited' });
    await deleteAs(slack, target);
    await reactAs(slack, { ...target, emoji: ':eyes:' });
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['chat.update', { ...target, text: 'edited' }],
      ['chat.delete', target],
      ['reactions.add', { channel: 'C0PUBLIC001', timestamp: target.ts, name: 'eyes' }],
    ]);
  });

  it('reads history oldest first and a thread by its root ts', async () => {
    const slack = clientWith('xoxp-alice');
    const conversation = await readAs(slack, { channel: 'C0PUBLIC001' });
    expect(
      conversation.map((message) => [message.author, message.text, message.appAuthored]),
    ).toEqual([
      [ALICE, 'ping', false],
      [ARCHIE, 'pong', true],
    ]);
    await readAs(slack, { channel: 'C0PUBLIC001', threadTs: '1800000001.000100', limit: 5 });
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['conversations.history', { channel: 'C0PUBLIC001', limit: '20' }],
      ['conversations.replies', { channel: 'C0PUBLIC001', ts: '1800000001.000100', limit: '5' }],
    ]);
  });

  it("turns the client's real refusal into the persona-level sentence", async () => {
    const refusal: unknown = await readAs(clientWith('xoxp-bob'), { channel: 'G0HIDDEN001' }).catch(
      (error: unknown) => error,
    );
    expect(describeSlackFailure(refusal, 'bob')).toBe(
      '"bob" cannot see that conversation (Slack: channel_not_found)',
    );
  });

  it('checks a token through the real auth.test response', async () => {
    const config = parsePersonaConfig(
      JSON.stringify({
        environment: 'staging',
        teamId: 'T0TEST00001',
        archieBotUserId: ARCHIE,
        personaApp: {
          clientId: '1.2',
          clientSecret: 'env:CLIENT_SECRET',
          redirectUrl: 'https://localhost/archie-personas/oauth',
        },
        personas: [{ key: 'alice', slackUserId: ALICE, token: 'env:ALICE_TOKEN' }],
      }),
    );
    const secrets = {
      env: { ALICE_TOKEN: 'xoxp-alice' },
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    };
    const actors = await connectPersonas(config, secrets, clientWith);
    expect(actors.map((actor) => actor.persona.key)).toEqual(['alice']);
    expect(calls).toEqual([{ method: 'auth.test', token: 'xoxp-alice', params: {} }]);

    const elsewhere = { ...config, teamId: 'T0OTHER0001' };
    await expect(connectPersonas(elsewhere, secrets, clientWith)).rejects.toThrow(
      'token for "alice" belongs to workspace T0TEST00001, not the configured T0OTHER0001',
    );
  });
});
