// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { parseMcpAccessPolicy, resolveToolAccess } from '../tool-access.js';
import { createToolApprovalHooks, type McpServerPolicy } from '../tool-approval-gate.js';

describe('MCP human access policy', () => {
  it('inherits per field and replaces overrides rather than widening them', () => {
    const policy = parseMcpAccessPolicy({
      default: { approverGroups: ['S1', 'S2'] },
      tools: { publish: { approverGroups: ['S3'] }, read: {} },
    }, 'access');
    expect(resolveToolAccess(policy, 'publish')).toEqual({ approverGroups: ['S3'] });
    expect(resolveToolAccess(policy, 'new_tool')).toEqual(resolveToolAccess(policy, 'read'));
    expect(resolveToolAccess(policy, 'constructor')).toEqual(policy.default);
  });

  it.each([
    null, [], { defaults: {} }, { default: null }, { default: { unknownGroup: ['S1'] } },
    { default: { approverGroups: [] } }, { default: { approverGroups: 'S1' } },
    { default: { approverGroups: ['@ops'] } }, { tools: [] }, { tools: { ' ': {} } },
    { tools: { publish: { approverGroups: [null] } } },
  ])('rejects malformed access declarations: %j', (value) => {
    expect(() => parseMcpAccessPolicy(value, 'access')).toThrow();
  });

  it('handles prototype-shaped tool names with own-property semantics', () => {
    const value = JSON.parse('{"tools":{"__proto__":{"approverGroups":["S1"]}}}');
    expect(resolveToolAccess(parseMcpAccessPolicy(value, 'access'), '__proto__')).toEqual({ approverGroups: ['S1'] });
    expect(resolveToolAccess(parseMcpAccessPolicy(value, 'access'), 'toString')).toEqual({});
  });

  it('does not make approver-only rules require confirmation on allow-tier tools', async () => {
    const policy: McpServerPolicy = { default: 'allow', tiers: {}, titles: {}, access: { default: { approverGroups: ['S1'] } } };
    const authorize = vi.fn();
    const gate = createToolApprovalHooks({ server: policy }, { authorize, consumeApproval: vi.fn(), requestApproval: vi.fn() });
    expect(await gate[0].hooks[0]({ tool_name: 'mcp__server__read', tool_input: {} } as any, undefined as any, {} as any)).toEqual({ continue: true });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('enforces a policy added while a previously unmanaged agent is running', async () => {
    const gate = createToolApprovalHooks({}, {
      currentPolicy: () => ({ server: { default: 'deny', tiers: {}, titles: {} } }),
      consumeApproval: vi.fn(), requestApproval: vi.fn(),
    });
    expect(await gate[0].hooks[0]({ tool_name: 'mcp__server__read' } as any, undefined as any, {} as any))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('keeps built-in MCP tools available even if plugin policy cannot be read', async () => {
    const currentPolicy = vi.fn(() => { throw new Error('unreadable config'); });
    const gate = createToolApprovalHooks({}, {
      serverNames: ['server'], currentPolicy, consumeApproval: vi.fn(), requestApproval: vi.fn(),
    })[0].hooks[0];
    expect(await gate({ tool_name: 'mcp__agent-tools__message' } as any, undefined as any, {} as any)).toEqual({ continue: true });
    expect(currentPolicy).not.toHaveBeenCalled();
    expect(await gate({ tool_name: 'mcp__server__read' } as any, undefined as any, {} as any))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
