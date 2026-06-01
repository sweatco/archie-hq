/**
 * Plugin Sync
 *
 * Single entry point for keeping the running process in step with the plugins
 * repo. Wraps {@link refreshPlugins} and, when the remote branch has moved (or
 * a local dev checkout was re-scanned), rebuilds the cached agent registry and
 * clones the base repo for any newly-declared repo agents.
 *
 * Lives in its own module (rather than inside workdir.ts) to avoid an import
 * cycle: workdir.ts → plugin-loader.ts and registry.ts → workdir.ts, so the
 * orchestration that needs both must sit above them.
 */

import { refreshPlugins, cloneMissingRepos } from './workdir.js';
import { initRegistry, getAllAgentDefs } from '../agents/registry.js';
import { logger } from './logger.js';

/**
 * Pick up plugin repo changes for the current request.
 *
 * Cheap when nothing changed (one `git ls-remote` and a SHA compare). When the
 * plugins repo moved, this:
 *   1. hard-resets the checkout and re-scans plugin definitions (refreshPlugins),
 *   2. rebuilds the cached agent registry so webhook dispatch and agent lookups
 *      see new/changed agents, and
 *   3. clones the base repo for any repo agent that was just added.
 *
 * Note: an in-flight task keeps the team it was created with — its live agent
 * processes are not restarted. New tasks, and tasks reloaded from disk after
 * being stopped/completed (or after a process restart), pick up the updated
 * agents on their next start.
 */
export async function syncPlugins(): Promise<void> {
  const changed = await refreshPlugins();
  if (!changed) return;

  // Rebuild the cached registry so getAllAgentDefs()/getAgentDefByGithubRepo()
  // and other lookups reflect the freshly-scanned plugins.
  initRegistry();

  // Bring up the base repo for any newly-added repo agent. Existing repos are
  // skipped (no fetch/reset), so this is a no-op once everything is cloned.
  const repoDefs = getAllAgentDefs().filter((d) => d.track === 'repo');
  try {
    await cloneMissingRepos(
      repoDefs.map((d) => ({
        key: d.repo!.repoKey,
        githubRepo: d.repo!.githubRepo,
        baseBranch: d.repo!.baseBranch,
      })),
    );
  } catch (error) {
    logger.warn('system', `Failed to clone newly-added repos: ${error}`);
  }
}
