/**
 * Registry — MCP tool policy resolution.
 *
 * The policy travels with the *server* (its `archie` block in the plugins
 * repo's .mcp.json), not with the agent, so:
 *   - every agent that mounts the server gets the same policy, with no copy to
 *     keep in sync per agent;
 *   - the PM is covered by construction, since its overlay resolves servers
 *     through the same function;
 *   - `deny`-tier tools are withheld up front via disallowedTools, so the tool
 *     is never offered to the model in the first place.
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
import { scanAgentDefs } from '../registry.js';

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

describe('scanAgentDefs — MCP tool policy', () => {
  beforeEach(() => {
    vi.mocked(getRootMcpConfig).mockReturnValue(ROOT_MCP);
    vi.mocked(getPmOverlay).mockReturnValue(null);
  });

  it('attaches a server policy to every agent that mounts it', () => {
    vi.mocked(getPlugins).mockReturnValue([
      plugin('engineering', [agent('release-manager', { mcpServers: ['tramline', 'clickhouse'] })]),
      plugin('mobile', [agent('mobile', { mcpServers: ['tramline'] })]),
    ]);

    const defs = scanAgentDefs();
    for (const id of ['release-manager-agent', 'mobile-agent']) {
      const def = defs.find((d) => d.id === id)!;
      expect(def.mcpPolicy!.tramline.default).toBe('ask');
      expect(def.mcpPolicy!.tramline.tiers.get_release).toBe('allow');
    }
  });

  it('leaves mcpPolicy undefined when none of the agent\'s servers declare one', () => {
    vi.mocked(getPlugins).mockReturnValue([
      plugin('data', [agent('data-analyst', { mcpServers: ['clickhouse'] })]),
    ]);

    // Unmanaged: spawn attaches no gate hook at all, so behaviour is unchanged.
    expect(scanAgentDefs().find((d) => d.id === 'data-analyst-agent')!.mcpPolicy).toBeUndefined();
  });

  it('does not leak the policy of a server the agent has not mounted', () => {
    vi.mocked(getPlugins).mockReturnValue([
      plugin('data', [agent('data-analyst', { mcpServers: ['clickhouse', 'tramline'] })]),
    ]);

    const policy = scanAgentDefs().find((d) => d.id === 'data-analyst-agent')!.mcpPolicy!;
    expect(Object.keys(policy)).toEqual(['tramline']);
  });

  it('withholds deny-tier tools through disallowedTools, deduped with frontmatter', () => {
    vi.mocked(getPlugins).mockReturnValue([
      plugin('engineering', [agent('release-manager', {
        mcpServers: ['tramline'],
        // A plugin mid-migration may still list one of them by hand.
        disallowedTools: ['WebSearch', 'mcp__tramline__start_release'],
      })]),
    ]);

    const def = scanAgentDefs().find((d) => d.id === 'release-manager-agent')!;
    expect(def.disallowedTools).toEqual([
      'WebSearch',
      'mcp__tramline__start_release',
      'mcp__tramline__stop_release',
    ]);
  });

  it('covers the PM through its overlay servers', () => {
    vi.mocked(getPlugins).mockReturnValue([plugin('pm', [])]);
    vi.mocked(getPmOverlay).mockReturnValue(agent('pm', { mcpServers: ['sweatco-admin'] }));

    const pm = scanAgentDefs().find((d) => d.id === 'pm-agent')!;
    expect(pm.mcpPolicy!['sweatco-admin'].tiers.publish_offer).toBe('ask');
  });
});
