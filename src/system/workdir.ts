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
      lastPluginsRefresh = Date.now();
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
// Plugins refresh (cached — pulls at most once per cooldown period)
// =============================================================================

const PLUGINS_REFRESH_COOLDOWN_MS = 30 * 60_000; // 30 minutes
let lastPluginsRefresh = 0;
let managedPlugins = false;
let pluginsRefreshPromise: Promise<void> | null = null;

/**
 * Pull latest plugins if cooldown has elapsed, then re-scan plugin definitions.
 * Safe to call frequently — skips if pulled recently.
 * Deduplicates concurrent calls (returns same promise).
 */
export async function refreshPlugins(): Promise<void> {
  const now = Date.now();
  const cooldownRemaining = PLUGINS_REFRESH_COOLDOWN_MS - (now - lastPluginsRefresh);
  if (cooldownRemaining > 0) {
    logger.debug('workdir', `Plugins refresh skipped (cooldown: ${Math.round(cooldownRemaining / 60_000)}m remaining)`);
    return;
  }

  if (pluginsRefreshPromise) {
    logger.debug('workdir', 'Plugins refresh already in progress, deduplicating');
    return pluginsRefreshPromise;
  }

  pluginsRefreshPromise = (async () => {
    try {
      if (managedPlugins && existsSync(join(PLUGINS_DIR, '.git'))) {
        const branch = process.env.ARCHIE_PLUGINS_BRANCH || 'main';
        logger.system(`Plugins: fetching and resetting to origin/${branch}`);
        await execAsync('git fetch --all --prune', { cwd: PLUGINS_DIR });
        await execAsync(`git checkout "${branch}"`, { cwd: PLUGINS_DIR });
        await execAsync(`git reset --hard "origin/${branch}"`, { cwd: PLUGINS_DIR });
        logger.system('Plugins refreshed from remote');
      } else {
        logger.system('Plugins: skipping git sync (local/symlinked — not managed by archie)');
      }
      // Re-scan plugin definitions from disk (picks up new/changed agents, prompts, etc.)
      logger.system('Plugins: re-scanning definitions from disk');
      initPlugins();
      lastPluginsRefresh = Date.now();
    } catch (error) {
      logger.warn('workdir', `Failed to refresh plugins: ${error}`);
      // Still update timestamp to avoid hammering on persistent failures
      lastPluginsRefresh = Date.now();
    } finally {
      pluginsRefreshPromise = null;
    }
  })();

  return pluginsRefreshPromise;
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
