/**
 * Contract test for the `orders` stub MCP server in examples/plugins: eval cases
 * assert on these exact tools and values, so a change here must be a deliberate
 * change to the cases too.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'examples',
  'plugins',
  'orders',
  'server.mjs',
);

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

let server: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (message: Record<string, unknown>) => void>();

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await request('tools/call', { name, arguments: args });
  return response['result'] as ToolResult;
}

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER]);
  let buffer = '';
  server.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      pending.get(message['id'] as number)?.(message);
    }
  });
  await request('initialize', { protocolVersion: '2024-11-05' });
});

afterAll(() => {
  server.kill();
});

describe('orders stub MCP server', () => {
  it('lists the four contract tools, with the refund marked as a mutation', async () => {
    const response = await request('tools/list');
    const tools = (response['result'] as { tools: { name: string; annotations: unknown }[] }).tools;
    expect(tools.map((t) => [t.name, t.annotations])).toEqual([
      ['get_order', { readOnlyHint: true }],
      ['list_orders', { readOnlyHint: true }],
      ['get_shipping_status', { readOnlyHint: true }],
      ['refund_order', { readOnlyHint: false }],
    ]);
  });

  it('returns a canned order with its customer, case-insensitively', async () => {
    const result = await callTool('get_order', { order_id: 'fh-1001' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      order_id: 'FH-1001',
      customer_email: 'ada@fernhill.example',
      customer_name: 'Ada Byrne',
      status: 'delivered',
      total_usd: 84.5,
    });
  });

  it('answers an unknown order as a normal result, not an error', async () => {
    const result = await callTool('get_order', { order_id: 'FH-9999' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'No order with id FH-9999.' }] });
  });

  it('lists a customer’s orders newest first', async () => {
    const result = await callTool('list_orders', { customer_email: 'ada@fernhill.example' });
    expect(JSON.parse(result.content[0].text)).toEqual({
      customer: { email: 'ada@fernhill.example', name: 'Ada Byrne', since: '2024-03-11' },
      orders: [
        { order_id: 'FH-1004', placed_at: '2026-11-08', status: 'shipped', total_usd: 39 },
        { order_id: 'FH-1001', placed_at: '2026-10-02', status: 'delivered', total_usd: 84.5 },
      ],
    });
  });

  it('always fails the shipping lookup with the error flag set', async () => {
    const result = await callTool('get_shipping_status', { order_id: 'FH-1004' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'Carrier API error: request timed out after 30s (HTTP 504). No status available.',
    );
  });

  it('confirms a valid refund with a canned id and rejects one above the refundable amount', async () => {
    expect(
      await callTool('refund_order', { order_id: 'FH-1001', amount_usd: 20.5, reason: 'stakes' }),
    ).toEqual({
      content: [
        {
          type: 'text',
          text: 'Refund RF-FH-1001 queued: 20.50 USD to the original payment method for FH-1001.',
        },
      ],
    });
    const already = await callTool('refund_order', {
      order_id: 'FH-1003',
      amount_usd: 10,
      reason: 'x',
    });
    expect(already.isError).toBe(true);
    expect(already.content[0].text).toContain('refundable 0.00 USD');
  });
});
