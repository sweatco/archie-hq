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

import { dirname, isAbsolute, resolve, normalize } from 'path';
import { lstat, readlink } from 'node:fs/promises';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { CACHES_DIR, REPOS_DIR } from '../system/workdir.js';
import { getReposPath } from '../tasks/persistence.js';

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
 * A path MAY appear in both allowRead and allowWrite. This comment used to claim the
 * opposite — that a later allowRead --ro-bind downgrades the writable mount — which was
 * measured under bubblewrap 0.11.0 and does not reproduce; see Known Limitation 1 in
 * docs/architecture/security.md.
 *
 * Writable implies readable here, so both lists is redundant at this layer but not
 * everywhere: assertReadable (src/agents/artifacts.ts) validates allowReadPaths alone, so
 * a write-only path cannot be handed to the artifact tools.
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

// ---- Repository grants ----

/** The repo half of a task's filesystem policy, keyed on directories. */
export interface RepoGrants {
  /** Readable in both modes. */
  read: string[];
  /** Writable — non-empty only in edit mode. */
  write: string[];
  /** Denied for writing, whatever else allows it. */
  denyWrite: string[];
}

/**
 * Repository read/write grants for one task, derived from PATHS rather than
 * from the clones that happen to exist.
 *
 * The distinction is the whole point. `mount_repo` creates a clone in the
 * middle of a session while the sandbox policy stays frozen from spawn, so a
 * policy enumerated from `metadata.repositories` froze the session to the repos
 * it booted with: the first mount landed in a directory the sandbox could
 * neither read nor write, and the PM had to be respawned before it could open
 * the file it had just cloned. Granting the task's clone ROOT closes that.
 *
 * Two directories, three rules:
 *
 * - `sessions/<taskId>/repos/` — this task's own clones. Always readable
 *   (reading code is allowed before edit mode); writable exactly when edit mode
 *   is approved.
 * - `workdir/repos/` — the shared base-clone cache. Always readable, because
 *   task clones are made with `git clone --shared` and borrow its `.git/objects`
 *   for their whole life. NEVER writable, in either mode: a task that could
 *   rewrite a base clone would corrupt every other task sharing it.
 */
