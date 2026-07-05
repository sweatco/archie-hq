/**
 * QA stub Streamable HTTP MCP server for AC7 (pr-167-mcp-file-bridge).
 *
 * Exposes one tool: receive_file(name, data_base64). Every call's arguments are
 * appended as a JSON line to the recording file, and the tool returns the text
 * "STUB-RECEIVED-OK-<name>". Stateless Streamable HTTP over plain node http.
 *
 * Usage: node stub-mcp-server.mjs [port] [recording-file]
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.argv[2] ?? 8971);
const RECORDING = process.argv[3] ?? new URL('./recording.jsonl', import.meta.url).pathname;

function buildServer() {
  const server = new McpServer({ name: 'qa-stub', version: '1.0.0' });
  server.tool(
    'receive_file',
    'QA stub: records the received name + data_base64 and acknowledges.',
    {
      name: z.string().describe('A label sent alongside the file'),
      data_base64: z.string().describe('Base64-encoded file bytes'),
    },
    async ({ name, data_base64 }) => {
      const bytes = Buffer.from(data_base64, 'base64');
      const record = {
        received_at: new Date().toISOString(),
        name,
        data_base64,
        decoded_byte_length: bytes.length,
        decoded_sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      appendFileSync(RECORDING, JSON.stringify(record) + '\n');
      console.error(`[stub] receive_file name=${name} bytes=${bytes.length} sha256=${record.decoded_sha256}`);
      return { content: [{ type: 'text', text: `STUB-RECEIVED-OK-${name}` }] };
    },
  );
  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      // Stateless mode: fresh server + transport per request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } else {
      // Stateless server: no GET/SSE stream, no DELETE sessions.
      res.writeHead(405, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
      );
    }
  } catch (err) {
    console.error('[stub] request error:', err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.error(`[stub] listening on 0.0.0.0:${PORT}, recording to ${RECORDING}`);
});
