import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerMcpArgv, type RunnerMcpRequest } from '../mcp.js';

const exec = promisify(execFile);
let repo: string;
const serverScript = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';
writeFileSync('server.pid', String(process.pid));
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === 'hang') await new Promise(() => {});
  if (params.name === 'image') return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') }] };
  return { isError: params.name === 'error', content: [{ type: 'text', text: params.name === 'large' ? 'x'.repeat(100000) : JSON.stringify({ args: params.arguments, guest: process.env.FROM_GUEST, inherited: process.env.HOST_SECRET }) }] };
});
await server.connect(new StdioServerTransport());
`;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'archie-mcp-'));
  await symlink(resolve('node_modules'), join(repo, 'node_modules'));
  await writeFile(join(repo, 'server.mjs'), serverScript);
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: {
    fixture: { type: 'stdio', command: process.execPath, args: ['server.mjs'], env: { FROM_GUEST: '${GUEST_VALUE}' } },
    remote: { type: 'http', url: 'https://example.invalid/mcp' },
  } }));
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

async function invoke(request: Partial<RunnerMcpRequest> = {}, env: NodeJS.ProcessEnv = {}) {
  const id = randomUUID();
  const [file, ...args] = runnerMcpArgv(id, { server: 'fixture', ...request });
  const { stdout } = await exec(file!, args, {
    cwd: repo, timeout: 10_000,
    env: { ...process.env, GUEST_VALUE: 'guest-only', HOST_SECRET: 'must-not-reach-server', ...env },
  });
  return JSON.parse(stdout);
}

describe('runner MCP guest client', () => {
  it('initializes and lists real stdio MCP tools', async () => {
    const result = await invoke();
    expect(result.result.server).toEqual({ name: 'fixture', version: '1' });
    expect(result.result.tools.map((t: { name: string }) => t.name)).toEqual(['echo']);
    expect(JSON.parse(await readFile(join(repo, result.result_path), 'utf8'))).toEqual(result.result);
  });

  it('passes JSON arguments literally and expands only declared guest environment', async () => {
    const args = { text: '`touch should-not-exist` $(touch should-not-exist)', nested: { value: 7 } };
    const result = await invoke({ tool: 'echo', arguments: args });
    expect(JSON.parse(result.result.content[0].text)).toEqual({ args, guest: 'guest-only' });
    await expect(readFile(join(repo, 'should-not-exist'))).rejects.toThrow();
  });

  it('rejects undeclared and HTTP servers before starting a process', async () => {
    await expect(invoke({ server: 'unknown' })).rejects.toThrow(/not declared/);
    await expect(invoke({ server: 'remote' })).rejects.toThrow(/stdio servers only/);
    await expect(readFile(join(repo, 'server.pid'))).rejects.toThrow();
  });

  it('fails before launch if an environment placeholder is unresolved', async () => {
    await expect(invoke({}, { GUEST_VALUE: undefined })).rejects.toThrow(/Missing guest environment variable: GUEST_VALUE/);
    await expect(readFile(join(repo, 'server.pid'))).rejects.toThrow();
  });

  it('preserves MCP errors and saves oversized results without flooding command output', async () => {
    expect((await invoke({ tool: 'error' })).isError).toBe(true);
    const large = await invoke({ tool: 'large' });
    expect(large.result).toBeUndefined();
    expect(large.result_bytes).toBeGreaterThan(100000);
    const full = JSON.parse(await readFile(join(repo, large.result_path), 'utf8'));
    expect(full.content[0].text).toHaveLength(100000);
  });

  it('times out a stalled tool and closes its MCP process', async () => {
    await expect(invoke({ tool: 'hang', timeout_seconds: 1 })).rejects.toThrow();
    const pid = Number(await readFile(join(repo, 'server.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('saves image bytes for collection and keeps the original MCP response', async () => {
    const response = await invoke({ tool: 'image' });
    const imagePath = response.result_path.replace(/\.json$/, '-0.png');
    expect(await readFile(join(repo, imagePath), 'utf8')).toBe('image-bytes');
    expect(response.result.content[0].text).toContain(imagePath);
    const original = JSON.parse(await readFile(join(repo, response.result_path), 'utf8'));
    expect(original.content[0].type).toBe('image');
  });
});
