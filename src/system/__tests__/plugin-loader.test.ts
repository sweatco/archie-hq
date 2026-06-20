/**
 * Plugin Loader — loadMcpJson tests
 *
 * Focused on the `description` handling: each server's optional human-readable
 * `description` must be surfaced separately (for the PM's team-integrations
 * context) and stripped from the connection config so the Claude Agent SDK
 * never receives a non-standard field.
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
    expect(result).toEqual({ servers: {}, descriptions: {} });
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
