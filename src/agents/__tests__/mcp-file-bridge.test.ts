/**
 * MCP file bridge tests — send_file_to_mcp_tool.
 *
 * Verifies the guardrails (server must be one the agent has; http/sse only;
 * path must be sandbox-readable; size ceiling) and the happy path: the file's
 * bytes are base64-encoded by the tool and injected as the named argument, the
 * outbound client reuses the server's resolved url + auth headers, and the
 * target tool's response (incl. isError) is surfaced verbatim.
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

import { createSendFileToMcpTool } from '../mcp-file-bridge.js';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    def: {
      id: 'ops-agent',
      mcpServers: {
        'sweatco-admin': {
          type: 'http',
          url: 'https://admin.example/mcp',
          headers: { 'CF-Access-Client-Id': 'cid', 'CF-Access-Client-Secret': 'sec' },
        },
        'stdio-server': { command: 'npx', args: ['foo'] },
      },
    },
    sandbox: { allowReadPaths: ['/shared'] },
    ...overrides,
  } as never;
}

const task = {} as never;

function runTool(args: Record<string, unknown>, agent = makeAgent()) {
  return createSendFileToMcpTool(agent, task).handler(args as never, {});
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
      file_path: '/shared/x.png',
      file_argument: 'image_base64',
    });
    expect(textOf(res)).toMatch(/not connected to an MCP server named "nope"/);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects a non-http/sse server', async () => {
    const res = await runTool({
      server: 'stdio-server',
      tool_name: 't',
      file_path: '/shared/x.png',
      file_argument: 'image_base64',
    });
    expect(textOf(res)).toMatch(/not an HTTP\/SSE server/);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('surfaces an unreadable-path error and does not call out', async () => {
    mockAssertReadable.mockRejectedValueOnce(new Error('path is outside readable roots'));
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      file_path: '/etc/passwd',
      file_argument: 'image_base64',
    });
    expect(textOf(res)).toMatch(/outside readable roots/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects files over the size ceiling before reading them', async () => {
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 11 * 1024 * 1024 });
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      file_path: '/shared/big.png',
      file_argument: 'image_base64',
    });
    expect(textOf(res)).toMatch(/over this tool's 10 MB ceiling/);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('injects base64 bytes, reuses the server url + headers, and returns the result', async () => {
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      file_path: '/shared/x.png',
      file_argument: 'image_base64',
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

  it('surfaces a tool-reported error (isError) as an error result', async () => {
    mockCallTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'offer not found' }] });
    const res = await runTool({
      server: 'sweatco-admin',
      tool_name: 'set_offer_image',
      file_path: '/shared/x.png',
      file_argument: 'image_base64',
      arguments: { offer_id: 999 },
    });
    expect(textOf(res)).toMatch(/Error:.*offer not found/);
    expect(mockClose).toHaveBeenCalled();
  });
});
