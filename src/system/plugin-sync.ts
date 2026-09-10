/**
 * Plugin Sync
 *
 * Single entry point for keeping the running process in step with the plugins
 * repo. Wraps {@link refreshPlugins} and, when the remote branch has moved (or
 * a local dev checkout was re-scanned), rebuilds the cached PM definition so a
 * changed root config is picked up.
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
 * plugins repo moved, this hard-resets the checkout and re-scans the plugin
 * directory list (refreshPlugins), then rebuilds the cached PM definition so
 * new MCP servers and root-config changes are visible.
 *
 * Note: an in-flight task keeps the session it was created with — its live
 * agent is not restarted, and the SDK read its plugin directories at spawn.
 * New tasks, and tasks reloaded from disk after being stopped/completed (or
 * after a process restart), load the updated plugins on their next start.
 *
 * Warming the base clone for a newly-declared repo is handled elsewhere
 * (`mount_repo` clones on demand), so it is intentionally not done here.
 */
export async function syncPlugins(): Promise<void> {
  const changed = await refreshPlugins();
  if (!changed) return;

  // Rebuild the cached PM definition so the next spawn sees the freshly-scanned
  // plugin directories and root config.
  initRegistry();
}
