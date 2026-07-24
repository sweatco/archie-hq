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
import { isPmAgent, isRepoAgent } from '../types/agent.js';

/**
 * Resolve the model string an agent actually runs on — mirrors the default in
 * `spawn.ts` (PM → opus, others → sonnet[1m]) so the footer and the spawn loop
 * never drift. Exported and reused by `spawn.ts`.
 *
 * When `maxMode` is true (the task has an approved upgrade), an explicit
 * per-agent `maxMode.model` override wins. There is NO built-in model default:
 * an agent with no `maxMode.model` keeps its normal model even in max mode —
 * the built-in "increase accuracy" default is effort-only (see
 * `resolveAgentEffort`), so a model swap (e.g. to Fable) is always an explicit
 * frontmatter opt-in.
 */
export function resolveAgentModel(def: AgentDef, maxMode = false): string {
  if (maxMode) {
    // 1) explicit per-agent frontmatter opt-in wins, for ANY agent (e.g. repo
    //    agents → Fable).
    if (def.maxMode?.model) return def.maxMode.model;
    // 2) env fallback for REPO / DYNAMIC-REPO agents only — notably dynamic
    //    agents (synthesized at runtime, so no frontmatter to edit). Generic
    //    plugin agents and the PM are unaffected. Lets a deployment turn on a
    //    model swap for these via ARCHIE_MAX_MODE_MODEL without editing plugins.
    if (isRepoAgent(def)) {
      const envModel = process.env.ARCHIE_MAX_MODE_MODEL?.trim();
      if (envModel) return envModel;
    }
  }
  return def.model || (isPmAgent(def) ? 'opus' : 'sonnet[1m]');
}

/**
 * Resolve the reasoning effort an agent runs at. In max mode an explicit
 * `maxMode.effort` wins; otherwise repo/dynamic agents default to `'max'` (the
 * "increase accuracy" default) while generic agents and the PM keep their
 * normal effort. Off max mode this is just `def.effort` (may be undefined → the
 * SDK default). Shared with `spawn.ts`.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function resolveAgentEffort(def: AgentDef, maxMode = false): AgentDef['effort'] {
  if (maxMode) {
    // 1) explicit per-agent frontmatter opt-in wins, for ANY agent.
    if (def.maxMode?.effort) return def.maxMode.effort;
    // 2) REPO / DYNAMIC-REPO agents only: an env override (ARCHIE_MAX_MODE_EFFORT,
    //    handy for dynamic agents with no frontmatter), else the built-in
    //    "increase accuracy" default of max effort. Generic plugin agents and
    //    the PM keep their normal effort in max mode.
    if (isRepoAgent(def)) {
      const envEffort = process.env.ARCHIE_MAX_MODE_EFFORT?.trim();
      if (envEffort && (EFFORT_LEVELS as readonly string[]).includes(envEffort)) {
        return envEffort as AgentDef['effort'];
      }
      return 'max';
    }
  }
  return def.effort;
}

/**
 * The ids of the non-PM agents whose resolved MODEL changes when max mode turns
 * on — i.e. the agents that must start a fresh SDK session on approval so the
 * swap actually takes effect (a resumed session can pin the old model). Sourced
 * from the task TEAM (which survives a task reload), not from live agent
 * handles: `request_max_mode` pauses/evicts the task, so on the reloaded
 * instance that handles the approval there are no live handles yet. Effort-only
 * upgrades don't change the model, so they're absent here (no reset needed).
 */
export function modelChangingAgentIds(team: AgentDef[]): string[] {
  return team
    .filter((def) => !isPmAgent(def) && resolveAgentModel(def, true) !== resolveAgentModel(def, false))
    .map((def) => def.id);
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
