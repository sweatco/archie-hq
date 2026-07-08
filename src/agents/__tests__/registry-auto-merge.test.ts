/**
 * Registry merge-policy tests.
 *
 * Verifies the autoMerge resolution at the registry copy (scanAgentDefs):
 * absent on the plugin entry → resolved false; true carries through; and
 * PM-spawned dynamic agents are always false regardless of spec.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { logger } from '../../system/logger.js';
import { scanAgentDefs, synthesizeDynamicAgentDef, isAutoMergeRepo, __setRegistryForTesting } from '../registry.js';
import { isRepoAgent, type AgentDef, type RepoEntry } from '../../types/agent.js';

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

function repoAgentDef(key: string, repos: RepoEntry[]): AgentDef {
  return {
    id: `${key}-agent`,
    key,
    role: `${key} role`,
    expertise: 'e',
    pluginName: 'engineering',
    visibility: 'global',
    repo: { repos, primary: repos[0].github },
  } as AgentDef;
}

describe('isAutoMergeRepo', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('is false for a repo no registered agent declares', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [{ github: 'org/backend', baseBranch: 'main', autoMerge: true }]),
    ]);
    expect(isAutoMergeRepo('org/unknown')).toBe(false);
  });

  it('is true when the single declaring agent sets autoMerge: true', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [{ github: 'org/backend', baseBranch: 'main', autoMerge: true }]),
    ]);
    expect(isAutoMergeRepo('org/backend')).toBe(true);
  });

  it('is false when the single declaring agent leaves autoMerge off', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [{ github: 'org/backend', baseBranch: 'main', autoMerge: false }]),
    ]);
    expect(isAutoMergeRepo('org/backend')).toBe(false);
  });

  it('is true when two declaring agents both set true', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [{ github: 'org/shared', baseBranch: 'main', autoMerge: true }]),
      repoAgentDef('mobile', [{ github: 'org/shared', baseBranch: 'main', autoMerge: true }]),
    ]);
    expect(isAutoMergeRepo('org/shared')).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is false with a warn when two declaring agents disagree', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [{ github: 'org/shared', baseBranch: 'main', autoMerge: true }]),
      repoAgentDef('mobile', [{ github: 'org/shared', baseBranch: 'main', autoMerge: false }]),
    ]);
    expect(isAutoMergeRepo('org/shared')).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('is false when one agent declares the repo twice with mixed entries', () => {
    __setRegistryForTesting([
      repoAgentDef('backend', [
        { github: 'org/backend', baseBranch: 'main', autoMerge: true },
        { github: 'org/backend', baseBranch: 'develop', autoMerge: false },
      ]),
    ]);
    expect(isAutoMergeRepo('org/backend')).toBe(false);
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
