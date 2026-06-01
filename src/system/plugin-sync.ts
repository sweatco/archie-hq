/**
 * Plugin Sync
 *
 * Single entry point for keeping the running process in step with the plugins
 * repo. Wraps {@link refreshPlugins} and, when the remote branch has moved (or
 * a local dev checkout was re-scanned), rebuilds the cached agent registry so
 * new/changed agents are visible.
 *
 * Lives in its own module (rather than inside workdir.ts) to avoid an import
 * cycle: workdir.ts → plugin-loader.ts and registry.ts → workdir.ts, so the
 * orchestration that needs both must sit above them.
 */

import { refreshPlugins } from './workdir.js';
import { initRegistry } from '../agents/registry.js';

/**
 * Pick up plugin repo changes for the current request.
 *
 * Cheap when nothing changed (one `git ls-remote` and a SHA compare). When the
 * plugins repo moved, this hard-resets the checkout and re-scans plugin
 * definitions (refreshPlugins), then rebuilds the cached agent registry so
 * webhook dispatch and agent lookups see new/changed agents.
 *
 * Note: an in-flight task keeps the team it was created with — its live agent
 * processes are not restarted. New tasks, and tasks reloaded from disk after
 * being stopped/completed (or after a process restart), pick up the updated
 * agents on their next start.
 *
 * Bringing up the base repo for a newly-added repo agent is handled elsewhere
 * (repos are cloned on demand at spawn time), so it is intentionally not done
 * here.
 */
export async function syncPlugins(): Promise<void> {
  const changed = await refreshPlugins();
  if (!changed) return;

  // Rebuild the cached registry so getAllAgentDefs()/getAgentDefByGithubRepo()
  // and other lookups reflect the freshly-scanned plugins.
  initRegistry();
}
