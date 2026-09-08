// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Real SDK + stdio MCP tripwire for group access under bypassPermissions.
 * Usage: npx tsx tools/e2e/tool-access-check.ts
 * Requires Claude authentication (or ANTHROPIC_API_KEY). No Slack messages or
 * external mutations: all side effects are markers in a temporary directory.
 * The grant is deterministic here; real Slack membership/transport behavior has
 * separate integration tests. Run after SDK upgrades and authorization edits.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createToolApprovalHooks, type McpServerPolicy } from '../../src/agents/tool-approval-gate.js';
import { logger } from '../../src/system/logger.js';

export async function checkToolAccess(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'archie-tool-access-'));
  const marker = join(dir, 'marker.log');
  const server = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/plugins/gatecheck/server.mjs');
  try {
    let granted = false;
    let checked = 0;
    let requested = 0;
    const policy: McpServerPolicy = { default: 'ask', tiers: {}, titles: {}, access: { default: { approverGroups: ['S1'] } } };
    const hooks = createToolApprovalHooks({ gatecheck: policy }, {
      authorize: async () => {
        checked++;
        return { taskId: 'probe', revision: 'probe', rule: { approverGroups: ['S1'] } };
      },
      consumeApproval: () => {
        const approved = granted;
        granted = false;
        return approved;
      },
      requestApproval: async () => { requested++; return 'posted'; },
    });
    for (const phase of ['pending', 'approved', 'spent']) {
      if (phase === 'approved') granted = true;
      const before = checked;
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 90_000);
      try {
        for await (const message of query({
          prompt: `Call mcp__gatecheck__write_marker exactly once with value="approved". If refused, stop.`,
          options: {
            model: 'haiku', cwd: dir, settingSources: [], tools: [], maxTurns: 4,
            permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
            abortController,
            mcpServers: { gatecheck: { command: process.execPath, args: [server], env: { GATECHECK_MARKER_FILE: marker } } },
            hooks: { PreToolUse: hooks },
          },
        })) {
          if (message.type === 'result' && message.is_error) throw new Error(`SDK run failed: ${message.subtype}`);
        }
      } finally { clearTimeout(timer); }
      if (checked - before !== 1) throw new Error(`Expected exactly one intercepted call, observed ${checked - before}.`);
      const lines = await readFile(marker, 'utf8').catch(() => '');
      if (lines !== (phase === 'pending' ? '' : 'approved\n')) throw new Error(`Unexpected marker output for phase=${phase}.`);
      logger.system(`PASS: ${phase} (bypassPermissions)`);
    }
    if (requested !== 2) throw new Error(`Expected two approval requests, observed ${requested}.`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkToolAccess().catch((error: unknown) => { logger.error('tool-access-check', 'SDK tripwire failed', error); process.exitCode = 1; });
}
