/**
 * MCP file bridge — send a local file's bytes into an MCP tool call.
 *
 * Agents (and the models that drive them) cannot paste raw binary file
 * contents into a tool argument: the argument is generated token-by-token by
 * the model, so anything beyond a few KB is impractical and unreliable. This
 * tool closes that gap the same way `post_files_to_user` does for outbound
 * Slack uploads — the model passes a file PATH, and the tool implementation
 * (not the model) reads the bytes.
 *
 * It opens a short-lived MCP client to one of the agent's OWN already-connected
 * HTTP MCP servers (resolved config + auth headers come straight off the
 * AgentDef), base64-encodes the file, and forwards a `tools/call` with the
 * bytes injected as a named argument. It grants no new reach: the agent can
 * only target servers it is already configured with and files it can already
 * read.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFile, stat } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import { assertReadable } from './artifacts.js';
import { logger } from '../system/logger.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

/**
 * Absolute ceiling on the raw file size this tool will read and forward,
 * independent of what any target tool accepts. Guards against OOM / abusive
 * payloads; individual MCP tools enforce their own (usually smaller) limits and
 * their rejection is surfaced back to the agent.
 */
const HARD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB raw (~13.4 MB base64)

function extractResultText(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  const isError = r?.isError === true;
  const parts = Array.isArray(r?.content)
    ? r!.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
    : [];
  const text = parts.join('\n').trim();
  return { text: text || (isError ? '(tool reported an error with no message)' : '(tool returned no text content)'), isError };
}

export function createSendFileToMcpTool(agent: Agent, _task: Task) {
  return tool(
    'send_file_to_mcp_tool',
    "Call a tool on one of your connected MCP servers, injecting a local file's raw bytes (base64-encoded) as one of the tool's arguments. " +
      'Use this whenever an MCP tool needs the CONTENTS of a binary/large file you have on disk (e.g. an image to upload) — you cannot paste file bytes into a normal tool call yourself, so hand this tool the file PATH and it reads and forwards the bytes for you. ' +
      'The file must be inside your readable sandbox (e.g. the shared attachments folder), and the server must be one you are already connected to. Returns the target tool\'s response verbatim.',
    {
      server: z
        .string()
        .describe('Name of one of your connected MCP servers to call, e.g. "sweatco-admin".'),
      tool_name: z
        .string()
        .describe('Bare name of the tool to call on that server, e.g. "set_offer_image".'),
      file_path: z
        .string()
        .describe('Absolute path to the local file whose bytes to send. Must be inside your readable sandbox.'),
      file_argument: z
        .string()
        .describe('Name of the target tool\'s argument that should receive the base64-encoded file contents, e.g. "image_base64".'),
      arguments: z
        .record(z.string(), z.any())
        .optional()
        .describe('Other arguments to pass to the target tool as a JSON object, e.g. { "offer_id": 123, "dry_run": true }.'),
    },
    async (args) => {
      // 1. Resolve the target server off the agent's own resolved MCP config.
      //    This both authorizes (must be a server the agent already has) and
      //    supplies the url + auth headers, so we reuse existing credentials.
      const servers = (agent.def.mcpServers || {}) as Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
      const cfg = servers[args.server];
      if (!cfg) {
        const avail = Object.keys(servers).join(', ') || '(none)';
        return err(`You are not connected to an MCP server named "${args.server}". Your connected servers: ${avail}.`);
      }
      const type = cfg.type ?? 'http';
      if ((type !== 'http' && type !== 'sse') || !cfg.url) {
        return err(`MCP server "${args.server}" is not an HTTP/SSE server with a URL — this tool can only forward to http/sse servers.`);
      }

      // 2. Validate the path is inside the agent's readable sandbox.
      if (!agent.sandbox) {
        return err('Agent sandbox is not initialized.');
      }
      let filePath: string;
      try {
        filePath = await assertReadable(args.file_path, agent.sandbox);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      // 3. Read the bytes (with a hard size ceiling) and base64-encode.
      let b64: string;
      try {
        const info = await stat(filePath);
        if (!info.isFile()) return err(`"${args.file_path}" is not a regular file.`);
        if (info.size > HARD_MAX_BYTES) {
          return err(
            `File is ${(info.size / 1024 / 1024).toFixed(1)} MB, over this tool's ${HARD_MAX_BYTES / 1024 / 1024} MB ceiling. ` +
              `Use a smaller file.`,
          );
        }
        b64 = (await readFile(filePath)).toString('base64');
      } catch (e) {
        return err(`Could not read file "${args.file_path}": ${e instanceof Error ? e.message : String(e)}`);
      }

      // 4. Open a short-lived MCP client to that server and forward the call
      //    with the file bytes injected. Bytes never pass through the model.
      const client = new Client({ name: 'archie-file-bridge', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: { ...(cfg.headers ?? {}) } },
      });
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: args.tool_name,
          arguments: { ...(args.arguments ?? {}), [args.file_argument]: b64 },
        });
        const { text, isError } = extractResultText(result);
        return isError
          ? err(`"${args.tool_name}" on "${args.server}" reported: ${text}`)
          : ok(text);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error('mcp-file-bridge', `send_file_to_mcp_tool failed (${args.server}/${args.tool_name}): ${reason}`);
        return err(`Failed to call "${args.tool_name}" on "${args.server}": ${reason}`);
      } finally {
        try {
          await client.close();
        } catch {
          /* best-effort close */
        }
      }
    },
  );
}

/**
 * MCP server exposing the file bridge. Wired to generic plugin agents only
 * (they carry the admin/domain MCP servers that need file bytes); the PM and
 * repo agents don't get it.
 */
export function createFileBridgeMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'file-bridge',
    version: '1.0.0',
    tools: [createSendFileToMcpTool(agent, task)],
  });
}
