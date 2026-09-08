// SPDX-License-Identifier: AGPL-3.0-or-later

/** Human access is independent of the allow/ask/deny execution tier. */
export interface ToolAccessRule {
  requesterGroups?: string[];
  approverGroups?: string[];
}

export interface McpAccessPolicy {
  default?: ToolAccessRule;
  tools?: Record<string, ToolAccessRule>;
}

/** Created only at verified Slack ingress, never from tool arguments or API bodies. */
export interface SlackPrincipal {
  teamId: string;
  userId: string;
}

export interface ToolRequester extends SlackPrincipal {
  requestId: string;
  channelId: string;
  messageTs: string;
}

export interface ToolAccessBinding {
  taskId: string;
  revision: string;
  requester?: ToolRequester;
  rule: ToolAccessRule;
}

export class ToolAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolAccessDenied';
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rule(value: unknown, where: string): ToolAccessRule {
  const input = object(value, where);
  const output: ToolAccessRule = {};
  for (const [key, groups] of Object.entries(input)) {
    if (key !== 'requesterGroups' && key !== 'approverGroups') {
      throw new Error(`${where}: unknown access field "${key}".`);
    }
    if (!Array.isArray(groups) || groups.length === 0 ||
        groups.some((id) => typeof id !== 'string' || !/^S[A-Z0-9]+$/.test(id))) {
      throw new Error(`${where}.${key} must be a non-empty list of Slack user group IDs (S…).`);
    }
    output[key] = [...new Set(groups)].sort();
  }
  return output;
}

export function parseMcpAccessPolicy(value: unknown, where: string): McpAccessPolicy {
  const input = object(value, where);
  const output: McpAccessPolicy = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key === 'default') output.default = rule(entry, `${where}.default`);
    else if (key === 'tools') {
      const tools = object(entry, `${where}.tools`);
      output.tools = Object.create(null) as Record<string, ToolAccessRule>;
      for (const [name, restrictions] of Object.entries(tools)) {
        if (!name.trim() || name !== name.trim()) throw new Error(`${where}.tools: invalid tool name.`);
        output.tools[name] = rule(restrictions, `${where}.tools.${name}`);
      }
    } else throw new Error(`${where}: unknown access key "${key}".`);
  }
  return output;
}

export function resolveToolAccess(policy: McpAccessPolicy | undefined, tool: string): ToolAccessRule {
  const override = policy?.tools && Object.hasOwn(policy.tools, tool) ? policy.tools[tool] : {};
  return { ...policy?.default, ...override };
}

export function hasToolAccess(rule: ToolAccessRule): boolean {
  return !!(rule.requesterGroups || rule.approverGroups);
}
