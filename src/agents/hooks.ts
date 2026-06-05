/**
 * Agent hooks
 *
 * A lightweight way for a self-contained tool module (e.g. web-research) to
 * hand spawn its hooks (keyed by event) instead of spawn wiring each hook
 * separately. MCP servers are still passed separately.
 *
 * This is NOT a plugin framework: no loader, discovery, or manifest. A tool
 * module exports `(ctx) => Hooks | null` and spawn imports it directly and
 * merges it onto the core hooks via `mergeHooks`.
 */

import type { HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

/** Hooks keyed by SDK hook event — same shape as the SDK's `options.hooks`. */
export type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** Per-spawn context handed to a tool's hooks. */
export interface ToolContext {
  taskId: string;
  agentId: string;
  /** Absolute path to the task directory (`sessions/{task-id}`). */
  getTaskDir: () => string;
  /** Absolute path to the task's shared directory (`sessions/{task-id}/shared`). */
  getSharedDir: () => string;
}

/** Merge hook sets (skipping nulls) into one, appending per event. */
export function mergeHooks(...sets: Array<Hooks | null | undefined>): Hooks {
  const merged: Hooks = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [event, matchers] of Object.entries(set)) {
      if (!matchers?.length) continue;
      (merged[event as HookEvent] ??= []).push(...matchers);
    }
  }
  return merged;
}
