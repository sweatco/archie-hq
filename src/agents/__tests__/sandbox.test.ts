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
import { CACHES_DIR } from '../../system/workdir.js';

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
  it('moves npm and yarn caches off the read-only $HOME', () => {
    const env = buildPackageManagerCacheEnv();
    expect(env.npm_config_cache).toBe(`${CACHES_DIR}/npm`);
    expect(env.YARN_CACHE_FOLDER).toBe(`${CACHES_DIR}/yarn`);
  });

  it('redirects yarn 4 global folder and Corepack home, not just the cache', () => {
    // Yarn Berry creates $HOME/.yarn at startup before touching the project, so a
    // redirected cache alone leaves it dying on ENOENT (observed with the mobile
    // repo's pinned yarn 4.12.0). Corepack fetches pinned releases into
    // COREPACK_HOME, which is unwritable for the same reason.
    const env = buildPackageManagerCacheEnv();
    expect(env.YARN_GLOBAL_FOLDER).toBe(`${CACHES_DIR}/yarn-global`);
    expect(env.COREPACK_HOME).toBe(`${CACHES_DIR}/corepack`);
  });

  it('shares one cache across agents and tasks rather than scoping it per workspace', () => {
    // The regression this guards: caches used to live at
    // `<task>/agents/<agent>/.cache`, so every task re-downloaded the same bytes
    // and kept them forever — 697 per-task caches, ~285 GB, never reclaimed. The
    // paths are constants now precisely so no caller can reintroduce that.
    const env = buildPackageManagerCacheEnv();
    expect(env).toEqual(buildPackageManagerCacheEnv());
    for (const value of Object.values(env)) {
      expect(value.startsWith(`${CACHES_DIR}/`)).toBe(true);
      expect(value).not.toContain('/sessions/');
    }
  });

  it('takes no arguments, so a cache cannot be scoped to a caller-supplied path', () => {
    expect(buildPackageManagerCacheEnv.length).toBe(0);
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
