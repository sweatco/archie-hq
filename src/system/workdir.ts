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
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

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

/** Global memory directory (cross-task, persistent) */
export const MEMORY_DIR = join(WORKDIR, 'memory');

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

  const pluginsUrl = process.env.ARCHIE_PLUGINS;
  if (pluginsUrl) {
    if (!existsSync(join(PLUGINS_DIR, '.git'))) {
      await cloneRepo(pluginsUrl, PLUGINS_DIR, 'plugins');
      lastPluginsRefresh = Date.now();
    } else {
      await refreshPlugins();
    }
  } else if (!existsSync(PLUGINS_DIR)) {
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
  repos: Array<{ key: string; githubRepo: string }>
): Promise<void> {
  for (const { key, githubRepo } of repos) {
    const repoPath = join(REPOS_DIR, key);
    const repoUrl = githubRepoToUrl(githubRepo);
    await cloneOrFetch(repoUrl, repoPath, key);
  }
}

// =============================================================================
// Plugins refresh (cached — pulls at most once per cooldown period)
// =============================================================================

const PLUGINS_REFRESH_COOLDOWN_MS = 30 * 60_000; // 30 minutes
let lastPluginsRefresh = 0;
let pluginsRefreshPromise: Promise<void> | null = null;

/**
 * Pull latest plugins if cooldown has elapsed.
 * Safe to call frequently — skips if pulled recently.
 * Deduplicates concurrent calls (returns same promise).
 */
export async function refreshPlugins(): Promise<void> {
  const now = Date.now();
  if (now - lastPluginsRefresh < PLUGINS_REFRESH_COOLDOWN_MS) return;

  if (pluginsRefreshPromise) return pluginsRefreshPromise;

  pluginsRefreshPromise = (async () => {
    try {
      if (existsSync(join(PLUGINS_DIR, '.git'))) {
        await execAsync('git pull --ff-only', { cwd: PLUGINS_DIR });
        logger.system('Plugins refreshed');
      }
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
async function cloneRepo(url: string, targetDir: string, label: string): Promise<void> {
  logger.system(`Cloning ${label} from ${url}...`);
  await execAsync(`git clone "${url}" "${targetDir}"`);
}

/**
 * Convert "org/repo" to an HTTPS clone URL.
 * HTTPS works with the existing GIT_ASKPASS infrastructure.
 */
function githubRepoToUrl(githubRepo: string): string {
  return `https://github.com/${githubRepo}.git`;
}

/**
 * Clone if missing, git fetch --all if exists.
 * Used for source repos (large, just need refs up to date for worktrees).
 */
async function cloneOrFetch(url: string, targetDir: string, label: string): Promise<void> {
  if (existsSync(join(targetDir, '.git'))) {
    logger.system(`Fetching latest for ${label}...`);
    try {
      await execAsync('git remote prune origin', { cwd: targetDir });
      await execAsync('git fetch --all', { cwd: targetDir });
    } catch (error) {
      logger.warn('workdir', `Failed to fetch ${label}, using existing refs: ${error}`);
    }
  } else {
    logger.system(`Cloning ${label} from ${url}...`);
    await execAsync(`git clone "${url}" "${targetDir}"`);
  }
}
