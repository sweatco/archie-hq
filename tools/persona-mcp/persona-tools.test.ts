import { describe, it, expect } from 'vitest';
import { isValidSlackRequest } from '@slack/bolt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parsePersonaConfig, type PersonaConfig } from './config.js';
import { FakeWorkspace } from './fake-workspace.js';
import { connectPersonas } from './persona-clients.js';
import {
  registerPersonaTools,
  registerSetupNotice,
  type SyntheticClicks,
} from './persona-tools.js';

const ALICE = 'U0ALICE0001';
const BOB = 'U0BOB000001';
const ARCHIE = 'U0ARCHIE001';
const SIGNING_SECRET = 'test-signing-secret';

function personaConfig(extra: Record<string, unknown> = {}): PersonaConfig {
  return parsePersonaConfig(
    JSON.stringify({
      environment: 'staging',
      teamId: 'T0TEST00001',
      archieBotUserId: ARCHIE,
      personaApp: {
        clientId: '1.2',
        clientSecret: 'env:CLIENT_SECRET',
        redirectUrl: 'https://localhost/archie-personas/oauth',
      },
      personas: [
        { key: 'alice', slackUserId: ALICE, token: 'env:ALICE_TOKEN' },
        { key: 'bob', slackUserId: BOB, token: 'env:BOB_TOKEN' },
      ],
      ...extra,
    }),
  );
}

const toolResult = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

