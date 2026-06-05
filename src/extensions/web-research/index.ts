/**
 * web-research — self-contained tool module.
 *
 * - `createResearchMcpServer()` — the pure MCP research server (passed to spawn
 *   as an MCP server, separately).
 * - `webResearchHooks(ctx)` — the module's host hooks (pre + post) as one set,
 *   or `null` when `PERPLEXITY_API_KEY` is unset (capability absent).
 *
 * Wired by a direct import in `src/agents/spawn.ts`. No loader/manifest/discovery.
 */

import { join } from 'node:path';
import type { ToolContext, Hooks } from '../../agents/hooks.js';
import { createResearchPreToolHook, createResearchPostToolHook } from './hook.js';

export { createResearchMcpServer } from './research-tools.js';

export function webResearchHooks(ctx: ToolContext): Hooks | null {
  if (!process.env.PERPLEXITY_API_KEY) return null;

  const getResearchesDir = () => join(ctx.getTaskDir(), 'researches');
  const ids = { getTaskId: () => ctx.taskId, getAgentId: () => ctx.agentId };

  return {
    PreToolUse: [createResearchPreToolHook({ getResearchesDir, ...ids })],
    PostToolUse: [createResearchPostToolHook({ getResearchesDir, getSharedDir: ctx.getSharedDir, ...ids })],
  };
}
