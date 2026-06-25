/**
 * Branding / presentation config sourced from the plugins repo, so the
 * open-source engine holds no deployer-specific (e.g. Sweatcoin) content.
 *
 * The engine provides only the MECHANISM and a safe, empty default; the actual
 * branded values live in `<PLUGINS_DIR>/branding.json` in the plugins repo and
 * hot-reload with it — changing them needs a plugins change, not an engine
 * redeploy. This mirrors the `.mcp.json` seam: a known JSON file at the plugins
 * root that the engine reads on demand.
 *
 * Schema (all keys optional):
 *   { "statusLoadingMessages": string[] }   // ≤10 rotating Slack loading phrases
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PLUGINS_DIR } from './workdir.js';
import { logger } from './logger.js';

/** Slack caps the rotating loading_messages array at 10 entries. */
const MAX_LOADING_MESSAGES = 10;

/**
 * Re-read window. The file is tiny, but the status indicator is pushed often, so
 * the parsed result is memoised briefly rather than read on every push. The TTL
 * also bounds how long a plugins edit takes to surface after a plugins pull.
 */
const CACHE_TTL_MS = 30_000;

interface BrandingConfig {
  statusLoadingMessages?: unknown;
}

let cache: { at: number; messages: string[] } | undefined;

/**
 * Branded rotating loading phrases for the Slack assistant status indicator,
 * read from the plugins branding config. Returns `[]` when the file or key is
 * absent, empty, or invalid — the engine ships no branded phrases of its own.
 * Non-string / blank entries are dropped and the list is capped at Slack's limit.
 */
export function getStatusLoadingMessages(): string[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.messages;
  const messages = readStatusLoadingMessages();
  cache = { at: now, messages };
  return messages;
}

function readStatusLoadingMessages(): string[] {
  // PLUGINS_DIR is resolved lazily, inside the function — not captured at module
  // load — mirroring readMcpServerUrl(). Capturing it at import time breaks tests
  // that partially mock ./workdir.js without re-exporting PLUGINS_DIR.
  const path = join(PLUGINS_DIR, 'branding.json');
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BrandingConfig;
    const raw = parsed.statusLoadingMessages;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      .slice(0, MAX_LOADING_MESSAGES);
  } catch (err) {
    logger.warn('branding', `failed to read ${path}: ${err}`);
    return [];
  }
}
