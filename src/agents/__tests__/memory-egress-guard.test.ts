import { describe, expect, it } from 'vitest';
import { createMemoryEgressGuardHooks, parseExactMcpToolName } from '../memory-egress-guard.js';
import type { TaskMetadata } from '../../types/task.js';

function hookFor(exposed: boolean) {
  const metadata = { memory_exposed: exposed } as TaskMetadata;
  const [matcher] = createMemoryEgressGuardHooks({
    getMetadata: () => metadata,
  });
  return matcher!.hooks[0] as (input: unknown) => Promise<any>;
}

function decision(output: any): string | undefined {
  return output.hookSpecificOutput?.permissionDecision;
}

describe('memory egress guard', () => {
  it('does not affect calls before memory exposure', async () => {
    expect(await hookFor(false)({ tool_name: 'mcp__vendor__update_record' })).toEqual({ continue: true });
  });

  it.each([
    ['Bash', 'Bash'],
    ['research', 'mcp__research-tools__web_research'],
    ['a read-only annotated external tool', 'mcp__vendor__get_record'],
    ['the arbitrary file bridge', 'mcp__file-bridge__send_file_to_mcp_tool'],
    ['a GitHub read', 'mcp__repo-tools__get_pr'],
    ['a GitHub mutation', 'mcp__repo-tools__add_pr_comment'],
    ['a repo-adjacent orchestration lookup', 'mcp__orchestration-tools__list_available_repos'],
    ['an unknown host-local tool', 'mcp__comms-tools__new_delivery_tool'],
    ['an unknown built-in', 'WebFetch'],
    ['a server-prefix spoof', 'mcp__comms-tools-evil__post_to_user'],
    ['an ambiguous server key', 'mcp__comms-tools__evil__post_to_user'],
  ])('denies %s after exposure', async (_label, name) => {
    const output = await hookFor(true)({ tool_name: name });
    expect(decision(output)).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/Nothing ran/);
  });

  it.each([
    'mcp__comms-tools__post_to_user',
    'mcp__agent-tools__send_message_to_agent',
    'mcp__orchestration-tools__report_completion',
    'mcp__memory-tools__search_memory',
    'mcp__scheduling-tools__set_reminder',
    'Read',
  ])('keeps trusted or local path %s available', async (name) => {
    expect(await hookFor(true)({ tool_name: name })).toEqual({ continue: true });
  });

  it('parses only unambiguous fully-qualified MCP names', () => {
    expect(parseExactMcpToolName('mcp__comms-tools__post_to_user')).toEqual({
      server: 'comms-tools', tool: 'post_to_user',
    });
    expect(parseExactMcpToolName('mcp__comms-tools__evil__post_to_user')).toBeUndefined();
    expect(parseExactMcpToolName('mcp__comms-tools__post__to_user')).toBeUndefined();
  });
});
