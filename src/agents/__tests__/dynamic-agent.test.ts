/**
 * Tests for PM-spawned dynamic repo agents (synthesis + team-scoped visibility).
 *
 * Pure-function level: no plugins from disk, no GitHub. We verify that a
 * DynamicAgentSpec re-synthesizes into a usable repo AgentDef, and that the
 * peer/visibility helpers surface a dynamic agent when it's passed in via the
 * task-team roster (but not via the bare registry).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { DynamicAgentSpec } from '../../types/task.js';
import { isRepoAgent } from '../../types/agent.js';
import {
  __setRegistryForTesting,
  synthesizeDynamicAgentDef,
  getVisiblePeerIdsForSender,
  findAgentDefsContainingRepo,
} from '../registry.js';

function repoAgent(pluginName: string, key: string, primary: string): AgentDef {
  return {
    id: `${key}-agent`,
    key,
    role: `${key} role`,
    expertise: 'e',
    pluginName,
    visibility: 'global',
    repo: { repos: [{ github: primary, baseBranch: 'main' }], primary },
  } as AgentDef;
}

describe('synthesizeDynamicAgentDef', () => {
  it('builds a global repo agent; first repo is primary; base defaults to main', () => {
    const spec: DynamicAgentSpec = {
      id: 'explorer-a3f9-agent',
      shortname: 'explorer',
      repos: [{ github: 'org/payments' }, { github: 'org/shared', baseBranch: 'develop' }],
      role: 'Payments explorer',
      expertise: 'Investigation',
    };
    const def = synthesizeDynamicAgentDef(spec);

    expect(def.id).toBe('explorer-a3f9-agent');
    expect(def.key).toBe('explorer');
    expect(isRepoAgent(def)).toBe(true);
    expect(def.repo!.primary).toBe('org/payments');
    expect(def.repo!.repos).toEqual([
      { github: 'org/payments', baseBranch: 'main', autoMerge: false },   // default filled in
      { github: 'org/shared', baseBranch: 'develop', autoMerge: false },  // explicit preserved
    ]);
    expect(def.visibility).toBe('global');
    expect(def.pluginName).toBe('<dynamic>');
    expect(def.model).toBe('opus'); // defaults to opus, like configured repo agents
  });

  it('throws on an empty repos list', () => {
    expect(() =>
      synthesizeDynamicAgentDef({ id: 'x-agent', shortname: 'x', repos: [], role: 'r', expertise: 'e' }),
    ).toThrow();
  });
});

describe('dynamic agent reachability via task-team roster', () => {
  beforeEach(() => {
    __setRegistryForTesting([repoAgent('engineering', 'backend', 'org/backend')]);
  });

  it('is invisible through the bare registry but visible through the task team', () => {
    const sender = repoAgent('engineering', 'backend', 'org/backend');
    const dynamic = synthesizeDynamicAgentDef({
      id: 'explorer-a3f9-agent', shortname: 'explorer',
      repos: [{ github: 'org/payments' }], role: 'r', expertise: 'e',
    });

    // Bare registry: only backend exists (and the sender is excluded) → no peers.
    expect(getVisiblePeerIdsForSender(sender)).not.toContain('explorer-a3f9-agent');

    // Task team (registry + dynamic): the dynamic agent is a reachable peer.
    const team = [sender, dynamic];
    expect(getVisiblePeerIdsForSender(sender, team)).toContain('explorer-a3f9-agent');
  });
});

describe('findAgentDefsContainingRepo (anti-duplication support)', () => {
  beforeEach(() => {
    __setRegistryForTesting([
      repoAgent('engineering', 'backend', 'org/backend'),
      repoAgent('engineering', 'mobile', 'org/mobile'),
    ]);
  });

  it('matches an agent whose primary is the repo', () => {
    const hits = findAgentDefsContainingRepo('org/backend');
    expect(hits.map((d) => d.id)).toEqual(['backend-agent']);
  });

  it('returns empty for a repo no plugin agent covers', () => {
    expect(findAgentDefsContainingRepo('org/payments')).toEqual([]);
  });
});
