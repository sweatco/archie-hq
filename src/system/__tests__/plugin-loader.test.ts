/**
 * Plugin Loader — loadMcpJson tests
 *
 * Focused on the two Archie extensions each server entry may carry —
 * `description` (human-readable, for the PM's team-integrations context) and
 * `archie` (the tool approval policy). Both must be surfaced separately and
 * stripped from the connection config, so the Claude Agent SDK never receives a
 * non-standard field.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { loadMcpJson } from '../plugin-loader.js';

let tempDir: string;

async function writeMcpJson(contents: unknown): Promise<string> {
  const path = join(tempDir, '.mcp.json');
  await writeFile(path, JSON.stringify(contents));
  return path;
}

describe('loadMcpJson', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-mcp-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty servers and descriptions when the file does not exist', () => {
    const result = loadMcpJson(join(tempDir, 'does-not-exist.json'));
    expect(result).toEqual({ servers: {}, descriptions: {}, policies: {} });
  });

  it('extracts description into descriptions and strips it from the server config', async () => {
    const path = await writeMcpJson({
      mcpServers: {
        rollbar: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@rollbar/mcp-server@latest'],
          description: 'Rollbar — backend error tracking',
        },
      },
    });

    const { servers, descriptions } = loadMcpJson(path);

    expect(descriptions.rollbar).toBe('Rollbar — backend error tracking');
    // The connection config the SDK receives must NOT carry `description`.
    expect(servers.rollbar).not.toHaveProperty('description');
    expect(servers.rollbar).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@rollbar/mcp-server@latest'],
    });
  });

  it('leaves servers without a description untouched and absent from descriptions', async () => {
    const path = await writeMcpJson({
      mcpServers: {
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      },
    });

    const { servers, descriptions } = loadMcpJson(path);

    expect(descriptions).toEqual({});
    expect(servers.notion).toEqual({ type: 'http', url: 'https://mcp.notion.com/mcp' });
  });

  it('ignores blank descriptions but still strips the key from the config', async () => {
    const path = await writeMcpJson({
      mcpServers: {
        monday: { type: 'http', url: 'https://mcp.monday.com/mcp', description: '   ' },
      },
    });

    const { servers, descriptions } = loadMcpJson(path);

    expect(descriptions).not.toHaveProperty('monday');
    expect(servers.monday).not.toHaveProperty('description');
    expect(servers.monday).toEqual({ type: 'http', url: 'https://mcp.monday.com/mcp' });
  });

  it('leaves policies empty for a server that declares none', async () => {
    const path = await writeMcpJson({
      mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
    });
    // An unmanaged server: the gate never attaches, behaviour is as before.
    expect(loadMcpJson(path).policies).toEqual({});
  });

  it('substitutes ${MCP_*} env vars alongside description handling', async () => {
    process.env.MCP_TEST_TOKEN = 'secret-token';
    try {
      const path = await writeMcpJson({
        mcpServers: {
          example: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${MCP_TEST_TOKEN}' },
            description: 'Example service',
          },
        },
      });

      const { servers, descriptions } = loadMcpJson(path);

      expect(descriptions.example).toBe('Example service');
      expect(servers.example.headers.Authorization).toBe('Bearer secret-token');
      expect(servers.example).not.toHaveProperty('description');
    } finally {
      delete process.env.MCP_TEST_TOKEN;
    }
  });
});

/**
 * The `archie` block is a security boundary: it decides which external
 * mutations need a human. So it is validated strictly and a malformed one
 * throws rather than being dropped — a silently-ignored typo would reclassify a
 * tool as unmanaged.
 */
