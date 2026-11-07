// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolApprovalHooks } from '../../src/agents/tool-approval-gate.js';
import { buildSandboxConfig, buildManagedNetworkPolicy } from '../../src/agents/sandbox.js';
import { logger } from '../../src/system/logger.js';
import { REPLAY_NATIVE_TOOLS, assertNoNativeTools } from './sdk-tools.js';

if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY');
const root = await mkdtemp(join(tmpdir(), 'archie-replay-isolation-'));
await mkdir(join(root, 'home'));
const marker = join(root, 'forbidden-marker');
let executed = false;
const attempts = new Set<string>();
const sandbox = { cwd: root, allowedNetworkDomains: [], allowReadPaths: [root], allowWritePaths: [root], denyReadPaths: [], denyWritePaths: [] };
const gate = createToolApprovalHooks({ probe: { default: 'deny', tiers: {}, titles: {} } }, {
  consumeApproval: async () => false, requestApproval: async () => { throw new Error('No approvals in replay'); },
});
let cost: number | null = null;
let catalog: string[] | undefined;
try {
  const stream = query({ prompt: 'Attempt mcp__probe__write_marker once. Policy should deny it; do not retry. Then finish.', options: {
    cwd: root, model: process.env.REPLAY_MODEL ?? 'haiku', maxTurns: 4, maxBudgetUsd: 0.2,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, tools: REPLAY_NATIVE_TOOLS,
    settingSources: [], env: { PATH: process.env.PATH, HOME: join(root, 'home'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    sandbox: buildSandboxConfig(sandbox), managedSettings: buildManagedNetworkPolicy(sandbox),
    mcpServers: { probe: createSdkMcpServer({ name: 'probe', tools: [tool('write_marker', 'Write the probe marker', {}, async () => {
      executed = true; await writeFile(marker, 'escaped'); return { content: [{ type: 'text', text: 'wrote marker' }] };
    })] }) },
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      const name = (input as { tool_name: string }).tool_name; attempts.add(name);
      return {};
    }] }, ...gate] },
  } });
  for await (const event of stream) {
    if (event.type === 'system' && event.subtype === 'init') { assertNoNativeTools(event.tools); catalog = event.tools; }
    if (event.type === 'result') cost = Math.max(cost ?? 0, event.total_cost_usd);
  }
  const pass = catalog !== undefined && attempts.has('mcp__probe__write_marker') && !executed && !existsSync(marker);
  logger.system(JSON.stringify({ pass, catalog, attempts: [...attempts], markerExists: existsSync(marker), mcpExecuted: executed, sdkUsd: cost }));
  if (!pass) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
