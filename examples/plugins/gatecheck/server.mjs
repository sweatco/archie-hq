#!/usr/bin/env node
/**
 * Stub MCP server for the tool-approval-gate e2e check.
 *
 * Speaks just enough MCP over stdio (initialize / tools/list / tools/call) to
 * serve two tools:
 *
 *   - get_status            read: reports how many markers have been written
 *   - write_marker {value}  mutation: appends `value` to the marker file
 *
 * The marker file is the check's observable side effect: it lives under the
 * bind-mounted workdir, so the host-side check script can assert that the
 * mutation did NOT run before approval and ran EXACTLY ONCE after it.
 * No dependencies on purpose — this runs wherever `node` runs.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MARKER_FILE = process.env.GATECHECK_MARKER_FILE || '/workdir/e2e/gate-marker.log';

function markerLines() {
  try {
    return readFileSync(MARKER_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const TOOLS = [
  {
    name: 'get_status',
    description: 'Read how many markers have been written so far. Safe read; changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_marker',
    description: 'Write a marker value to the shared marker file. This is a mutation.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'Marker value to record' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gatecheck', version: '1.0.0' },
      },
    };
  }
  if (method === 'tools/list') return { id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    if (name === 'get_status') {
      return { id, result: { content: [{ type: 'text', text: `status ok; markers written: ${markerLines().length}` }] } };
    }
    if (name === 'write_marker') {
      const value = String(args?.value ?? '');
      mkdirSync(dirname(MARKER_FILE), { recursive: true });
      appendFileSync(MARKER_FILE, `${value}\n`);
      return { id, result: { content: [{ type: 'text', text: `marker written: ${value}` }] } };
    }
    return { id, error: { code: -32601, message: `unknown tool: ${name}` } };
  }
  if (id === undefined) return undefined; // notification — no response
  return { id, error: { code: -32601, message: `unknown method: ${method}` } };
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const response = handle(msg);
    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...response })}\n`);
    }
  }
});
console.error(`gatecheck: stub MCP server on stdio, marker file ${MARKER_FILE}`);
