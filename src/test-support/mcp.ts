// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
export type TestToolResult = z.infer<typeof toolResultSchema>;
export type TestToolHandler = (args: unknown, extra?: unknown) => Promise<TestToolResult>;
interface RegisteredTestTool {
  description?: string;
  inputKeys: string[];
  callback: TestToolHandler;
}

export function registeredMcpTools(
  server: McpSdkServerConfigWithInstance,
): Record<string, RegisteredTestTool> {
  // The pinned MCP SDK exposes registration only through this private table.
  // Check its shape here so handler-level tests fail clearly if that SDK contract changes.
  const table: unknown = Reflect.get(server.instance, '_registeredTools');
  const entries = z.record(z.string(), z.unknown()).parse(table);
  return Object.fromEntries(
    Object.entries(entries).map(([name, raw]) => {
      assert(raw && typeof raw === 'object', `Invalid MCP tool registration: ${name}`);
      const candidate: unknown =
        Reflect.get(raw, 'callback') ?? Reflect.get(raw, 'handler') ?? Reflect.get(raw, 'cb');
      assert(typeof candidate === 'function', `Missing MCP tool callback: ${name}`);
      const invoke = candidate as (args: unknown, extra: unknown) => unknown;
      const description: unknown = Reflect.get(raw, 'description');
      const inputSchema: unknown = Reflect.get(raw, 'inputSchema');
      const shape: unknown =
        inputSchema && typeof inputSchema === 'object'
          ? Reflect.get(inputSchema, 'shape')
          : undefined;
      const inputKeys = shape && typeof shape === 'object' ? Object.keys(shape) : [];
      return [
        name,
        {
          inputKeys,
          description: typeof description === 'string' ? description : undefined,
          callback: async (args: unknown, extra: unknown = {}) =>
            toolResultSchema.parse(await invoke(args, extra)),
        },
      ];
    }),
  );
}

export function mcpToolHandler(
  server: McpSdkServerConfigWithInstance,
  name: string,
): TestToolHandler {
  const tool = registeredMcpTools(server)[name];
  assert(tool, `MCP tool '${name}' is not registered`);
  return tool.callback;
}
