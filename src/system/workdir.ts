/** Runtime paths stay independent of startup and plugin synchronization. */

import { join } from 'path';
import { existsSync } from 'fs';

/** Base working directory. Everything lives under here. */
export const WORKDIR = process.env.ARCHIE_WORKDIR || join(process.cwd(), 'workdir');

/** Plugins directory (cloned from ARCHIE_PLUGINS git URL) */
export const PLUGINS_DIR = join(WORKDIR, 'plugins');

/** Base repos directory (warm-cloned at startup per archie.json, else on demand) */
export const REPOS_DIR = join(WORKDIR, 'repos');

/** Sessions directory (task runtime data) */
export const SESSIONS_DIR = join(WORKDIR, 'sessions');

/** Triggers directory (one JSON file per persistent trigger) */
export const TRIGGERS_DIR = join(WORKDIR, 'triggers');

/** Persistent per-trigger data directory (one subdirectory per trigger, outlives a single fire) */
export const TRIGGERS_DATA_DIR = join(WORKDIR, 'triggers-data');

/**
 * Shared package-manager caches (npm, yarn, Corepack), written by every agent.
 *
 * Deliberately outside `SESSIONS_DIR`: cache content is a function of the
 * lockfiles being installed, not of the task installing them, so scoping it per
 * task means every task re-downloads the same bytes and keeps its own copy
 * forever. That is what it did until this directory existed — 697 per-task
 * caches holding ~285 GB, two thirds of it a single `_npx` tree.
 *
 * See `buildPackageManagerCacheEnv` for why sharing is safe (and the one place
 * it isn't).
 */
export const CACHES_DIR = join(WORKDIR, 'caches');

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

/**
 * Base-cache path for a github repo on disk. Computed, not stored.
 */
export function getBaseCachePath(github: string): string {
  return join(REPOS_DIR, github);
}
