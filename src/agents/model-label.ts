/**
 * Model resolution + human-friendly labels for the message footer.
 *
 * The label is **derived** from the model string — there is no per-version
 * lookup table to keep in sync. `modelDisplayLabel` parses any Claude model id
 * generically (`claude-opus-5 → Opus 5`, `claude-sonnet-4-6-20250929 →
 * Sonnet 4.6`), so a brand-new model renders correctly with no code change.
 *
 * Two shapes reach this function:
 *  - a resolved concrete id (`claude-opus-5`) — parsed to family + version;
 *  - a bare alias (`opus`, `sonnet`, `haiku`) — the version lives inside the
 *    SDK's alias table, not in the string, so we can only render the family
 *    (`Opus`). The footer prefers the concrete model the SDK actually resolved
 *    (captured at the agent's `init` event — see `Task.recordResolvedModel` /
 *    `collectModelsUsed`), falling back to the bare alias before that arrives.
 *
 * A trailing `[1m]` marker (our 1M-context suffix — the SDK strips it and adds
 * the `context-1m` beta, see `spawn.ts`) is rendered as `(1M)`.
 */

import type { AgentDef } from '../types/agent.js';
import { isPmAgent } from '../types/agent.js';

/**
 * Resolve the model string an agent actually runs on — mirrors the default in
 * `spawn.ts` (PM → opus, others → sonnet[1m]) so the footer and the spawn loop
 * never drift. Exported and reused by `spawn.ts`.
 *
 * When `maxMode` is true (the task has an approved upgrade), the agent's
 * explicit `maxMode.model` wins; the PM's comes from the engine constants in
 * `registry.ts` (`ARCHIE_PM_MAX_MODEL`). An agent with no `maxMode.model` keeps
 * its normal model even in max mode.
 */
export function resolveAgentModel(def: AgentDef, maxMode = false): string {
  if (maxMode && def.maxMode?.model) return def.maxMode.model;
  return def.model || (isPmAgent(def) ? 'opus' : 'sonnet[1m]');
}

/**
 * Resolve the reasoning effort an agent runs at. In max mode an explicit
 * `maxMode.effort` wins (the PM's comes from `ARCHIE_PM_MAX_EFFORT` via the
 * registry constants); otherwise, and off max mode, this is just `def.effort`
 * (may be undefined → the SDK default). Shared with `spawn.ts`.
 */
export function resolveAgentEffort(def: AgentDef, maxMode = false): AgentDef['effort'] {
  if (maxMode && def.maxMode?.effort) return def.maxMode.effort;
  return def.effort;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Derive a display name from a model id or alias — no per-version table.
 *  - Concrete Claude id (`claude-`/`anthropic/claude-` prefix): drop the
 *    prefix, capitalise the family, join up to two leading numeric segments
 *    with a dot, drop any date/suffix. `claude-sonnet-4-6-20250929 → Sonnet 4.6`.
 *  - Bare family alias (a lone lowercase word like `opus`): capitalise it. The
 *    version isn't in the string (it lives in the SDK's alias table), so the
 *    family is all we can show — the footer prefers the resolved concrete id
 *    for the versioned label.
 *  - Anything else (unknown non-Claude id): pass through unchanged.
 */
function beautify(model: string): string {
  const stripped = model.replace(/^(anthropic\/)?claude-/, '');
  if (stripped === model) {
    // No Claude prefix. A lone lowercase word is a family alias (opus/sonnet/…);
    // capitalise it. Anything else (hyphenated / mixed-case) is unknown → as-is.
    return /^[a-z]+$/.test(model) ? cap(model) : model;
  }
  const parts = stripped.split('-');
  const family = parts[0];
  // Malformed id with no family (e.g. a bare `claude-`) → an empty label would
  // render a dangling ` + ` separator in the footer. Fall back to the raw id.
  if (!family) return model;
  const version: string[] = [];
  for (let i = 1; i < parts.length && version.length < 2; i++) {
    if (/^\d+$/.test(parts[i])) version.push(parts[i]);
    else break;
  }
  const familyCap = cap(family);
  return version.length ? `${familyCap} ${version.join('.')}` : familyCap;
}

/**
 * Beautified label for a single model string, preserving the 1M-context marker
 * as `(1M)`. Examples: `claude-opus-5 → Opus 5`, `claude-sonnet-5[1m] →
 * Sonnet 5 (1M)`, `claude-opus-4-8 → Opus 4.8`, `opus → Opus` (bare alias, no
 * version). Unknown non-Claude ids pass through unchanged.
 */
export function modelDisplayLabel(model: string): string {
  const trimmed = (model || '').trim();
  const match = /^(.*?)\s*(\[1m\])$/i.exec(trimmed);
  const base = match ? match[1] : trimmed;
  const oneM = !!match;
  const display = beautify(base);
  return oneM ? `${display} (1M)` : display;
}
