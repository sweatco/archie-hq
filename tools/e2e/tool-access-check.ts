// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Real SDK + stdio MCP tripwire for group access under bypassPermissions.
 * Usage: npx tsx tools/e2e/tool-access-check.ts
 * Requires Claude authentication (or ANTHROPIC_API_KEY). No Slack messages or
 * external mutations: all side effects are markers in a temporary directory.
 * Membership is deterministic here; real Slack lookup/transport behavior has
 * separate integration tests. Run after SDK upgrades and authorization edits.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createToolApprovalHooks, type McpServerPolicy } from '../../src/agents/tool-approval-gate.js';
import { ToolAccessDenied } from '../../src/agents/tool-access.js';
import { logger } from '../../src/system/logger.js';

export async function checkToolAccess(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'archie-tool-access-'));
  const marker = join(dir, 'marker.log');
  const server = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/plugins/gatecheck/server.mjs');
  try {
    for (const eligible of [false, true]) {
      let checked = 0;
      const policy: McpServerPolicy = { default: 'allow', tiers: {}, titles: {}, access: { default: { requesterGroups: ['S1'] } } };
      const hooks = createToolApprovalHooks({ gatecheck: policy }, {
        authorize: async () => {
          checked++;
          if (!eligible) throw new ToolAccessDenied('Requester is not a member of S1. Do not retry.');
          return { taskId: 'probe', revision: 'probe', rule: { requesterGroups: ['S1'] },
            requester: { teamId: 'T1', userId: 'U1', channelId: 'C1', messageTs: '1', requestId: 'probe' } };
        },
        consumeApproval: () => false,
        requestApproval: async () => { throw new Error('An allow-tier call must not ask for confirmation.'); },
      });
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 90_000);
      try {
        for await (const message of query({
          prompt: `Call mcp__gatecheck__write_marker exactly once with value="${eligible ? 'eligible' : 'ineligible'}". If refused, stop.`,
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
      if (checked !== 1) throw new Error(`Expected exactly one intercepted call, observed ${checked}.`);
      const lines = await readFile(marker, 'utf8').catch(() => '');
      if (lines !== (eligible ? 'eligible\n' : '')) throw new Error(`Unexpected marker output for eligible=${eligible}.`);
      logger.system(`PASS: ${eligible ? 'member executed once without extra confirmation' : 'nonmember denied before MCP execution'} (bypassPermissions)`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkToolAccess().catch((error: unknown) => { logger.error('tool-access-check', 'SDK tripwire failed', error); process.exitCode = 1; });
}
