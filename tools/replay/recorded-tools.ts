// SPDX-License-Identifier: AGPL-3.0-or-later
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const core = new Set(['comms-tools', 'orchestration-tools', 'repo-tools', 'scheduling-tools', 'research-tools', 'file-bridge', 'memory-tools', 'observation-tools']);
export function recordedTools(catalog: { name: string; keys: string[] }[], call: (name: string, input: unknown) => Promise<any>) {
  const groups = new Map<string, ReturnType<typeof createSdkMcpServer>>();
  for (const entry of catalog) {
    const match = /^mcp__([\w-]+)__([\w-]+)$/.exec(entry.name);
    if (!match || core.has(match[1])) throw new Error('Unsupported recorded server');
    const [, server, name] = match;
    const config = groups.get(server) ?? createSdkMcpServer({ name: server });
    // Preserve unknown keys so cassette comparison cannot silently accept stripped arguments.
    config.instance.registerTool(name, { description: `Recorded ${server} ${name} tool.`,
      inputSchema: z.object(Object.fromEntries(entry.keys.map((key) => [key, z.unknown().optional()]))).passthrough() }, (input) => call(entry.name, input));
    groups.set(server, config);
  }
  return Object.fromEntries(groups);
}
