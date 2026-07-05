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
 * HTTP MCP servers, base64-encodes each file, and forwards a `tools/call` with
 * the bytes injected as named arguments. It grants no new reach: the agent can
 * only target servers its session is actually connected to (the bridge
 * resolves against the same live server map the spawn hands to the SDK, AFTER
 * OAuth binding — so dropped servers are unreachable and refreshed credentials
 * are picked up), only tools not blocked by the agent's `disallowedTools`, and
 * only files it can already read.
 *
 * Only Streamable HTTP servers are supported. The legacy HTTP+SSE transport
 * (deprecated in the MCP 2025-03-26 spec revision) is rejected rather than
 * silently connected to with the wrong transport class.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFile, stat } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import { isPmAgent, isRepoAgent, type AgentDef } from '../types/agent.js';
import { assertReadable } from './artifacts.js';
import { logger } from '../system/logger.js';

/**
 * Only plain plugin agents get the file bridge: they carry the domain/admin
 * MCP servers that sometimes need a local file's bytes (e.g. uploading an
 * image). The PM overlay and repo agents do not get it. `spawnAgent` wires the
 * bridge through this predicate so the gating decision is testable on its own.
 */
export function shouldAttachFileBridge(def: AgentDef): boolean {
  return !isPmAgent(def) && !isRepoAgent(def);
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

/**
 * Absolute ceiling on the combined raw size of all files this tool will read
 * and forward in one call, independent of what any target tool accepts. Guards
 * against OOM / abusive payloads; individual MCP tools enforce their own
 * (usually smaller) limits and their rejection is surfaced back to the agent.
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

/** Shape of an entry in the live server map that the bridge can forward to. */
type HttpServerConfig = { type?: string; url?: string; headers?: Record<string, string> };

export function createSendFileToMcpTool(agent: Agent, _task: Task, liveServers: Record<string, unknown>) {
  return tool(
    'send_file_to_mcp_tool',
    "Call a tool on one of your connected MCP servers, injecting local files' raw bytes (base64-encoded) as named arguments of the tool. " +
      'Use this whenever an MCP tool needs the CONTENTS of a binary/large file you have on disk (e.g. an image to upload) — you cannot paste file bytes into a normal tool call yourself, so hand this tool the file PATH(s) and it reads and forwards the bytes for you. ' +
      'Files must be inside your readable sandbox (e.g. the shared attachments folder), and the server must be one you are already connected to. Returns the target tool\'s response verbatim.',
    {
      server: z
        .string()
        .describe('Name of one of your connected MCP servers to call, e.g. "sweatco-admin".'),
      tool_name: z
        .string()
        .describe('Bare name of the tool to call on that server, e.g. "set_offer_image".'),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe('Absolute path to the local file whose bytes to send. Must be inside your readable sandbox.'),
            argument: z
              .string()
              .describe('Name of the target tool\'s argument that should receive this file\'s base64-encoded contents, e.g. "image_base64".'),
          }),
        )
        .min(1)
        .describe('Files to inject into the tool call — usually one; each goes to a distinct target argument.'),
      arguments: z
        .record(z.string(), z.any())
        .optional()
        .describe('Other arguments to pass to the target tool as a JSON object, e.g. { "offer_id": 123, "dry_run": true }.'),
    },
    async (args) => {
      // 1. Resolve the target server off the LIVE server map — the same one the
      //    spawn hands to the SDK, after OAuth binding. This both authorizes
      //    (must be a server this session is actually connected to; servers
      //    dropped at spawn are absent) and supplies the url + freshly-bound
      //    auth headers, so we reuse existing credentials.
      const servers = liveServers as Record<string, HttpServerConfig | undefined>;
      const cfg = servers[args.server];
      if (!cfg) {
        const avail =
          Object.entries(servers)
            .filter(([, c]) => (c?.type ?? 'http') === 'http' && typeof c?.url === 'string')
            .map(([name]) => name)
            .join(', ') || '(none)';
        return err(`You are not connected to an MCP server named "${args.server}". Your forwardable servers: ${avail}.`);
      }
      const type = cfg.type ?? 'http';
      if (type !== 'http' || !cfg.url) {
        return err(
          `MCP server "${args.server}" is not a Streamable HTTP server with a URL — this tool can only forward to http servers` +
            (type === 'sse' ? ' (the legacy SSE transport is not supported)' : '') +
            '.',
        );
      }

      // 2. Honor the agent's tool-level restrictions: the bridge must not let
      //    an agent reach a tool its session has explicitly disallowed.
      const qualifiedName = `mcp__${args.server}__${args.tool_name}`;
      if (agent.def.disallowedTools?.includes(qualifiedName)) {
        return err(`Tool "${args.tool_name}" on "${args.server}" is disallowed for you and cannot be called through this bridge.`);
      }

      // 3. Reject duplicate target arguments — two files cannot land on one.
      const argNames = args.files.map((f) => f.argument);
      const dupe = argNames.find((name, i) => argNames.indexOf(name) !== i);
      if (dupe) {
        return err(`Two files target the same argument "${dupe}" — each file must go to a distinct argument.`);
      }

      // 4. Validate every path is inside the agent's readable sandbox before
      //    touching any bytes.
      if (!agent.sandbox) {
        return err('Agent sandbox is not initialized.');
      }
      const resolved: Array<{ path: string; argument: string }> = [];
      for (const f of args.files) {
        try {
          resolved.push({ path: await assertReadable(f.path, agent.sandbox), argument: f.argument });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }

      // 5. Stat everything and enforce the ceiling on the SUM before reading
      //    a single byte, then read and base64-encode.
      const fileArgs: Record<string, string> = {};
      try {
        let total = 0;
        for (const f of resolved) {
          const info = await stat(f.path);
          if (!info.isFile()) return err(`"${f.path}" is not a regular file.`);
          total += info.size;
        }
        if (total > HARD_MAX_BYTES) {
          return err(
            `Combined file size is ${(total / 1024 / 1024).toFixed(1)} MB, over this tool's ${HARD_MAX_BYTES / 1024 / 1024} MB ceiling. ` +
              `Use smaller files.`,
          );
        }
        for (const f of resolved) {
          fileArgs[f.argument] = (await readFile(f.path)).toString('base64');
        }
      } catch (e) {
        return err(`Could not read files: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 6. Open a short-lived MCP client to that server and forward the call
      //    with the file bytes injected. Bytes never pass through the model.
      //    File arguments win collisions with `arguments` — the real bytes
      //    always land under their declared names.
      const client = new Client({ name: 'archie-file-bridge', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: { ...(cfg.headers ?? {}) } },
      });
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: args.tool_name,
          arguments: { ...(args.arguments ?? {}), ...fileArgs },
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
 * repo agents don't get it. `liveServers` must be the same map the spawn
 * passes to the SDK — the bridge resolves targets from it at call time, so
 * OAuth-injected headers and dropped servers are reflected.
 */
export function createFileBridgeMcpServer(agent: Agent, task: Task, liveServers: Record<string, unknown>) {
  return createSdkMcpServer({
    name: 'file-bridge',
    version: '1.0.0',
    tools: [createSendFileToMcpTool(agent, task, liveServers)],
  });
}
