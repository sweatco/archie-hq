/**
 * Model resolution + human-friendly labels for the message footer.
 *
 * The app passes short aliases (`opus`, `sonnet`, `haiku`) to the Claude Agent
 * SDK, optionally suffixed with `[1m]` to enable the 1M context window (the SDK
 * strips the suffix and adds the `context-1m` beta — see `spawn.ts`). For the
 * footer we beautify these into names like `Opus 4.8` / `Sonnet 5 (1M)`:
 * the `claude-` provider prefix is dropped, the family is capitalised, the
 * version is dotted, and the 1M marker is shown as `(1M)`.
 */

import type { AgentDef } from '../types/agent.js';
import { isPmAgent, isRepoAgent } from '../types/agent.js';

/** Beautified display names for the short aliases the app uses. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  opus: 'Opus 4.8',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

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
 * as `(1M)`. Examples: `opus → Opus 4.8`, `sonnet[1m] → Sonnet 5 (1M)`,
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
