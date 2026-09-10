/**
 * Registry — MCP tool policy resolution.
 *
 * The policy travels with the *server* (its `archie` block in the plugins
 * repo's .mcp.json), so mounting a server brings its policy along, and
 * `deny`-tier tools are withheld up front via disallowedTools — the tool is
 * never offered to the model in the first place.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoadedPlugin, LoadedMcpConfig, PluginAgentDef } from '../../system/plugin-loader.js';

vi.mock('../../system/plugin-loader.js', () => ({
  getPlugins: vi.fn(),
  getRootMcpConfig: vi.fn(),
  getPmOverlay: vi.fn().mockReturnValue(null),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getPlugins, getRootMcpConfig, getPmOverlay } from '../../system/plugin-loader.js';
import { scanPmDef } from '../registry.js';

const ROOT_MCP: LoadedMcpConfig = {
  servers: {
    tramline: { command: 'node', args: ['tramline.js'] },
    clickhouse: { command: 'uvx', args: ['mcp-clickhouse'] },
    'sweatco-admin': { type: 'http', url: 'https://admin.example/mcp' },
  },
  descriptions: { tramline: 'Tramline — mobile releases' },
  policies: {
    tramline: {
      default: 'ask',
      tiers: { get_release: 'allow', start_release: 'deny', stop_release: 'deny' },
      titles: { stop_release: 'Stop this release' },
    },
    'sweatco-admin': { default: 'allow', tiers: { publish_offer: 'ask' }, titles: {} },
  },
};

function agent(key: string, extra: Partial<PluginAgentDef> = {}): PluginAgentDef {
  return { key, role: `${key} role`, expertise: 'e', prompt: 'p', ...extra };
}

function plugin(name: string, agents: PluginAgentDef[]): LoadedPlugin {
  return {
    name,
    dir: `/plugins/${name}`,
    manifest: { name, version: '1.0.0', description: 'test' },
    repoConfigs: null,
    agents,
    skillsPath: null,
    hooks: null,
  };
}

describe('scanPmDef — MCP tool policy', () => {
  beforeEach(() => {
    vi.mocked(getRootMcpConfig).mockReturnValue(ROOT_MCP);
    vi.mocked(getPlugins).mockReturnValue([plugin('pm', [])]);
    vi.mocked(getPmOverlay).mockReturnValue(null);
  });

  it('attaches the policy of every server the PM mounts', () => {
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', { mcpServers: ['tramline', 'clickhouse'] }));

    const pm = scanPmDef();
    expect(pm.mcpPolicy!.tramline.default).toBe('ask');
    expect(pm.mcpPolicy!.tramline.tiers.get_release).toBe('allow');
  });

  it("leaves mcpPolicy undefined when none of the mounted servers declare one", () => {
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', { mcpServers: ['clickhouse'] }));

    // Unmanaged: spawn attaches no gate hook at all, so behaviour is unchanged.
    expect(scanPmDef().mcpPolicy).toBeUndefined();
  });

  it('does not leak the policy of a server that is not mounted', () => {
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', { mcpServers: ['clickhouse', 'tramline'] }));

    expect(Object.keys(scanPmDef().mcpPolicy!)).toEqual(['tramline']);
  });

  it('withholds deny-tier tools through disallowedTools, deduped with frontmatter', () => {
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', {
      mcpServers: ['tramline'],
      // A plugin mid-migration may still list one of them by hand.
      disallowedTools: ['WebSearch', 'mcp__tramline__start_release'],
    }));

    expect(scanPmDef().disallowedTools).toEqual([
      'WebSearch',
      'mcp__tramline__start_release',
      'mcp__tramline__stop_release',
    ]);
  });

  it('covers the ask tier the approval gate reads', () => {
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', { mcpServers: ['sweatco-admin'] }));

    expect(scanPmDef().mcpPolicy!['sweatco-admin'].tiers.publish_offer).toBe('ask');
  });
});
