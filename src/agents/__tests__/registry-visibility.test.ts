/**
 * Visibility & per-sender peer-list tests for the registry.
 *
 * These tests exercise the pure registry helpers by injecting a synthetic
 * registry state via the testing hooks. We don't load plugins from disk —
 * we just want to verify that `getVisiblePeerIdsForSender` and
 * `buildPeerListForSender` honour the visibility rules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import {
  __setRegistryForTesting,
  getVisiblePeerIdsForSender,
  buildPeerListForSender,
} from '../registry.js';

function mkPlugin(pluginName: string, key: string, visibility: 'global' | 'local', extras: Partial<AgentDef> = {}): AgentDef {
  return {
    id: `${key}-agent`,
    key,
    role: `${key} role`,
    expertise: `${key} expertise`,
    pluginName,
    visibility,
    ...extras,
  } as AgentDef;
}

function mkRepo(pluginName: string, key: string, visibility: 'global' | 'local'): AgentDef {
  return {
    id: `${key}-agent`,
    key,
    role: `${key} role`,
    expertise: `${key} expertise`,
    pluginName,
    visibility,
    repo: {
      githubRepo: `org/${key}`,
      repoKey: key,
      defaultPath: `/repos/${key}`,
    },
  } as AgentDef;
}

function mkPm(): AgentDef {
  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: 'Coordination',
    isPm: true,
    pluginName: 'pm',
    visibility: 'global',
  } as AgentDef;
}

describe('getVisiblePeerIdsForSender', () => {
  beforeEach(() => {
    __setRegistryForTesting([
      mkPm(),
      mkPlugin('analytics', 'analytics', 'global'),
      mkPlugin('analytics', 'analytics-helper', 'local'),
      mkPlugin('frontend', 'frontend', 'global'),
      mkPlugin('frontend', 'frontend-internal', 'local'),
      mkRepo('engineering', 'backend', 'global'),
    ]);
  });

  it('a global agent sees all globals + its own plugin locals (no other-plugin locals)', () => {
    const sender = mkPlugin('analytics', 'analytics', 'global');
    expect(getVisiblePeerIdsForSender(sender).sort()).toEqual([
      'analytics-helper-agent',
      'backend-agent',
      'frontend-agent',
    ]);
  });

  it('a local agent sees the same set as a sibling global', () => {
    const sender = mkPlugin('analytics', 'analytics-helper', 'local');
    expect(getVisiblePeerIdsForSender(sender).sort()).toEqual([
      'analytics-agent',
      'backend-agent',
      'frontend-agent',
    ]);
  });

  it('PM (in `pm` plugin) sees all globals and pm-plugin locals', () => {
    __setRegistryForTesting([
      mkPm(),
      mkPlugin('analytics', 'analytics', 'global'),
      mkPlugin('analytics', 'analytics-helper', 'local'),
      mkPlugin('pm', 'pm-helper', 'local'),
    ]);
    const pm = mkPm();
    expect(getVisiblePeerIdsForSender(pm).sort()).toEqual([
      'analytics-agent',
      'pm-helper-agent',
    ]);
  });

  it('excludes the sender itself', () => {
    const sender = mkPlugin('analytics', 'analytics', 'global');
    expect(getVisiblePeerIdsForSender(sender)).not.toContain('analytics-agent');
  });

  it('an agent in a plugin with only locals sees its siblings + external globals', () => {
    __setRegistryForTesting([
      mkPm(),
      mkPlugin('isolated', 'iso-a', 'local'),
      mkPlugin('isolated', 'iso-b', 'local'),
      mkPlugin('other', 'other', 'global'),
    ]);
    const sender = mkPlugin('isolated', 'iso-a', 'local');
    expect(getVisiblePeerIdsForSender(sender).sort()).toEqual([
      'iso-b-agent',
      'other-agent',
    ]);
  });

  it('a local repo agent is invisible to other plugins', () => {
    __setRegistryForTesting([
      mkPm(),
      mkRepo('engineering', 'private-repo', 'local'),
      mkPlugin('frontend', 'frontend', 'global'),
    ]);
    const sender = mkPlugin('frontend', 'frontend', 'global');
    expect(getVisiblePeerIdsForSender(sender)).not.toContain('private-repo-agent');
  });
});

describe('buildPeerListForSender', () => {
  beforeEach(() => {
    __setRegistryForTesting([
      mkPm(),
      mkPlugin('analytics', 'analytics', 'global'),
      mkPlugin('analytics', 'analytics-helper', 'local'),
      mkPlugin('frontend', 'frontend-internal', 'local'),
      mkRepo('engineering', 'backend', 'global'),
    ]);
  });

  it('renders repo peers and plugin peers in their respective formats', () => {
    const sender = mkPlugin('analytics', 'analytics', 'global');
    const list = buildPeerListForSender(sender);
    expect(list).toContain('- backend-agent: backend role (backend repository)');
    expect(list).toContain('- analytics-helper-agent: analytics-helper role [analytics]');
    expect(list).not.toContain('frontend-internal-agent');
  });

  it('a plugin with only locals shows external globals + same-plugin siblings', () => {
    const sender = mkPlugin('frontend', 'frontend-internal', 'local');
    const list = buildPeerListForSender(sender);
    expect(list).toContain('backend-agent');
    expect(list).toContain('analytics-agent');
    expect(list).not.toContain('analytics-helper-agent');
  });
});