export function buildRepoGrants(taskId: string, editAllowed: boolean): RepoGrants {
  const taskRepos = getReposPath(taskId);
  return {
    read: [taskRepos, REPOS_DIR],
    write: editAllowed ? [taskRepos] : [],
    // The base cache is denied in both modes; the task's own clones are denied
    // only while the task is read-only.
    denyWrite: editAllowed ? [REPOS_DIR] : [REPOS_DIR, taskRepos],
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
 * Shared across every agent and task (`CACHES_DIR`), NOT per workspace. This
 * used to point at the agent's own workspace to avoid a shared cache letting one
 * agent stage content another agent later installs from — the alternative on the
 * table then was `/tmp`, which is world-writable inside the sandbox and a bad
 * place for this. A managed directory under the workdir is not: it costs one
 * `allowWrite` entry, and the caches it holds are content-addressed and verified
 * on read, so the staging attack does not survive the integrity check.
 *
 * Verified rather than assumed, because the whole design rests on it. Corrupting
 * a cached tarball for a lockfile-pinned package and reinstalling gives
 * `npm warn tarball ... seems to be corrupted. Refreshing cache.` — npm hashes
 * content while streaming and compares against the lockfile's `integrity`, so a
 * mismatch discards the entry and refetches. Poisoning a pinned install needs a
 * SHA-512 preimage. Yarn Berry checks cache zips against `yarn.lock` checksums
 * (`checksumBehavior: throw`) on the same terms.
 *
 * The exception, accepted knowingly: `_npx`. It is a materialized, *executable*
 * `node_modules` that npx reuses on directory presence and never re-verifies —
 * appending to a file inside it and re-running the same `npx` command executes
 * the modified code, with a `package-lock.json` sitting unread beside it. npm
 * derives `_npx`, `_cacache` and `_tuf` from the single `cache` config
 * (`@npmcli/config` definitions: `cache`), so there is no env that splits them.
 * MCP servers launched `npx -y` therefore share a tamperable tree. Closing it
 * means either preinstalling those servers in the image (couples the plugins repo
 * to the Dockerfile) or symlinking `_cacache` out to a shared dir while `_npx`
 * stays per-task and gets reaped. Both work; neither was worth the complexity
 * against a per-task cost of ~285 GB.
 *
 * Note the sharing is only sound for package managers that verify against a
 * committed lockfile. pip (`requirements.txt` without hashes) and Bundler
 * (`Gemfile.lock` carries no digests) do NOT have this property — do not add
 * their caches here on the strength of the reasoning above.
 *
 * Concurrency: npm's `_cacache` is built for concurrent writers. Yarn Berry's
 * global cache is weaker — parallel installs can leave a partial zip — but
 * `checksumBehavior: throw` rejects it and refetches, so it surfaces as a flaky
 * install rather than a silently wrong one. `createKeyedLock` is available if
 * that ever shows up in practice.
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
export function buildPackageManagerCacheEnv(): Record<string, string> {
  const cacheRoot = CACHES_DIR;
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

async function resolveGuardPath(path: string): Promise<string> {
  const parts = path.split('/');
  let current = '/';
  let links = 0;

  while (parts.length > 0) {
    const part = parts.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }

    const next = resolve(current, part);
    const entry = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry?.isSymbolicLink()) {
      if (++links > 40) throw new Error('Too many symbolic links');
      const target = await readlink(next);
      if (isAbsolute(target)) current = '/';
      parts.unshift(...target.split('/'));
    } else {
      current = next;
    }
  }

  return current;
}

/**
 * MCP servers that belong to the agent that owns the conversation with the
 * user, and to nobody it delegates to. They post to Slack, resolve the task
 * lifecycle (report_completion, request_edit_mode, mount_repo) and schedule
 * reminders — all things a throwaway worker must not do behind the PM's back.
 *
 * Kept as one exported constant so the blast radius is visible in a single
 * place. Everything NOT listed here (repo-tools, research-tools, file-bridge,
 * plugin/domain servers) stays available to workers: reading and investigating
 * is exactly what they are for.
 */
export const PM_ONLY_MCP_SERVERS = [
  'comms-tools',
  'orchestration-tools',
  'scheduling-tools',
];

/**
 * Create a PreToolUse hook that keeps PM-only MCP servers out of subagents.
 *
 * This was a prompt rule only, and prompt rules get ignored: a general-purpose
 * subagent was observed calling `mcp__comms-tools__post_to_user` and messaging
 * the user directly, bypassing the PM entirely.
 *
 * The discriminator is `agent_id` on the hook input, which the SDK sets ONLY
 * when the tool call originates inside a subagent (see `BaseHookInput` in the
 * SDK types — absent on the main thread, even for `--agent` sessions).
 * `agent_type` is deliberately not used: it is also present on a main thread
 * started with `--agent`, which would deny the PM its own tools.
 */
export function createPmOnlyToolGuardHooks(): HookCallbackMatcher[] {
  return [{
    hooks: [async (input: any) => {
      const { tool_name, agent_id } = input;

      // Main thread (the PM or a specialist's own session) — untouched.
      if (!agent_id) return { continue: true };

      const isPmOnly = typeof tool_name === 'string'
        && PM_ONLY_MCP_SERVERS.some((s) => tool_name.startsWith(`mcp__${s}__`));
      if (!isPmOnly) return { continue: true };

      return deny(
        `${tool_name} is a PM-only tool; return your result to the PM instead.`,
      );
    }],
  }];
}

/**
 * Create PreToolUse hooks that enforce filesystem boundaries on
 * in-process tools (Read, Write, Edit, Glob, Grep).
 *
 * Returns a single matcher (no `matcher` field → fires on all tools)
 * that filters by tool_name inside the callback.
 */
export function createFilesystemGuardHooks(opts: SandboxOptions): HookCallbackMatcher[] {
  let roots: Promise<{ read: string[]; write: string[]; protected: string[] }> | undefined;
  return [{
    hooks: [async (input: any) => {
      const { tool_name, tool_input } = input;

      if (!READ_TOOLS.has(tool_name) && !WRITE_TOOLS.has(tool_name)) {
        return { continue: true };
      }

      const rawPath = tool_input?.file_path ?? tool_input?.path ?? '.';
      if (typeof rawPath !== 'string' || rawPath.includes('\0')) {
        return deny('Invalid filesystem path');
      }

      try {
        roots ??= Promise.all([
          Promise.all([...opts.allowReadPaths, ...(opts.allowWritePaths ?? [])].map(resolveGuardPath)),
          Promise.all((opts.allowWritePaths ?? []).map(resolveGuardPath)),
          Promise.all((opts.denyWritePaths ?? []).map(resolveGuardPath)),
        ]).then(([read, write, protectedPaths]) => ({ read, write, protected: protectedPaths }));
        const allowed = await roots;
        const path = await resolveGuardPath(isAbsolute(rawPath) ? rawPath : `${opts.cwd}/${rawPath}`);

        if (READ_TOOLS.has(tool_name)) {
          if (!isUnderAny(path, allowed.read)) {
            return deny(`Read denied: ${path} is outside allowed paths`);
          }
        } else {
          if (!isUnderAny(path, allowed.write)) {
            return deny(`Write denied: ${path} is outside allowed paths`);
          }
          if (isUnderAny(path, allowed.protected) || isUnderAny(resolve(opts.cwd, rawPath), opts.denyWritePaths ?? [])) {
            return deny(`Write denied: ${path} is in a protected path`);
          }
        }
      } catch {
        return deny('Cannot safely resolve filesystem path');
      }

      return { continue: true };
    }],
  }];
}