describe('loadMcpJson — archie tool policy', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-mcp-policy-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writePolicy(archie: unknown): Promise<string> {
    return writeMcpJson({
      mcpServers: {
        tramline: { command: 'node', args: ['server.js'], description: 'Tramline', archie },
      },
    });
  }

  it('parses tiers and strips the key from the connection config', async () => {
    const path = await writePolicy({
      default: 'ask',
      allow: ['list_apps', 'get_release'],
      deny: ['start_release'],
    });

    const { servers, descriptions, policies } = loadMcpJson(path);

    expect(policies.tramline).toEqual({
      default: 'ask',
      tiers: { list_apps: 'allow', get_release: 'allow', start_release: 'deny' },
      titles: {},
    });
    // Neither extension may reach the SDK.
    expect(servers.tramline).toEqual({ command: 'node', args: ['server.js'] });
    expect(descriptions.tramline).toBe('Tramline');
  });

  it('defaults an unlisted tool to ask (fail safe)', async () => {
    const path = await writePolicy({ allow: ['get_release'] });
    expect(loadMcpJson(path).policies.tramline.default).toBe('ask');
  });

  it('accepts an allow-by-default server with explicit exceptions', async () => {
    const path = await writePolicy({ default: 'allow', ask: ['trigger_build'], deny: ['set_mcp_mode'] });
    expect(loadMcpJson(path).policies.tramline).toEqual({
      default: 'allow',
      tiers: { trigger_build: 'ask', set_mcp_mode: 'deny' },
      titles: {},
    });
  });

  // Optional, and only worth writing where the method name is a bad button.
  it('parses optional per-tool titles', async () => {
    const path = await writePolicy({
      titles: { fully_release_rollout: '  Release to 100% of users — irreversible  ' },
    });
    expect(loadMcpJson(path).policies.tramline.titles)
      .toEqual({ fully_release_rollout: 'Release to 100% of users — irreversible' });
  });

  it('rejects a non-string or empty title', async () => {
    for (const titles of [{ t: 7 }, { t: '' }, { t: '   ' }]) {
      const path = await writePolicy({ titles });
      expect(() => loadMcpJson(path)).toThrow(/must be a non-empty string/);
    }
  });

  it('rejects a non-map titles value', async () => {
    const path = await writePolicy({ titles: ['a title'] });
    expect(() => loadMcpJson(path)).toThrow(/must be a map of tool name to button text/);
  });

  it('rejects an unknown default tier', async () => {
    const path = await writePolicy({ default: 'askk' });
    expect(() => loadMcpJson(path)).toThrow(/default must be one of/);
  });

  // Catches a misspelled tier name, which would otherwise read as "nothing
  // listed" — every tool silently falling to the default.
  it('rejects an unknown key', async () => {
    const path = await writePolicy({ asks: ['trigger_build'] });
    expect(() => loadMcpJson(path)).toThrow(/unknown key "asks"/);
  });

  it('rejects a tool listed in two tiers', async () => {
    const path = await writePolicy({ allow: ['get_release'], deny: ['get_release'] });
    expect(() => loadMcpJson(path)).toThrow(/appears in both/);
  });

  it('rejects a non-list tier', async () => {
    const path = await writePolicy({ allow: 'get_release' });
    expect(() => loadMcpJson(path)).toThrow(/must be a list of tool names/);
  });


  // A key with `__` splits differently coming back out of the SDK's
  // `mcp__<server>__<tool>` name, so the gate would never find the policy and
  // every tool of the server would run ungated. Refuse the key instead.
  it('rejects a server key that cannot survive the tool-name round trip', async () => {
    for (const key of ['sweat__admin', '_lead', 'trail_']) {
      const path = await writeMcpJson({
        mcpServers: { [key]: { command: 'node', archie: { default: 'ask' } } },
      });
      expect(() => loadMcpJson(path)).toThrow(/does not survive/);
    }
  });

  it('leaves an unpolicied server with an awkward key alone', async () => {
    const path = await writeMcpJson({ mcpServers: { 'sweat__admin': { command: 'node' } } });
    expect(loadMcpJson(path).servers).toHaveProperty('sweat__admin');
  });

  it('rejects a non-object policy', async () => {
    const path = await writePolicy(['allow']);
    expect(() => loadMcpJson(path)).toThrow(/must be an object/);
  });
});
