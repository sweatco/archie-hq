export interface RunnerMcpRequest {
  server: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  timeout_seconds?: number;
}

// Runs entirely in the guest; resolve the MCP SDK and configuration from its repository.
const clientScript = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [requestId, raw] = process.argv.slice(1);
const request = JSON.parse(raw);
const configPath = resolve('.mcp.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert(Object.hasOwn(config.mcpServers ?? {}, request.server), 'MCP server is not declared in the guest repository');
const server = config.mcpServers[request.server];
assert(!server.url && (!server.type || server.type === 'stdio'), 'Runner MCP supports repository stdio servers only');
assert(typeof server.command === 'string' && server.command.length > 0, 'MCP command is missing');
assert(!server.args || (Array.isArray(server.args) && server.args.every(x => typeof x === 'string')), 'Invalid MCP arguments');
const env = {};
for (const [key, value] of Object.entries(server.env ?? {})) {
  assert(typeof value === 'string', 'MCP environment values must be strings');
  env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    assert(process.env[name] !== undefined, 'Missing guest environment variable: ' + name);
    return process.env[name];
  });
}
const require = createRequire(configPath);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const client = new Client({ name: 'archie-runner', version: '1.0.0' });
const transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd: process.cwd(), stderr: 'inherit', maxBufferSize: 16 * 1024 * 1024 });
const timeout = (request.timeout_seconds ?? 120) * 1000;
const options = { signal: AbortSignal.timeout(timeout), timeout };
const stop = async () => { await client.close(); process.exit(130); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await client.connect(transport, options);
  let result;
  if (request.tool) {
    result = await client.callTool({ name: request.tool, arguments: request.arguments ?? {} }, undefined, options);
  } else {
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, options);
      tools.push(...page.tools);
      assert(tools.length <= 2048, 'MCP tool catalog exceeds 2048 tools');
      cursor = page.nextCursor;
    } while (cursor);
    result = { server: client.getServerVersion(), instructions: client.getInstructions(), tools };
  }
  const json = JSON.stringify(result);
  assert(Buffer.byteLength(json) <= 16 * 1024 * 1024, 'MCP result exceeds 16 MiB');
  const path = '.archie-mcp/' + requestId + '.json';
  await mkdir('.archie-mcp', { recursive: true, mode: 0o700 });
  await writeFile(path, json + '\n', { flag: 'wx', mode: 0o600 });
  const preview = { ...result };
  if (Array.isArray(result.content)) preview.content = await Promise.all(result.content.map(async (block, index) => {
    if (block.type !== 'image') return block;
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[block.mimeType] ?? 'bin';
    const image = '.archie-mcp/' + requestId + '-' + index + '.' + extension;
    await writeFile(image, Buffer.from(block.data, 'base64'), { flag: 'wx', mode: 0o600 });
    return { type: 'text', text: 'Guest image: ' + image + ' (use runner_collect to view)' };
  }));
  process.stdout.write(JSON.stringify({ result_path: path, isError: result.isError ?? false, ...(Buffer.byteLength(JSON.stringify(preview)) <= 64 * 1024 ? { result: preview } : { result_bytes: Buffer.byteLength(json) }) }) + '\n');
} finally {
  await client.close();
}
`;

export function runnerMcpArgv(requestId: string, request: RunnerMcpRequest): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid MCP request id');
  if (!request.server || request.server.length > 128) throw new Error('MCP server name must contain 1–128 characters');
  if (request.timeout_seconds !== undefined && (!Number.isInteger(request.timeout_seconds) || request.timeout_seconds < 1 || request.timeout_seconds > 600)) throw new Error('MCP timeout must be 1–600 seconds');
  return ['/bin/bash', '-lc', 'exec node --input-type=module -e "$1" "$2" "$3"', 'archie-mcp', clientScript, requestId, JSON.stringify(request)];
}
