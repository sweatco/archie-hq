/**
 * Sandbox config + policy-tier tests.
 *
 * These pin the SHAPE of what we hand the SDK. They cannot prove the CLI
 * actually enforces it — that regressed once with the config unchanged (CLI
 * 2.1.156 → 2.1.157) and no unit test could have caught it. The live boundary
 * assertion lives in tools/e2e/egress-check.ts; this file guards the wiring
 * those live checks depend on.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSandboxConfig,
  buildManagedNetworkPolicy,
  buildPackageManagerCacheEnv,
  TRUSTED_PACKAGE_REGISTRY_DOMAINS,
  type SandboxOptions,
} from '../sandbox.js';

const base: SandboxOptions = {
  cwd: '/workdir/sessions/task-1/workspace',
  allowReadPaths: ['/workdir/sessions/task-1/workspace'],
  allowWritePaths: ['/workdir/sessions/task-1/workspace'],
};

describe('buildManagedNetworkPolicy', () => {
  it('denies all egress when no domains are allowed', () => {
    expect(buildManagedNetworkPolicy(base).sandbox.network.allowedDomains).toEqual([]);
  });

  it('carries the allowlist it was given', () => {
    const policy = buildManagedNetworkPolicy({
      ...base,
      allowedNetworkDomains: [...TRUSTED_PACKAGE_REGISTRY_DOMAINS],
    });
    expect(policy.sandbox.network.allowedDomains).toEqual([
      'registry.npmjs.org',
      'registry.yarnpkg.com',
    ]);
  });

  it('always sets allowManagedDomainsOnly — the allowlist is not enforced without it', () => {
    // Verified empirically: with this flag absent the policy tier has no effect
    // and Bash reaches any host, even under an explicit allowlist.
    expect(buildManagedNetworkPolicy(base).sandbox.network.allowManagedDomainsOnly).toBe(true);
    expect(
      buildManagedNetworkPolicy({ ...base, allowedNetworkDomains: ['example.invalid'] }).sandbox
        .network.allowManagedDomainsOnly,
    ).toBe(true);
  });

  it('agrees with buildSandboxConfig on the domain list, so the two tiers cannot drift', () => {
    const opts: SandboxOptions = { ...base, allowedNetworkDomains: ['sheets.googleapis.com'] };
    expect(buildManagedNetworkPolicy(opts).sandbox.network.allowedDomains).toEqual(
      buildSandboxConfig(opts).network.allowedDomains,
    );
  });
});

describe('buildPackageManagerCacheEnv', () => {
  const WORKSPACE = '/workdir/sessions/task-1/workspace';

  it('moves npm and yarn caches off the read-only $HOME', () => {
    const env = buildPackageManagerCacheEnv(WORKSPACE);
    expect(env.npm_config_cache).toBe(`${WORKSPACE}/.cache/npm`);
    expect(env.YARN_CACHE_FOLDER).toBe(`${WORKSPACE}/.cache/yarn`);
  });

  it('scopes caches per workspace so agents cannot share a cache', () => {
    // A shared cache (e.g. under /tmp) would let one agent stage content another
    // agent later installs from.
    const a = buildPackageManagerCacheEnv('/workdir/sessions/task-a/workspace');
    const b = buildPackageManagerCacheEnv('/workdir/sessions/task-b/workspace');
    expect(a.npm_config_cache).not.toBe(b.npm_config_cache);
    expect(a.YARN_CACHE_FOLDER).not.toBe(b.YARN_CACHE_FOLDER);
  });

  it('keeps every cache path inside the workspace, which is the writable region', () => {
    // If a cache escaped the workspace it would land somewhere denied and the
    // EROFS failure would come straight back.
    for (const value of Object.values(buildPackageManagerCacheEnv(WORKSPACE))) {
      expect(value.startsWith(`${WORKSPACE}/`)).toBe(true);
    }
  });
});

describe('buildSandboxConfig', () => {
  it('fails closed when the sandbox is unavailable instead of running unsandboxed', () => {
    expect(buildSandboxConfig(base).failIfUnavailable).toBe(true);
  });

  it('keeps the sandbox enabled and refuses unsandboxed escapes', () => {
    const cfg = buildSandboxConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowUnsandboxedCommands).toBe(false);
  });

  it('defaults to network deny-all', () => {
    expect(buildSandboxConfig(base).network.allowedDomains).toEqual([]);
  });
});
