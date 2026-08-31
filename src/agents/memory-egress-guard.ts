import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { TaskMetadata } from '../types/task.js';

const AUDITED_LOCAL_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
  'TaskOutput',
  'TaskStop',
  'Skill',
  'mcp__agent-tools__send_message_to_agent',
  'mcp__agent-tools__log_finding',
  'mcp__agent-tools__share_artifact',
  'mcp__comms-tools__post_to_user',
  'mcp__comms-tools__post_files_to_user',
  'mcp__comms-tools__find_slack_user',
  'mcp__comms-tools__find_slack_channel',
  'mcp__comms-tools__list_channels',
  'mcp__comms-tools__read_channel_history',
  'mcp__comms-tools__read_thread',
  'mcp__comms-tools__post_to_channel',
  'mcp__comms-tools__mute_channel',
  'mcp__comms-tools__react_to_message',
  'mcp__comms-tools__unreact_from_message',
  'mcp__comms-tools__get_message_reactions',
  'mcp__comms-tools__fetch_slack_reference',
  'mcp__orchestration-tools__assign_task_owner',
  'mcp__orchestration-tools__report_completion',
  'mcp__orchestration-tools__request_edit_mode',
  'mcp__orchestration-tools__request_max_mode',
  'mcp__orchestration-tools__get_agents_status',
  'mcp__orchestration-tools__get_task_usage',
  'mcp__orchestration-tools__propose_trigger',
  'mcp__orchestration-tools__list_triggers',
  'mcp__orchestration-tools__update_trigger',
  'mcp__orchestration-tools__delete_trigger',
  'mcp__scheduling-tools__parse_datetime',
  'mcp__scheduling-tools__set_reminder',
  'mcp__scheduling-tools__cancel_reminder',
  'mcp__memory-tools__search_memory',
  'mcp__memory-tools__read_entity',
  'mcp__memory-tools__read_task_summary',
]);

const EXACT_MCP_TOOL_RE = /^mcp__([A-Za-z0-9](?:(?!__)[A-Za-z0-9_-])*)__([A-Za-z0-9](?:(?!__)[A-Za-z0-9_-])*)$/;

export function parseExactMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const match = EXACT_MCP_TOOL_RE.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

function deny(toolName: string): HookJSONOutput {
  const parsed = parseExactMcpToolName(toolName);
  const label = parsed ? `${parsed.server}:${parsed.tool}` : toolName || 'unknown tool';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: `\`${label}\` was refused because this task has already received memory and the host has not audited that exact tool as local and audience-compatible. Nothing ran.`,
    },
  };
}

export function createMemoryEgressGuardHooks(port: {
  getMetadata: () => TaskMetadata;
}): HookCallbackMatcher[] {
  return [{
    hooks: [async (input: any): Promise<HookJSONOutput> => {
      if (port.getMetadata().memory_exposed !== true) return { continue: true };
      const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
      return AUDITED_LOCAL_TOOLS.has(toolName) ? { continue: true } : deny(toolName);
    }],
  }];
}
