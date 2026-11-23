import { describe, it, expect } from 'vitest';
import { parsePersonaConfig } from './config.js';
import { FakeWorkspace } from './fake-workspace.js';
import { connectPersonas } from './persona-clients.js';

const config = parsePersonaConfig(
  JSON.stringify({
    environment: 'staging',
    teamId: 'T0TEST00001',
    archieBotUserId: 'U0ARCHIE001',
    personaApp: {
      clientId: '1.2',
      clientSecret: 'env:CLIENT_SECRET',
      redirectUrl: 'https://localhost/archie-personas/oauth',
    },
    personas: [
      { key: 'alice', slackUserId: 'U0ALICE0001', token: 'env:ALICE_TOKEN' },
      { key: 'bob', slackUserId: 'U0BOB000001', token: 'env:BOB_TOKEN' },
    ],
  }),
);
const run = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });

/** Each "token" names the member and workspace it belongs to, as `<userId>@<teamId>`. */
function clientFactory() {
  const created: string[] = [];
  const createClient = (token: string) => {
    created.push(token);
    const [userId, teamId] = token.split('@');
    return new FakeWorkspace('T0TEST00001').clientFor(userId, teamId);
  };
  return { created, createClient };
}

describe('connectPersonas', () => {
  it('returns one acting persona per configured member when every token matches', async () => {
    const { createClient } = clientFactory();
    const env = { ALICE_TOKEN: 'U0ALICE0001@T0TEST00001', BOB_TOKEN: 'U0BOB000001@T0TEST00001' };
    const actors = await connectPersonas(config, { env, run }, createClient);
    expect(actors.map((actor) => actor.persona.key)).toEqual(['alice', 'bob']);
  });

  it('refuses a token from another workspace and names the mismatch', async () => {
    const { createClient } = clientFactory();
    const env = { ALICE_TOKEN: 'U0ALICE0001@T0PROD00001', BOB_TOKEN: 'U0BOB000001@T0TEST00001' };
    await expect(connectPersonas(config, { env, run }, createClient)).rejects.toThrow(
      'token for "alice" belongs to workspace T0PROD00001, not the configured T0TEST00001',
    );
  });

  it('refuses a token filed under the wrong persona', async () => {
    const { createClient } = clientFactory();
    const env = { ALICE_TOKEN: 'U0ALICE0001@T0TEST00001', BOB_TOKEN: 'U0ALICE0001@T0TEST00001' };
    await expect(connectPersonas(config, { env, run }, createClient)).rejects.toThrow(
      'token for "bob" belongs to member U0ALICE0001, not the configured U0BOB000001',
    );
  });

  it('stops at the first bad token without reading the next secret', async () => {
    const { created, createClient } = clientFactory();
    const env = { ALICE_TOKEN: 'U0ALICE0001@T0PROD00001', BOB_TOKEN: 'U0BOB000001@T0TEST00001' };
    await expect(connectPersonas(config, { env, run }, createClient)).rejects.toThrow();
    expect(created).toEqual(['U0ALICE0001@T0PROD00001']);
  });

  it('fails when a token is not stored yet', async () => {
    const { createClient } = clientFactory();
    await expect(connectPersonas(config, { env: {}, run }, createClient)).rejects.toThrow(
      /env:ALICE_TOKEN is not set/,
    );
  });
});
