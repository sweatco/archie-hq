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
    // Compared against the input, not a copy of it: this test is about the policy
    // passing through what it is handed. The allowlist's actual contents are
    // pinned separately, so growing the constant does not fail this.
    expect(policy.sandbox.network.allowedDomains).toEqual([...TRUSTED_PACKAGE_REGISTRY_DOMAINS]);
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

  it('allowlists nodejs.org, without which node-gyp cannot fetch headers', () => {
    // The devdir redirect alone is not enough: node-gyp downloads
    // node-vX-headers.tar.gz from nodejs.org, and with only the two registries
    // allowlisted that 403s and every native build still fails.
    expect(TRUSTED_PACKAGE_REGISTRY_DOMAINS).toContain('nodejs.org');
  });

  it('keeps the egress allowlist to package-supply hosts only', () => {
    // Guards the boundary this constant exists to hold: each entry is a package
    // or toolchain source, never a general-purpose host that could serve as an
    // exfiltration channel.
    expect(TRUSTED_PACKAGE_REGISTRY_DOMAINS).toEqual([
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'nodejs.org',
    ]);
  });

  it('redirects node-gyp\'s devdir, so native addons can actually build', () => {
    // Without this node-gyp falls back to $HOME/.cache/node-gyp, which does not
    // exist in the image and sits outside allowWrite — so every native build
    // died on ENOENT. It stayed hidden because a failed OPTIONAL postinstall is
    // only a warning: the install still exits 0.
    const env = buildPackageManagerCacheEnv();
    expect(env.npm_config_devdir).toBe(`${CACHES_DIR}/node-gyp`);
  });

  it('leaves the node-gyp devdir overridable from a repo\'s own package.json', () => {
    // node-gyp reads npm_config_* but lets npm_package_config_node_gyp_* win.
    // Setting only the former keeps a repo able to override; setting the latter
    // here would silently outrank the repo's own config.
    expect(Object.keys(buildPackageManagerCacheEnv())).not.toContain(
      'npm_package_config_node_gyp_devdir',
    );
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
