/**
 * MCP file bridge tests — send_file_to_mcp_tool.
 *
 * Verifies the guardrails (server must be one the agent has; streamable-http
 * only; every path must be sandbox-readable; size ceiling on the SUM of files;
 * no duplicate target arguments) and the happy path: each file's bytes are
 * base64-encoded by the tool and injected under its named argument (winning
 * collisions with plain arguments), the outbound client reuses the server's
 * resolved url + auth headers, and the target tool's response (incl. isError)
 * is surfaced verbatim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.callTool = mockCallTool;
    this.close = mockClose;
  }),
}));

const mockTransportCtor = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    mockTransportCtor(...args);
  }),
}));

const mockStat = vi.fn();
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  stat: (...a: unknown[]) => mockStat(...a),
  readFile: (...a: unknown[]) => mockReadFile(...a),
}));

const mockAssertReadable = vi.fn();
vi.mock('../artifacts.js', () => ({
  assertReadable: (...a: unknown[]) => mockAssertReadable(...a),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), system: vi.fn(), info: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

import { createSendFileToMcpTool, shouldAttachFileBridge } from '../mcp-file-bridge.js';
import type { AgentDef } from '../../types/agent.js';

// The live server map — what spawnAgent passes to the SDK after OAuth binding.
// The bridge must resolve targets from THIS, not from agent.def.mcpServers.
function makeLiveServers(): Record<string, unknown> {
  return {
    'sweatco-admin': {
      type: 'http',
      url: 'https://admin.example/mcp',
      headers: { 'CF-Access-Client-Id': 'cid', 'CF-Access-Client-Secret': 'sec' },
    },
    'stdio-server': { command: 'npx', args: ['foo'] },
    'legacy-sse': { type: 'sse', url: 'https://old.example/sse' },
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    def: {
      id: 'ops-agent',
      mcpServers: makeLiveServers(),
    },
    sandbox: { allowReadPaths: ['/shared'] },
    ...overrides,
  } as never;
}

const task = {} as never;

function runTool(args: Record<string, unknown>, agent = makeAgent(), liveServers = makeLiveServers()) {
  return createSendFileToMcpTool(agent, task, liveServers).handler(args as never, {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (res: any): string =>
  (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertReadable.mockImplementation(async (p: string) => p);
  mockStat.mockResolvedValue({ isFile: () => true, size: 5 });
  mockReadFile.mockResolvedValue(Buffer.from('hello'));
  mockConnect.mockResolvedValue(undefined);
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
  mockClose.mockResolvedValue(undefined);
});

describe('send_file_to_mcp_tool', () => {
  it('rejects a server the agent is not connected to', async () => {
    const res = await runTool({
      server: 'nope',
      tool_name: 'set_offer_image',
      files: [{ path: '/shared/x.png', argument: 'image_base64' }],
    });
    expect(textOf(res)).toMatch(/not connected to an MCP server named "nope"/);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects a stdio server', async () => {
    const res = await runTool({
      server: 'stdio-server',
      tool_name: 't',
      files: [{ path: '/shared/x.png', argument: 'image_base64' }],
    });
    expect(textOf(res)).toMatch(/not a Streamable HTTP server/);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects a legacy SSE server', async () => {
    const res = await runTool({
      server: 'legacy-sse',
      tool_name: 't',
      files: [{ path: '/shared/x.png', argument: 'image_base64' }],
    });
    expect(textOf(res)).toMatch(/legacy SSE transport is not supported/);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('resolves servers from the live map, not the agent def — a dropped server is unreachable', async () => {
    // def still lists sweatco-admin, but the spawn dropped it (e.g. OAuth
    // refresh failed) so it is absent from the live map.
    const live = makeLiveServers();
    delete (live as Record<string, unknown>)['sweatco-admin'];
    const res = await runTool(
      {
        server: 'sweatco-admin',
        tool_name: 'set_offer_image',
        files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      },
      makeAgent(),
      live,
    );
    expect(textOf(res)).toMatch(/not connected to an MCP server named "sweatco-admin"/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects a tool the agent has in disallowedTools', async () => {
    const agent = makeAgent({
      def: { id: 'ops-agent', mcpServers: makeLiveServers(), disallowedTools: ['mcp__sweatco-admin__delete_offer'] },
    });
    const res = await runTool(
      {
        server: 'sweatco-admin',
        tool_name: 'delete_offer',
        files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      },
      agent,
    );
    expect(textOf(res)).toMatch(/disallowed for you/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects a whole-server disallow rule (mcp__<server> form)', async () => {
    const agent = makeAgent({
      def: { id: 'ops-agent', mcpServers: makeLiveServers(), disallowedTools: ['mcp__sweatco-admin'] },
    });
    const res = await runTool(
      {
        server: 'sweatco-admin',
        tool_name: 'set_offer_image',
        files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      },
      agent,
    );
    expect(textOf(res)).toMatch(/disallowed for you/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('enforces a tools allowlist when the def has one', async () => {
    const agent = makeAgent({
      def: { id: 'ops-agent', mcpServers: makeLiveServers(), tools: ['mcp__file-bridge__send_file_to_mcp_tool', 'mcp__sweatco-admin__set_offer_image'] },
    });
    // Listed tool goes through.
    const okRes = await runTool(
      {
        server: 'sweatco-admin',
        tool_name: 'set_offer_image',
        files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      },
      agent,
    );
    expect(textOf(okRes)).toBe('done');
    // Unlisted tool on the same server is rejected.
    const badRes = await runTool(
      {
        server: 'sweatco-admin',
        tool_name: 'delete_offer',
        files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      },
      agent,
    );
    expect(textOf(badRes)).toMatch(/not in your allowed tools list/);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('rejects when files grow past the ceiling between stat and read (TOCTOU)', async () => {
    // stat says small, but the actual read returns > 10 MB.
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 5 });
    mockReadFile.mockResolvedValueOnce(Buffer.alloc(11 * 1024 * 1024));
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [{ path: '/shared/growing.png', argument: 'image_base64' }],
    });
    expect(textOf(res)).toMatch(/grew past this tool's 10 MB ceiling/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects two files targeting the same argument', async () => {
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 't',
      files: [
        { path: '/shared/a.png', argument: 'image_base64' },
        { path: '/shared/b.png', argument: 'image_base64' },
      ],
    });
    expect(textOf(res)).toMatch(/same argument "image_base64"/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('surfaces an unreadable-path error, reads nothing, and does not call out', async () => {
    mockAssertReadable
      .mockResolvedValueOnce('/shared/ok.png')
      .mockRejectedValueOnce(new Error('path is outside readable roots'));
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [
        { path: '/shared/ok.png', argument: 'image_base64' },
        { path: '/etc/passwd', argument: 'extra_base64' },
      ],
    });
    expect(textOf(res)).toMatch(/outside readable roots/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects when the combined size is over the ceiling, before reading anything', async () => {
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, size: 6 * 1024 * 1024 })
      .mockResolvedValueOnce({ isFile: () => true, size: 5 * 1024 * 1024 });
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [
        { path: '/shared/a.png', argument: 'a_base64' },
        { path: '/shared/b.png', argument: 'b_base64' },
      ],
    });
    expect(textOf(res)).toMatch(/over this tool's 10 MB ceiling/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects a single file over the ceiling before reading it', async () => {
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 11 * 1024 * 1024 });
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [{ path: '/shared/big.png', argument: 'image_base64' }],
    });
    expect(textOf(res)).toMatch(/over this tool's 10 MB ceiling/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('injects base64 bytes, reuses the server url + headers, and returns the result', async () => {
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      arguments: { offer_id: 123, dry_run: true },
    });

    // Transport built with the server's resolved url + auth headers.
    const [url, opts] = mockTransportCtor.mock.calls[0] as [URL, { requestInit: { headers: Record<string, string> } }];
    expect(url.toString()).toBe('https://admin.example/mcp');
    expect(opts.requestInit.headers).toMatchObject({ 'CF-Access-Client-Id': 'cid', 'CF-Access-Client-Secret': 'sec' });

    // Bytes base64-encoded by the tool and injected under the named argument,
    // merged with the other arguments.
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'set_offer_image',
      arguments: { offer_id: 123, dry_run: true, image_base64: Buffer.from('hello').toString('base64') },
    });

    expect(textOf(res)).toBe('done');
    expect(mockClose).toHaveBeenCalled();
  });

  it('injects multiple files under their own arguments, file bytes winning collisions', async () => {
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('first'))
      .mockResolvedValueOnce(Buffer.from('second'));
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'compare_docs',
      files: [
        { path: '/shared/a.pdf', argument: 'doc_a_base64' },
        { path: '/shared/b.pdf', argument: 'doc_b_base64' },
      ],
      // doc_a_base64 collides with a file argument — the real bytes must win.
      arguments: { mode: 'strict', doc_a_base64: 'model-supplied-garbage' },
    });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'compare_docs',
      arguments: {
        mode: 'strict',
        doc_a_base64: Buffer.from('first').toString('base64'),
        doc_b_base64: Buffer.from('second').toString('base64'),
      },
    });
    expect(textOf(res)).toBe('done');
  });

  it('surfaces a tool-reported error (isError) as an error result', async () => {
    mockCallTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'offer not found' }] });
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      files: [{ path: '/shared/x.png', argument: 'image_base64' }],
      arguments: { offer_id: 999 },
    });
    expect(textOf(res)).toMatch(/Error:.*offer not found/);
    expect(mockClose).toHaveBeenCalled();
  });
});

describe('shouldAttachFileBridge', () => {
  // Uses the REAL isPmAgent/isRepoAgent predicates — this is the gating
  // decision spawnAgent wires the bridge through, so these cases pin down
  // which agent tracks get the tool.
  const base = { id: 'a', name: 'A', description: '', prompt: '' } as unknown as AgentDef;

  it('attaches for a plain plugin agent', () => {
    expect(shouldAttachFileBridge({ ...base, pluginName: 'ops' } as AgentDef)).toBe(true);
  });

  it('does not attach for the PM agent', () => {
    expect(shouldAttachFileBridge({ ...base, isPm: true } as AgentDef)).toBe(false);
  });

  it('does not attach for a repo agent', () => {
    expect(
      shouldAttachFileBridge({ ...base, repo: { primary: 'sweatco/x', repos: [{ github: 'sweatco/x' }] } } as unknown as AgentDef),
    ).toBe(false);
  });
});
