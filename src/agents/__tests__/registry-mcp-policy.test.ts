/**
 * Registry — the PM definition's MCP surface.
 *
 * MCP is engine-owned and session-wide: every server in the plugins repo's
 * root .mcp.json attaches to the one agent a task runs, and the per-server
 * `archie` blocks union into a single session policy. `deny`-tier tools are
 * withheld up front via disallowedTools — the tool is never offered to the
 * model in the first place — while `ask` tiers are what the approval gate in
 * spawn.ts reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoadedMcpConfig, ArchieConfig } from '../../system/plugin-loader.js';

vi.mock('../../system/plugin-loader.js', () => ({
  getRootMcpConfig: vi.fn(),
  getArchieConfig: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getRootMcpConfig, getArchieConfig } from '../../system/plugin-loader.js';
import { scanPmDef, isAutoMergeRepo } from '../registry.js';

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

const ARCHIE_CONFIG: ArchieConfig = {
  allowedNetworkDomains: ['sheets.googleapis.com'],
  repos: {
    'sweatco/mobile': { warm: true, autoMerge: true },
    'sweatco/backend': { warm: true, autoMerge: false },
  },
};

describe('scanPmDef — MCP surface', () => {
  beforeEach(() => {
    vi.mocked(getRootMcpConfig).mockReturnValue(ROOT_MCP);
    vi.mocked(getArchieConfig).mockReturnValue(ARCHIE_CONFIG);
  });

  it('attaches every server in the root config', () => {
    expect(Object.keys(scanPmDef().mcpServers!)).toEqual([
      'tramline',
      'clickhouse',
      'sweatco-admin',
    ]);
  });

  it('unions the per-server policies into one session policy', () => {
    const policy = scanPmDef().mcpPolicy!;
    expect(Object.keys(policy).sort()).toEqual(['sweatco-admin', 'tramline']);
    expect(policy.tramline.default).toBe('ask');
    expect(policy.tramline.tiers.get_release).toBe('allow');
    // The ask tier the approval gate reads.
    expect(policy['sweatco-admin'].tiers.publish_offer).toBe('ask');
  });

  it('leaves mcpPolicy undefined when no server declares one', () => {
    vi.mocked(getRootMcpConfig).mockReturnValue({ ...ROOT_MCP, policies: {} });

    // Unmanaged: spawn attaches no gate hook at all, so behaviour is unchanged.
    expect(scanPmDef().mcpPolicy).toBeUndefined();
    expect(scanPmDef().disallowedTools).toBeUndefined();
  });

  it('withholds every deny-tier tool through disallowedTools', () => {
    expect(scanPmDef().disallowedTools).toEqual([
      'mcp__tramline__start_release',
      'mcp__tramline__stop_release',
    ]);
  });

  it('takes the sandbox network allowlist from archie.json', () => {
    expect(scanPmDef().allowedNetworkDomains).toEqual(['sheets.googleapis.com']);
  });
});

describe('isAutoMergeRepo', () => {
  beforeEach(() => {
    vi.mocked(getRootMcpConfig).mockReturnValue(ROOT_MCP);
    vi.mocked(getArchieConfig).mockReturnValue(ARCHIE_CONFIG);
  });

  it('is true only for a repo archie.json opts in', () => {
    expect(isAutoMergeRepo('sweatco/mobile')).toBe(true);
    expect(isAutoMergeRepo('sweatco/backend')).toBe(false);
    expect(isAutoMergeRepo('sweatco/unlisted')).toBe(false);
  });
});
