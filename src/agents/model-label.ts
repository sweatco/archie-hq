/**
 * Model resolution + human-friendly labels for the message footer.
 *
 * The app passes short aliases (`opus`, `sonnet`, `haiku`) to the Claude Agent
 * SDK, optionally suffixed with `[1m]` to enable the 1M context window (the SDK
 * strips the suffix and adds the `context-1m` beta — see `spawn.ts`). For the
 * footer we beautify these into names like `Opus 4.8` / `Sonnet 4.6 (1M)`:
 * the `claude-` provider prefix is dropped, the family is capitalised, the
 * version is dotted, and the 1M marker is shown as `(1M)`.
 */

import type { AgentDef } from '../types/agent.js';
import { isPmAgent } from '../types/agent.js';

/** Beautified display names for the short aliases the app uses. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  opus: 'Opus 4.8',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
};

/**
 * Resolve the model string an agent actually runs on — mirrors the default in
 * `spawn.ts` (PM → opus, others → sonnet[1m]) so the footer and the spawn loop
 * never drift. Exported and reused by `spawn.ts`.
 */
export function resolveAgentModel(def: AgentDef): string {
  return def.model || (isPmAgent(def) ? 'opus' : 'sonnet[1m]');
}

/** Beautify a full/unknown model id: `claude-sonnet-4-6-2025… → Sonnet 4.6`. */
function beautify(model: string): string {
  const stripped = model.replace(/^(anthropic\/)?claude-/, '');
  if (stripped === model) return model; // not a claude id and not a known alias → leave as-is
  const parts = stripped.split('-');
  const family = parts[0];
  const version: string[] = [];
  for (let i = 1; i < parts.length && version.length < 2; i++) {
    if (/^\d+$/.test(parts[i])) version.push(parts[i]);
    else break;
  }
  const familyCap = family ? family.charAt(0).toUpperCase() + family.slice(1) : family;
  return version.length ? `${familyCap} ${version.join('.')}` : familyCap;
}

/**
 * Beautified label for a single model string, preserving the 1M-context marker
 * as `(1M)`. Examples: `opus → Opus 4.8`, `sonnet[1m] → Sonnet 4.6 (1M)`,
 * `claude-opus-4-8 → Opus 4.8`. Unknown non-Claude ids pass through unchanged.
 */
export function modelDisplayLabel(model: string): string {
  const trimmed = (model || '').trim();
  const match = /^(.*?)\s*(\[1m\])$/i.exec(trimmed);
  const base = match ? match[1] : trimmed;
  const oneM = !!match;
  const display = MODEL_DISPLAY_NAMES[base.toLowerCase()] ?? beautify(base);
  return oneM ? `${display} (1M)` : display;
}
