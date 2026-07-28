/**
 * Agent Sandbox Configuration
 *
 * Builds OS-level sandbox config (Bash tool) and PreToolUse hooks
 * (in-process tools) to enforce filesystem and network boundaries.
 *
 * Three enforcement layers from the same SandboxOptions:
 * 1. buildSandboxConfig()         → SDK sandbox (bubblewrap/sandbox-exec for Bash)
 * 2. buildManagedNetworkPolicy()  → policy tier that actually enforces the egress allowlist
 * 3. createFilesystemGuardHooks() → PreToolUse hooks (Read, Write, Edit, Glob, Grep)
 *
 * Layers 1 and 2 both carry the network allowlist, and BOTH are required — see
 * buildManagedNetworkPolicy for why the sandbox config alone does not enforce it.
 */

import { resolve, normalize } from 'path';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

// ---- Types ----

export interface SandboxOptions {
  /** Agent's working directory */
  cwd: string;
  /** Paths the agent can read (should include cwd) */
  allowReadPaths: string[];
  /** Paths the agent can write (default: none = read-only) */
  allowWritePaths?: string[];
  /** Paths to deny within allowWrite regions (e.g., cwd/.claude) */
  denyWritePaths?: string[];
  /** Additional paths to deny reading (appended to global denyRead) */
  denyReadPaths?: string[];
  /** Domains Bash can reach (empty = deny all, default) */
  allowedNetworkDomains?: string[];
}

/**
 * Trusted public package registries that repo build sandboxes may reach when a
 * human has approved edit mode — just enough egress to run `npm`/`yarn` installs
 * and regenerate lockfiles. Deliberately minimal: these two hosts cover npm
 * (tarballs serve from registry.npmjs.org) and Yarn 4 (default
 * registry.yarnpkg.com). Listing the hostnames also permits DNS resolution for
 * them, so no separate DNS rule is needed.
 *
 * This list is intentionally a hardcoded constant — NOT plugin- or PM-settable —
 * so the egress surface can't be widened from a hot-reloaded plugins change or a
 * compromised orchestrator. A broader "trusted" list is tracked separately.
 */
export const TRUSTED_PACKAGE_REGISTRY_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
];

// ---- Sandbox config (OS-level, Bash only) ----

/**
 * Sandbox strategy:
 * - Reads: system paths open (Bash needs /bin, /usr, /etc, etc.).
 *   App code (/app) and workdir (/workdir) denied, then specific agent paths re-allowed.
 *   PreToolUse hooks enforce same read boundaries on in-process tools.
 * - Writes: deny-all by default, allowWrite for workspace + /tmp.
 *   denyWrite for protected paths within workspace (settings, skills).
 * - Network: deny-all by default from Bash.
 */
/**
 * IMPORTANT: allowRead and allowWrite must NOT overlap on the same path.
 * bwrap processes mounts sequentially: allowWrite creates a --bind (rw) mount,
 * then allowRead creates a --ro-bind mount on the same path, which OVERRIDES
 * the writable mount, downgrading it to read-only. If a path needs write access,
 * put it ONLY in allowWritePaths — writable bind mounts provide read access too.
 */
export function buildSandboxConfig(opts: SandboxOptions) {
  return {
    enabled: true,
    // Refuse to run rather than degrade: without this the SDK falls back to
    // running commands UNSANDBOXED (with only a warning) when bwrap/sandbox-exec
    // is missing. A silent downgrade of every boundary is not an acceptable
    // failure mode for a deployment that documents these guarantees.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      // Callers deny WORKDIR broadly, then allowRead/allowWrite specific subdirs.
      denyRead: ['/app', '/home/archie/.claude', ...(opts.denyReadPaths || [])],
      allowRead: ['/home/archie/.claude/shell-snapshots', ...new Set(opts.allowReadPaths)],
      allowWrite: ['/tmp', ...(opts.allowWritePaths || [])],
      ...(opts.denyWritePaths && opts.denyWritePaths.length > 0
        ? { denyWrite: opts.denyWritePaths }
        : {}),
    },
    network: {
      allowedDomains: opts.allowedNetworkDomains ?? [],
    },
  };
}

// ---- Managed policy tier (what actually enforces the egress allowlist) ----

/**
 * Build the policy-tier settings that enforce the outbound-network allowlist.
 *
 * Why this exists as a second layer: `sandbox.network.allowedDomains` passed via
 * the SDK's `sandbox` option is NOT enforced under `permissionMode:
 * 'bypassPermissions'` — which every agent runs under (see spawn.ts). From CLI
 * 2.1.157 onward the domain filter is resolved through permission evaluation,
 * and bypass mode short-circuits that to allow-all, so the allowlist is ignored
 * and Bash reaches any host. CLI 2.1.156 and earlier did enforce it; the change
 * arrived here transitively via a lockfile refresh, silently, which is why
 * tools/e2e/egress-check.ts asserts the boundary on a live instance.
 *
 * The `managedSettings` tier is the SDK's documented channel for an embedding
 * application to impose lockdown on the spawned CLI, and it is honored
 * regardless of permission mode. `allowManagedDomainsOnly` is load-bearing:
 * without it the policy tier has no effect at all (verified empirically). It
 * also narrows the surface — domain rules from user, project, local, and flag
 * settings are ignored, so a `.claude/settings.json` inside a task folder or a
 * repo checkout cannot widen egress. Denied domains are still honored from
 * every tier.
 *
 * IMPORTANT: because `allowManagedDomainsOnly` makes this tier authoritative,
 * every domain an agent may legitimately reach must appear HERE. Feed it the
 * same array as buildSandboxConfig (both derive from one SandboxOptions) or
 * plugin-declared domains will be silently dropped.
 *
 * Deployment caveat: if the host has an IT-controlled managed-settings tier
 * (e.g. /etc/claude-code/managed-settings.json), the SDK DROPS these parent
 * settings unless that admin opts in with `parentSettingsBehavior: 'merge'` —
 * and egress would reopen with no error. The live egress check is what catches
 * that.
 */
