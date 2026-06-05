/**
 * Tool Budgets
 *
 * Generic, declarative per-task metering for expensive tools. Marking a tool as
 * metered is a single entry in `METERED_TOOLS` — no changes to the tool itself.
 *
 * Enforcement is host-side via a `PreToolUse` hook (`createBudgetGuardHook`):
 * before a metered tool runs, the hook checks the task's per-resource counter.
 * If under budget it consumes one unit and allows the call; if exhausted it
 * denies the call and triggers the task's approval flow (Slack buttons),
 * pausing the task until the user grants more.
 *
 * Because metering lives in the host (not the tool), it works for any tool by
 * name — in-process or external MCP servers, SDK built-ins, anything — without
 * the tool's cooperation.
 */

import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Task } from '../tasks/task.js';

export interface BudgetPolicy {
  /** Logical resource key, persisted per-task (e.g. 'web-research'). */
  resource: string;
  /** Base per-task limit before any approvals. */
  limit: number;
  /** Units granted each time the user approves more. */
  grant: number;
  /** Human label used in approval messages. */
  label: string;
}

/**
 * Metered tools, keyed by SDK tool name (`mcp__<server>__<tool>` or a built-in
 * tool name). Add an entry here to put any tool under budget.
 */
export const METERED_TOOLS: Record<string, BudgetPolicy> = {
  'mcp__research-tools__web_research': {
    resource: 'web-research',
    limit: 5,
    grant: 5,
    label: 'Research',
  },
};

/** Look up a policy by its resource key (used by the approval handlers). */
export function policyForResource(resource: string): BudgetPolicy | null {
  for (const policy of Object.values(METERED_TOOLS)) {
    if (policy.resource === resource) return policy;
  }
  return null;
}

/**
 * PreToolUse hook that meters and gates every tool listed in `METERED_TOOLS`.
 * Non-metered tools pass through untouched.
 */
export function createBudgetGuardHook(task: Task): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const { tool_name } = input as { tool_name: string };
        const policy = METERED_TOOLS[tool_name];
        if (!policy) return { continue: true } as HookJSONOutput;

        const status = task.checkBudget(policy);
        if (!status.allowed) {
          // Pause the task and ask the user to approve more (fire-and-forget so
          // the hook returns its deny decision promptly).
          await task.onBudgetExceeded(policy);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason:
                `${policy.label} budget reached (${status.used}/${status.limit}). ` +
                `Paused — awaiting user approval for more.`,
            },
          } as HookJSONOutput;
        }

        task.consumeBudget(policy.resource);
        return { continue: true } as HookJSONOutput;
      },
    ],
  };
}
