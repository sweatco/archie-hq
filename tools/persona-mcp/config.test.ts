import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  checkTokenIdentity,
  findPersona,
  parsePersonaConfig,
  parseSecretReference,
  resolveConfigPath,
} from './config.js';

const validConfig = {
  environment: 'staging',
  teamId: 'T0TEST00001',
  archieBotUserId: 'U0ARCHIE001',
  archieApiUrl: 'http://archie.test:3000',
  slackWebhookUrl: 'https://archie.test/webhooks/slack',
  signingSecret: 'keychain:archie-personas/staging/signing-secret',
  personaApp: {
    clientId: '111.222',
    clientSecret: 'keychain:archie-personas/staging/client-secret',
    redirectUrl: 'https://localhost/archie-personas/oauth',
  },
  probeChannelId: 'C0PROBE0001',
  personas: [
    { key: 'alice', slackUserId: 'U0ALICE0001', token: 'keychain:archie-personas/staging/alice' },
    { key: 'bob', slackUserId: 'U0BOB000001', token: 'env:ARCHIE_PERSONA_BOB' },
  ],
};

function parseWith(change: (config: typeof validConfig) => unknown): () => unknown {
  return () => parsePersonaConfig(JSON.stringify(change(structuredClone(validConfig))));
}

describe('parsePersonaConfig', () => {
  it('accepts a complete config', () => {
    const config = parsePersonaConfig(JSON.stringify(validConfig));
    expect(config.personas.map((persona) => persona.key)).toEqual(['alice', 'bob']);
  });

  it('accepts a config written before Archie is installed in the workspace', () => {
    const beforeArchie = parseWith((config) => ({ ...config, archieBotUserId: undefined }))();
    expect(beforeArchie).not.toHaveProperty('archieBotUserId');
  });

  it('refuses an environment that names production', () => {
    expect(parseWith((config) => ({ ...config, environment: 'Production' }))).toThrow(
      /never target production/,
    );
  });

  it('refuses a secret written into the file instead of a reference', () => {
    expect(
      parseWith((config) => {
        config.personas[0].token = 'xoxp-1234-not-a-reference';
        return config;
      }),
    ).toThrow(/personas\.0\.token: expected op:\/\//);
  });

  it('refuses two personas with the same member or key', () => {
    expect(
      parseWith((config) => {
        config.personas[1].slackUserId = config.personas[0].slackUserId;
        return config;
      }),
    ).toThrow(/duplicate persona slackUserId/);
    expect(
      parseWith((config) => {
        config.personas[1].key = 'alice';
        return config;
      }),
    ).toThrow(/duplicate persona key/);
  });

  it('allows a plain-http webhook for a local instance but requires https for the OAuth redirect', () => {
    const local = parseWith((config) => ({
      ...config,
      slackWebhookUrl: 'http://localhost:3000/webhooks/slack',
    }));
    expect(local).not.toThrow();
    expect(
      parseWith((config) => {
        config.personaApp.redirectUrl = 'http://localhost/archie-personas/oauth';
        return config;
      }),
    ).toThrow(/personaApp\.redirectUrl: expected an https:\/\/ URL/);
  });

  it('refuses unknown fields, so a typo cannot silently drop a setting', () => {
    expect(parseWith((config) => ({ ...config, signingSecrte: 'env:X' }))).toThrow(/invalid/);
  });

  it('reports every problem at once', () => {
    const attempt = parseWith((config) => ({ ...config, teamId: 'nope', archieBotUserId: 'B1' }));
    expect(attempt).toThrow(/teamId: expected a Slack team ID/);
    expect(attempt).toThrow(/archieBotUserId: expected a Slack user ID/);
  });

  it('names malformed JSON as such', () => {
    expect(() => parsePersonaConfig('{ not json')).toThrow(/not valid JSON/);
  });
});

describe('config.example.json', () => {
  it('is a valid config, so copying it is a working starting point', () => {
    const examplePath = join(dirname(fileURLToPath(import.meta.url)), 'config.example.json');
    const example = parsePersonaConfig(readFileSync(examplePath, 'utf-8'));
    expect(example.personas.map((persona) => persona.key)).toEqual(['alice', 'bob', 'carol']);
  });
});

describe('parseSecretReference', () => {
  it('splits a keychain reference at the first slash, keeping slashes in the account', () => {
    expect(parseSecretReference('keychain:archie-personas/staging/alice')).toEqual({
      kind: 'keychain',
      service: 'archie-personas',
      account: 'staging/alice',
    });
  });

  it('reads a 1Password reference, with or without a section', () => {
    expect(parseSecretReference('op://Private/Archie Test Personas/alice')).toEqual({
      kind: 'op',
      vault: 'Private',
      item: 'Archie Test Personas',
      field: 'alice',
    });
    expect(parseSecretReference('op://Private/Personas/tokens/alice')).toMatchObject({
      section: 'tokens',
      field: 'alice',
    });
  });

  it('reads an environment reference', () => {
    expect(parseSecretReference('env:ARCHIE_PERSONA_BOB')).toEqual({
      kind: 'env',
      name: 'ARCHIE_PERSONA_BOB',
    });
  });

  it('rejects anything else without echoing it', () => {
    expect(() => parseSecretReference('xoxp-secret-value')).toThrow(/expected a secret reference/);
    expect(() => parseSecretReference('xoxp-secret-value')).not.toThrow(/xoxp/);
  });
});

describe('findPersona and resolveConfigPath', () => {
  it('finds a persona by key and names the known keys otherwise', () => {
    const config = parsePersonaConfig(JSON.stringify(validConfig));
    expect(findPersona(config, 'bob').slackUserId).toBe('U0BOB000001');
    expect(() => findPersona(config, 'carol')).toThrow(/configured: alice, bob/);
  });

  it('prefers ARCHIE_PERSONAS_CONFIG over the per-user default', () => {
    expect(resolveConfigPath({ ARCHIE_PERSONAS_CONFIG: '/tmp/p.json' }, '/home/u')).toBe(
      '/tmp/p.json',
    );
    expect(resolveConfigPath({}, '/home/u')).toBe('/home/u/.config/archie-personas/config.json');
  });
});

describe('checkTokenIdentity', () => {
  const persona = validConfig.personas[0];
  const expected = { teamId: validConfig.teamId, persona };

  it('passes a token of the configured workspace and member', () => {
    expect(checkTokenIdentity({ teamId: 'T0TEST00001', userId: 'U0ALICE0001' }, expected)).toEqual({
      ok: true,
    });
  });

  it('fails a token from another workspace before looking at the member', () => {
    expect(
      checkTokenIdentity({ teamId: 'T0OTHER0001', userId: 'U0ALICE0001' }, expected),
    ).toMatchObject({ ok: false, reason: 'wrong_workspace' });
  });

  it('fails a token that belongs to a different member', () => {
    expect(
      checkTokenIdentity({ teamId: 'T0TEST00001', userId: 'U0BOB000001' }, expected),
    ).toMatchObject({ ok: false, reason: 'wrong_member' });
  });

  it('fails when Slack returned no identity', () => {
    expect(checkTokenIdentity({ teamId: undefined, userId: undefined }, expected)).toMatchObject({
      ok: false,
      reason: 'wrong_workspace',
    });
  });
});
