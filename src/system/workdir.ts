/**
 * Workdir Bootstrap
 *
 * Central module for resolving all runtime directories and bootstrapping
 * the working directory structure (cloning plugins and repos).
 *
 * Path constants are synchronous and safe for module-level imports.
 * Bootstrap functions are async and must be called from main() at startup.
 */

import { join } from 'path';
import { existsSync, lstatSync } from 'fs';
import { mkdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { initPlugins } from './plugin-loader.js';
import { logger } from './logger.js';
import { githubRepoToUrl } from '../connectors/github/repo-clone.js';

const execAsync = promisify(exec);

// =============================================================================
// Path constants (synchronous — safe for module-level use anywhere)
// =============================================================================

/** Base working directory. Everything lives under here. */
export const WORKDIR = process.env.ARCHIE_WORKDIR || join(process.cwd(), 'workdir');

/** Plugins directory (cloned from ARCHIE_PLUGINS git URL) */
export const PLUGINS_DIR = join(WORKDIR, 'plugins');

/** Base repos directory (auto-cloned from plugin repo-config.json) */
export const REPOS_DIR = join(WORKDIR, 'repos');

/** Sessions directory (task runtime data) */
export const SESSIONS_DIR = join(WORKDIR, 'sessions');

/** Persistent per-plugin data directory */
export const PLUGINS_DATA_DIR = join(WORKDIR, 'plugins-data');

/**
 * Directory holding encrypted runtime secrets (e.g. OAuth tokens).
 * Defaults to `/app/secrets` (the docker-mounted volume) when present,
 * otherwise `<repo>/secrets` for local development. Override with
 * `ARCHIE_SECRETS_DIR`.
 */
export const SECRETS_DIR = (() => {
  const override = process.env.ARCHIE_SECRETS_DIR;
  if (override) return override;
  if (existsSync('/app/secrets')) return '/app/secrets';
  return join(process.cwd(), 'secrets');
})();

/** OAuth token records, one file per MCP server. */
export const OAUTH_DIR = join(SECRETS_DIR, 'oauth');

/** Pending OAuth attempts (short-lived state during an authorize flow). */
export const OAUTH_PENDING_DIR = join(OAUTH_DIR, '.pending');

// =============================================================================
// Bootstrap (async — must be called from main() before plugin/repo loading)
// =============================================================================

/**
 * Bootstrap the workdir:
 * 1. Ensure directory structure exists
 * 2. Clone/pull plugins repo (if ARCHIE_PLUGINS is set)
 *
 * Must be called once at startup before initPlugins().
 */
export async function bootstrapWorkdir(): Promise<void> {
  await mkdir(WORKDIR, { recursive: true });
  await mkdir(REPOS_DIR, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
  await mkdir(PLUGINS_DATA_DIR, { recursive: true });
  await mkdir(OAUTH_DIR, { recursive: true, mode: 0o700 });
  await mkdir(OAUTH_PENDING_DIR, { recursive: true, mode: 0o700 });

  const pluginsUrl = process.env.ARCHIE_PLUGINS;
  const pluginsBranch = process.env.ARCHIE_PLUGINS_BRANCH;
  if (pluginsUrl) {
    const isSymlink = existsSync(PLUGINS_DIR) && lstatSync(PLUGINS_DIR).isSymbolicLink();
    const hasGit = existsSync(join(PLUGINS_DIR, '.git'));
    logger.system(`Plugins init: url=${pluginsUrl}, branch=${pluginsBranch || 'default'}, exists=${hasGit}, symlink=${isSymlink}`);

    if (!hasGit) {
      logger.system(`Plugins: cloning fresh from ${pluginsUrl}`);
      await cloneRepo(pluginsUrl, PLUGINS_DIR, 'plugins', pluginsBranch);
      managedPlugins = true;
    } else {
      // Symlink = local dev (don't reset), real dir = cloned by us (safe to reset)
      managedPlugins = !isSymlink;
      logger.system(`Plugins: managed=${managedPlugins} (${isSymlink ? 'symlink — local dev' : 'real dir — will sync from remote'})`);
      if (pluginsBranch && managedPlugins) await checkoutBranch(PLUGINS_DIR, pluginsBranch, 'plugins');
      await refreshPlugins();
    }
  } else if (existsSync(PLUGINS_DIR)) {
    logger.system(`Plugins init: using pre-existing directory at ${PLUGINS_DIR} (ARCHIE_PLUGINS not set)`);
  } else {
    throw new Error(
      `Plugins directory not found at ${PLUGINS_DIR}. ` +
      `Set ARCHIE_PLUGINS to a git URL, or manually place plugins in ${PLUGINS_DIR}.`
    );
  }
}

/**
 * Clone repos declared by plugins. Called after plugins are loaded.
 *
 * @param repos - Array of { key, githubRepo } from loaded plugin configs
 */
export async function cloneRepos(
  repos: Array<{ key: string; githubRepo: string; baseBranch?: string }>
): Promise<void> {
  for (const { key, githubRepo, baseBranch } of repos) {
    const repoPath = join(REPOS_DIR, key);
    const repoUrl = githubRepoToUrl(githubRepo);
    await cloneOrFetch(repoUrl, repoPath, key, baseBranch);
  }
}

// =============================================================================
// Plugins refresh (HEAD-checked — updates only when the remote branch moves)
// =============================================================================

let managedPlugins = false;
let pluginsRefreshPromise: Promise<boolean> | null = null;

/**
 * Check the plugins remote for new commits and, if the branch tip moved,
 * hard-reset onto it and re-scan plugin definitions from disk.
 *
 * There is no time-based TTL. Every call does a lightweight `git ls-remote`
 * to read the remote branch tip and compares it against the local HEAD:
 *   - tips equal   → nothing changed; returns false (no fetch, no re-scan)
 *   - tips differ  → fetch + reset --hard + re-scan; returns true
 * So a push to the plugins repo is picked up on the very next request, while
 * an unchanged repo costs only one cheap ref lookup.
 *
 * Returns true when plugin definitions were (re)loaded — callers can then
 * rebuild the agent registry and clone any newly-declared repos (see
 * {@link syncPlugins}). Deduplicates concurrent calls (returns the in-flight
 * promise so a burst of requests triggers at most one check).
 */
export async function refreshPlugins(): Promise<boolean> {
  if (pluginsRefreshPromise) {
    logger.debug('workdir', 'Plugins refresh already in progress, deduplicating');
    return pluginsRefreshPromise;
  }

  pluginsRefreshPromise = (async () => {
    try {
      if (managedPlugins && existsSync(join(PLUGINS_DIR, '.git'))) {
        const branch = process.env.ARCHIE_PLUGINS_BRANCH || 'main';
        const remoteSha = await getRemoteHeadSha(PLUGINS_DIR, branch);
        if (!remoteSha) {
          // Couldn't reach the remote — keep what we have and try again next call.
          logger.warn('workdir', `Plugins: could not read remote ${branch} tip; leaving plugins unchanged`);
          return false;
        }
        const localSha = await getLocalHeadSha(PLUGINS_DIR);
        if (remoteSha === localSha) {
          logger.debug('workdir', `Plugins up to date (${branch} @ ${remoteSha.slice(0, 8)})`);
          return false;
        }
        logger.system(`Plugins: ${branch} moved ${localSha?.slice(0, 8) ?? 'unknown'} → ${remoteSha.slice(0, 8)}, updating`);
        await execAsync('git fetch --all --prune', { cwd: PLUGINS_DIR });
        await execAsync(`git checkout "${branch}"`, { cwd: PLUGINS_DIR });
        await execAsync(`git reset --hard "origin/${branch}"`, { cwd: PLUGINS_DIR });
        logger.system('Plugins refreshed from remote');
        // Re-scan plugin definitions (picks up new/changed agents, prompts, etc.)
        initPlugins();
        return true;
      }

      // Local/symlinked checkout (local dev) — no remote to diff against, so
      // re-scan from disk every call to pick up in-place edits.
      logger.debug('workdir', 'Plugins: local/symlinked — re-scanning definitions from disk');
      initPlugins();
      return true;
    } catch (error) {
      logger.warn('workdir', `Failed to refresh plugins: ${error}`);
      return false;
    } finally {
      pluginsRefreshPromise = null;
    }
  })();

  return pluginsRefreshPromise;
}

/** Read the remote branch tip via `ls-remote` (no object download). Returns null on failure. */
async function getRemoteHeadSha(repoDir: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git ls-remote origin "refs/heads/${branch}"`, { cwd: repoDir });
    const sha = stdout.split(/\s+/)[0]?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (error) {
    logger.debug('workdir', `ls-remote failed for ${branch}: ${error}`);
    return null;
  }
}

/** Read the local HEAD sha. Returns null on failure. */
async function getLocalHeadSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoDir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// =============================================================================
// Git helpers
// =============================================================================

/**
 * Clone a git repo into targetDir.
 */
async function cloneRepo(url: string, targetDir: string, label: string, branch?: string): Promise<void> {
  const branchFlag = branch ? ` -b "${branch}"` : '';
  logger.system(`Cloning ${label} from ${url}${branch ? ` (branch: ${branch})` : ''}...`);
  await execAsync(`git clone --recurse-submodules${branchFlag} "${url}" "${targetDir}"`);
}

async function checkoutBranch(repoDir: string, branch: string, label: string): Promise<void> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir });
    if (stdout.trim() === branch) return;
    await execAsync('git fetch --all', { cwd: repoDir });
    await execAsync(`git checkout "${branch}"`, { cwd: repoDir });
    logger.system(`Switched ${label} to branch ${branch}`);
  } catch (error) {
    logger.warn('workdir', `Failed to switch ${label} to branch ${branch}: ${error}`);
  }
}

/**
 * Clone if missing, fetch and pull default branch if exists.
 */
async function cloneOrFetch(url: string, targetDir: string, label: string, baseBranch?: string): Promise<void> {
  if (existsSync(join(targetDir, '.git'))) {
    logger.system(`Pulling latest for ${label}...`);
    try {
      await execAsync('git remote prune origin', { cwd: targetDir });
      await execAsync('git fetch --all', { cwd: targetDir });
      const branch = baseBranch || 'main';
      await execAsync(`git checkout "${branch}"`, { cwd: targetDir });
      await execAsync(`git reset --hard "origin/${branch}"`, { cwd: targetDir });
    } catch (error) {
      logger.warn('workdir', `Failed to pull ${label}, using existing state: ${error}`);
    }
  } else {
    const branchFlag = baseBranch ? ` -b "${baseBranch}"` : '';
    logger.system(`Cloning ${label} from ${url}...`);
    await execAsync(`git clone${branchFlag} "${url}" "${targetDir}"`);
  }
}