/** Connect an MCP client to a server with the persona tools, over an in-memory transport. */
async function connect(config: PersonaConfig, clicks?: SyntheticClicks) {
  const workspace = new FakeWorkspace(config.teamId);
  workspace.addConversation('C0PUBLIC001', [ALICE, BOB, ARCHIE]);
  workspace.addConversation('G0PRIVATE01', [ALICE, ARCHIE]);
  // Tokens are the member IDs here, so the fake can hand each persona its own client.
  const secrets = {
    env: { ALICE_TOKEN: ALICE, BOB_TOKEN: BOB },
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
  };
  const actors = await connectPersonas(config, secrets, (token) => workspace.clientFor(token));

  const server = new McpServer({ name: 'archie-personas', version: 'test' });
  registerPersonaTools(
    server,
    config,
    actors,
    clicks ?? { readSigningSecret: () => Promise.reject(new Error('not configured')) },
  );
  const client = new Client({ name: 'test-agent', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = toolResult.parse(await client.callTool({ name, arguments: args }));
    const [first] = result.content;
    return { isError: result.isError === true, text: first.text };
  };
  const callJson = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
    JSON.parse((await call(name, args)).text);
  return { client, workspace, call, callJson };
}

describe('persona tools over MCP', () => {
  it('offers the persona actions, and click_as only when a webhook and secret are configured', async () => {
    const withoutWebhook = await connect(personaConfig());
    const names = (await withoutWebhook.client.listTools()).tools.map((tool) => tool.name);
    expect([...names].sort()).toEqual([
      'delete_as',
      'dm_archie_as',
      'edit_as',
      'list_personas',
      'post_as',
      'react_as',
      'read_as',
      'reply_as',
    ]);

    const withWebhook = await connect(
      personaConfig({
        slackWebhookUrl: 'http://localhost:3000/webhooks/slack',
        signingSecret: 'env:SIGNING_SECRET',
      }),
    );
    const withClick = (await withWebhook.client.listTools()).tools.map((tool) => tool.name);
    expect(withClick).toContain('click_as');
  });

  it('works before Archie is installed, without the DM tool', async () => {
    const { client, callJson } = await connect(personaConfig({ archieBotUserId: undefined }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('post_as');
    expect(names).not.toContain('dm_archie_as');
    expect(await callJson('list_personas')).toMatchObject({ archieBotUserId: null });
  });

  it('lists personas with the IDs an agent needs for mentions, and no secrets', async () => {
    const { callJson, call } = await connect(personaConfig());
    expect(await callJson('list_personas')).toEqual({
      environment: 'staging',
      archieBotUserId: ARCHIE,
      sharedChannelId: null,
      personas: [
        { key: 'alice', slackUserId: ALICE },
        { key: 'bob', slackUserId: BOB },
      ],
    });
    expect((await call('list_personas')).text).not.toMatch(/TOKEN|env:/);
  });

  it('posts, replies and reads as different members of the same conversation', async () => {
    const { callJson } = await connect(personaConfig());
    const root = z
      .object({ channel: z.string(), ts: z.string() })
      .parse(
        await callJson('post_as', { persona: 'alice', channel: 'C0PUBLIC001', text: 'q [E2E-1]' }),
      );
    await callJson('reply_as', {
      persona: 'bob',
      channel: 'C0PUBLIC001',
      thread_ts: root.ts,
      text: 'answer',
    });
    await callJson('react_as', {
      persona: 'bob',
      channel: 'C0PUBLIC001',
      ts: root.ts,
      emoji: 'eyes',
    });

    const thread = await callJson('read_as', {
      persona: 'alice',
      channel: 'C0PUBLIC001',
      thread_ts: root.ts,
    });
    expect(thread).toMatchObject([
      { author: ALICE, text: 'q [E2E-1]', reactions: ['eyes×1'], appAuthored: false },
      { author: BOB, text: 'answer', threadTs: root.ts },
    ]);
  });

  it("keeps one member's DM with Archie and private channel invisible to the other", async () => {
    const { call, callJson } = await connect(personaConfig());
    const dm = z
      .object({ channel: z.string(), ts: z.string() })
      .parse(await callJson('dm_archie_as', { persona: 'alice', text: 'secret [E2E-2]' }));

    const aliceSees = await callJson('read_as', { persona: 'alice', channel: dm.channel });
    expect(aliceSees).toMatchObject([{ author: ALICE, text: 'secret [E2E-2]' }]);

    for (const hidden of [dm.channel, 'G0PRIVATE01']) {
      const bobTries = await call('read_as', { persona: 'bob', channel: hidden });
      expect(bobTries).toEqual({
        isError: true,
        text: '"bob" cannot see that conversation (Slack: channel_not_found)',
      });
    }
    const bobPosts = await call('post_as', { persona: 'bob', channel: 'G0PRIVATE01', text: 'x' });
    expect(bobPosts.isError).toBe(true);
  });

  it('edits and deletes as the author, and reports an unknown persona as an error', async () => {
    const { call, callJson, workspace } = await connect(personaConfig());
    const posted = z
      .object({ ts: z.string() })
      .parse(await callJson('post_as', { persona: 'alice', channel: 'C0PUBLIC001', text: 'v1' }));
    await callJson('edit_as', {
      persona: 'alice',
      channel: 'C0PUBLIC001',
      ts: posted.ts,
      text: 'v2',
    });
    expect(workspace.messagesIn('C0PUBLIC001')[0].text).toBe('v2');
    await callJson('delete_as', { persona: 'alice', channel: 'C0PUBLIC001', ts: posted.ts });
    expect(workspace.messagesIn('C0PUBLIC001')).toHaveLength(0);

    expect(await call('post_as', { persona: 'carol', channel: 'C0PUBLIC001', text: 'x' })).toEqual({
      isError: true,
      text: 'unknown persona "carol" (configured: alice, bob)',
    });
  });

  it('sends a click the instance would accept, attributed to that persona and labelled synthetic', async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const send = ((url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;
    const { callJson, workspace } = await connect(
      personaConfig({
        slackWebhookUrl: 'http://localhost:3000/webhooks/slack',
        signingSecret: 'env:SIGNING_SECRET',
      }),
      { readSigningSecret: () => Promise.resolve(SIGNING_SECRET), send },
    );
    const cardTs = workspace.seed('C0PUBLIC001', { bot_id: 'B0ARCHIE001', text: 'Save?' });

    const result = await callJson('click_as', {
      persona: 'bob',
      channel: 'C0PUBLIC001',
      ts: cardTs,
      thread_ts: '1800000000.000001',
      action_id: 'approve_memory_preference',
      value: 'task-1',
    });
    expect(result).toMatchObject({ synthetic: true, httpStatus: 200, outcome: 'acknowledged' });

    const [request] = sent;
    expect(request.url).toBe('http://localhost:3000/webhooks/slack');
    expect(
      isValidSlackRequest({
        signingSecret: SIGNING_SECRET,
        body: request.body,
        headers: {
          'x-slack-signature': request.headers['x-slack-signature'],
          'x-slack-request-timestamp': Number(request.headers['x-slack-request-timestamp']),
        },
      }),
    ).toBe(true);
    const payload: unknown = JSON.parse(new URLSearchParams(request.body).get('payload') ?? '');
    expect(payload).toMatchObject({
      user: { id: BOB },
      channel: { id: 'C0PUBLIC001' },
      container: { channel_id: 'C0PUBLIC001', message_ts: cardTs },
      message: { ts: cardTs, thread_ts: '1800000000.000001' },
      actions: [{ action_id: 'approve_memory_preference', value: 'task-1' }],
    });
  });
});

describe('setup notice', () => {
  it('is the only tool on a machine without a persona config, and says where to start', async () => {
    const server = new McpServer({ name: 'archie-personas', version: 'test' });
    registerSetupNotice(server, '/home/dev/.config/archie-personas/config.json');
    const client = new Client({ name: 'test-agent', version: 'test' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['list_personas']);
    const notice = toolResult.parse(await client.callTool({ name: 'list_personas' }));
    expect(notice.content[0].text).toContain('docs/guides/slack-test-personas.md');
    expect(notice.content[0].text).toContain('/home/dev/.config/archie-personas/config.json');
  });
});