export function buildManagedNetworkPolicy(opts: SandboxOptions) {
  return {
    sandbox: {
      network: {
        allowedDomains: opts.allowedNetworkDomains ?? [],
        allowManagedDomainsOnly: true,
      },
    },
  };
}

// ---- Package manager caches ----

/**
 * Environment that lets package managers actually run inside the sandbox.
 *
 * npm and yarn default their caches to `$HOME` (`~/.npm`, `~/.cache/yarn`), and
 * `$HOME` is NOT in allowWrite — so `npm install` dies with
 * `EROFS: read-only file system, open '/home/archie/.npm/_cacache/tmp/...'`
 * *while fetching*, before the network allowlist is ever consulted. That EROFS
 * is what actually blocked `npm install` in edit mode; the failure reads like a
 * network problem (it names the registry URL) but is purely filesystem.
 *
 * Pointed at the agent's own workspace rather than a shared `/tmp`: a shared
 * cache would let one agent stage content that another agent later installs
 * from, which is a cross-task integrity problem we get to avoid for free.
 *
 * `npm_config_cache` is npm's env form of the `cache` config; yarn 1 reads
 * `YARN_CACHE_FOLDER`. Yarn 4 (Berry) needs more: it creates its *global folder*
 * (`$HOME/.yarn`) at startup, before parsing the project, and dies with
 * `Internal Error: ENOENT: no such file or directory, mkdir '/home/archie/.yarn'`
 * regardless of where its cache points — so `YARN_GLOBAL_FOLDER` is required too.
 * Repos that pin `packageManager` also let Corepack fetch the pinned release into
 * `COREPACK_HOME` (`~/.cache/node/corepack`), which is likewise unwritable.
 *
 * Observed live: the mobile repo pins yarn 4.12.0, and `yarn install` failed
 * instantly on the global-folder ENOENT while yarn 1 in the same sandbox worked
 * fine — which is why this covers both generations rather than just the cache.
 */
export function buildPackageManagerCacheEnv(workspace: string): Record<string, string> {
  const cacheRoot = resolve(workspace, '.cache');
  return {
    npm_config_cache: resolve(cacheRoot, 'npm'),
    YARN_CACHE_FOLDER: resolve(cacheRoot, 'yarn'),
    YARN_GLOBAL_FOLDER: resolve(cacheRoot, 'yarn-global'),
    COREPACK_HOME: resolve(cacheRoot, 'corepack'),
  };
}

// ---- PreToolUse hooks (in-process tools) ----

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/**
 * Check whether `target` path is under any of the `bases` directories.
 */
function isUnderAny(target: string, bases: string[]): boolean {
  const norm = normalize(target);
  return bases.some((b) => {
    const nb = normalize(b);
    return norm === nb || norm.startsWith(nb + '/');
  });
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Create PreToolUse hooks that enforce filesystem boundaries on
 * in-process tools (Read, Write, Edit, Glob, Grep).
 *
 * Returns a single matcher (no `matcher` field → fires on all tools)
 * that filters by tool_name inside the callback.
 */
export function createFilesystemGuardHooks(opts: SandboxOptions): HookCallbackMatcher[] {
  return [{
    hooks: [async (input: any) => {
      const { tool_name, tool_input } = input;

      if (!READ_TOOLS.has(tool_name) && !WRITE_TOOLS.has(tool_name)) {
        return { continue: true };
      }

      // Extract path from tool input
      let rawPath: string | undefined;
      if (tool_input && typeof tool_input === 'object') {
        if ('file_path' in tool_input) rawPath = tool_input.file_path as string;
        else if ('path' in tool_input) rawPath = tool_input.path as string;
      }

      // No path specified (Glob/Grep default to cwd) → allowed
      if (!rawPath) return { continue: true };

      // Resolve to absolute before checking
      const absPath = resolve(opts.cwd, rawPath);

      // Read check — allow if path is in allowRead OR allowWrite (writable implies readable)
      if (READ_TOOLS.has(tool_name)) {
        const canRead = isUnderAny(absPath, opts.allowReadPaths)
          || (opts.allowWritePaths && isUnderAny(absPath, opts.allowWritePaths));
        if (!canRead) {
          return deny(`Read denied: ${absPath} is outside allowed paths`);
        }
      }

      // Write check
      if (WRITE_TOOLS.has(tool_name)) {
        if (!opts.allowWritePaths || !isUnderAny(absPath, opts.allowWritePaths)) {
          return deny(`Write denied: ${absPath} is outside allowed paths`);
        }
        if (opts.denyWritePaths && isUnderAny(absPath, opts.denyWritePaths)) {
          return deny(`Write denied: ${absPath} is in a protected path`);
        }
      }

      return { continue: true };
    }],
  }];
}
