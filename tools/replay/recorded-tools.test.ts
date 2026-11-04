// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { recordedTools } from './recorded-tools.js';
import { Cassette } from './cassette.js';

it.each([false, true])('serves recorded MCP mutations only for exact arguments (extra key: %s)', async (extra) => {
  const recording = { name: 'mcp__fixture__update', input: { page: 'private-page' }, output: { content: [{ type: 'text' as const, text: 'SIMULATED_UPDATE_ONLY' }], isError: false } };
  const cassette = new Cassette([{ at: '2026-10-20T10:00:00Z', sender: 'user', message: 'update', tools: [recording] }]);
  cassette.next();
  const servers = recordedTools([{ name: recording.name, keys: ['page'] }], async (name, input) => cassette.call(name, input));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'replay-test', version: '1' });
  try {
    await servers.fixture.instance.connect(serverTransport); await client.connect(clientTransport);
    const catalog = await client.listTools();
    expect(JSON.stringify(catalog)).not.toContain('private-page');
    expect(JSON.stringify(catalog)).not.toContain('SIMULATED_UPDATE_ONLY');
    const output = await client.callTool({ name: 'update', arguments: { ...recording.input, ...(extra ? { unexpected: 'extra' } : {}) } });
    expect(output).toMatchObject(extra ? { isError: true } : recording.output);
    if (extra) expect(JSON.stringify(output)).not.toContain('SIMULATED_UPDATE_ONLY');
    cassette.next(); expect(cassette.summary()).toMatchObject({ complete: !extra, consumed: extra ? 0 : 1, errors: extra ? ['tool-arguments-divergence', 'unconsumed-recordings'] : [] });
  } finally { await client.close(); await servers.fixture.instance.close(); }
  expect(() => recordedTools([{ name: 'mcp__comms-tools__read_thread', keys: [] }], async () => ({}))).toThrow('Unsupported');
});
