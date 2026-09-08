// SPDX-License-Identifier: AGPL-3.0-or-later

import { getRootMcpConfig } from '../system/plugin-loader.js';
import { callDigest, classifyToolCall, mcpToolName, type ClassifiedCall, type McpServerPolicy, type McpToolPolicy } from '../agents/tool-approval-gate.js';
import { resolveToolAccess, ToolAccessDenied, type SlackPrincipal, type ToolAccessBinding } from '../agents/tool-access.js';
import { slackGroupAccess } from '../connectors/slack/user-groups.js';
import { appendAgentFinding } from './persistence.js';

type AccessTask = { taskId: string };

/** Restrict live policies to mounted servers; connection changes require a respawn. */
export function liveMcpPolicy(mounted: Record<string, unknown>): McpToolPolicy {
  const config = getRootMcpConfig(true);
  const result: McpToolPolicy = Object.create(null);
  for (const [server, connection] of Object.entries(mounted)) {
    if (!Object.hasOwn(config.servers, server) ||
        callDigest(server, 'connection', connection) !== callDigest(server, 'connection', config.servers[server])) {
      throw new ToolAccessDenied('MCP connection configuration changed; restart this task before using its tools.');
    }
    if (Object.hasOwn(config.policies, server)) result[server] = config.policies[server];
  }
  return result;
}

function current(server: string, tool: string): { policy: McpServerPolicy; call: ClassifiedCall; revision: string } {
  const config = getRootMcpConfig(true);
  const policy = config.policies[server];
  const call = classifyToolCall(config.policies, mcpToolName(server, tool));
  if (!call || !policy || !Object.hasOwn(config.servers, server)) {
    throw new ToolAccessDenied('The tool access policy changed; request the operation again.');
  }
  return { policy, call, revision: callDigest(server, 'access-policy', [config.servers[server], policy]) };
}

/** Synchronous recheck after each await prevents stale identity/policy snapshots from authorizing a call. */
export function assertCurrentToolAccess(task: AccessTask, server: string, tool: string, binding: ToolAccessBinding): void {
  const latest = current(server, tool);
  if (binding.taskId !== task.taskId || binding.revision !== latest.revision || latest.call.tier === 'deny') {
    throw new ToolAccessDenied('The tool access policy changed; request the operation again.');
  }
}

export async function authorizeToolCall(task: AccessTask, call: ClassifiedCall, policy: McpServerPolicy): Promise<ToolAccessBinding> {
  const latest = current(call.server, call.tool);
  if (callDigest(call.server, 'policy', policy) !== callDigest(call.server, 'policy', latest.policy)) {
    throw new ToolAccessDenied('The tool policy changed during authorization; retry.');
  }
  const rule = resolveToolAccess(policy.access, call.tool);
  if (call.tier === 'allow') delete rule.approverGroups;
  const binding: ToolAccessBinding = {
    taskId: task.taskId,
    revision: latest.revision,
    rule,
  };
  assertCurrentToolAccess(task, call.server, call.tool, binding);
  return binding;
}

export async function verifyToolApproval(
  task: AccessTask, server: string, tool: string, binding: ToolAccessBinding, approver?: SlackPrincipal,
): Promise<() => void> {
  try {
    return await verifyApproval(task, server, tool, binding, approver);
  } catch (error) {
    void appendAgentFinding(task.taskId, 'system',
      `Tool approval authorization refused: ${server}:${tool} (approver ${approver?.userId ?? 'unverified'}) — ${error instanceof Error ? error.message : 'authorization failed'}`,
      'decision').catch(() => {});
    throw error;
  }
}

async function verifyApproval(
  task: AccessTask, server: string, tool: string, binding: ToolAccessBinding, approver?: SlackPrincipal,
): Promise<() => void> {
  const membershipVersion = slackGroupAccess.version;
  assertCurrentToolAccess(task, server, tool, binding);
  const checkMembership = binding.rule.approverGroups
    ? await slackGroupAccess.requireMembership(approver, binding.rule.approverGroups)
    : undefined;
  const recheck = () => {
    if (membershipVersion !== slackGroupAccess.version) throw new ToolAccessDenied('Slack membership changed during authorization; retry.');
    checkMembership?.();
    assertCurrentToolAccess(task, server, tool, binding);
  };
  recheck();
  return recheck;
}

/** Old, unrestricted pending requests must not survive introduction of an ACL. */
export function assertUnrestrictedApproval(server: string, tool: string): void {
  // This also fails closed on unreadable policy, including a broken plugin refresh.
  const config = getRootMcpConfig(true);
  const policy = config.policies[server];
  const rule = resolveToolAccess(policy?.access, tool);
  if (rule.approverGroups) {
    throw new ToolAccessDenied('The tool now requires group authorization. Request it again under the current policy.');
  }
}
