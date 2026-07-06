/**
 * Registry merge-policy tests.
 *
 * Verifies the autoMerge resolution at the registry copy (scanAgentDefs):
 * absent on the plugin entry → resolved false; true carries through; and
 * PM-spawned dynamic agents are always false regardless of spec.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LoadedPlugin } from '../../system/plugin-loader.js';

vi.mock('../../system/plugin-loader.js', () => ({
  getPlugins: vi.fn(),
  getRootMcpConfig: vi.fn().mockReturnValue({ servers: {}, descriptions: {} }),
  getPmOverlay: vi.fn().mockReturnValue(null),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getPlugins } from '../../system/plugin-loader.js';
import { scanAgentDefs, synthesizeDynamicAgentDef } from '../registry.js';
import { isRepoAgent } from '../../types/agent.js';

function makePlugin(repos: Array<{ github: string; baseBranch?: string; autoMerge?: boolean }>): LoadedPlugin {
  return {
    name: 'engineering',
    dir: '/plugins/engineering',
    manifest: { name: 'engineering', version: '1.0.0', description: 'test' },
    repoConfigs: null,
    agents: [{
      key: 'backend',
      role: 'Backend engineer',
      expertise: 'Node.js',
      prompt: 'Do backend things.',
      repo: { repos, primary: repos[0].github },
    }],
    skillsPath: null,
    hooks: null,
  };
}

describe('scanAgentDefs — RepoEntry.autoMerge resolution', () => {
  it('defaults to false when the plugin entry omits autoMerge', () => {
    vi.mocked(getPlugins).mockReturnValue([makePlugin([{ github: 'org/backend' }])]);

    const defs = scanAgentDefs();
    const backend = defs.find((d) => d.id === 'backend-agent')!;
    expect(isRepoAgent(backend)).toBe(true);
    expect(backend.repo!.repos).toEqual([{ github: 'org/backend', baseBranch: 'main', autoMerge: false }]);
  });

  it('carries autoMerge: true through the registry copy', () => {
    vi.mocked(getPlugins).mockReturnValue([
      makePlugin([{ github: 'org/backend', baseBranch: 'main', autoMerge: true }]),
    ]);

    const defs = scanAgentDefs();
    const backend = defs.find((d) => d.id === 'backend-agent')!;
    expect(backend.repo!.repos[0].autoMerge).toBe(true);
  });
});

describe('synthesizeDynamicAgentDef — autoMerge', () => {
  it('is always false for PM-spawned dynamic agents', () => {
    const def = synthesizeDynamicAgentDef({
      id: 'explorer-a3f9-agent',
      shortname: 'explorer',
      repos: [{ github: 'org/payments' }, { github: 'org/shared', baseBranch: 'develop' }],
      role: 'Explorer',
      expertise: 'Investigation',
    });

    expect(def.repo!.repos.map((r) => r.autoMerge)).toEqual([false, false]);
  });
});
