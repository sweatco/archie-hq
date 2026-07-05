/**
 * QA driver: call one archie-debug MCP tool over stdio and print the text result.
 * Usage: node call-debug-tool.mjs <tool-name> '<json-arguments>'
 * The archie-debug server is spawned exactly as registered in .mcp.json
 * (npx tsx tools/debug-mcp/server.ts) with cwd = repo root.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node call-debug-tool.mjs <tool-name> [json-args]');
  process.exit(2);
}
const args = argsJson ? JSON.parse(argsJson) : {};

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'tools/debug-mcp/server.ts'],
  cwd: new URL('../../../../..', import.meta.url).pathname, // repo root
  stderr: 'inherit',
});
const client = new Client({ name: 'qa-ac7-driver', version: '1.0.0' });
await client.connect(transport);
try {
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 });
  for (const c of res.content ?? []) if (c.type === 'text') console.log(c.text);
  if (res.isError) process.exitCode = 1;
} finally {
  await client.close();
}
