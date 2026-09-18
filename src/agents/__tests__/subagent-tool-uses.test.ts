import { describe, it, expect } from 'vitest';
import { recordSubagentToolUses, isSubagentToolUse } from '../subagent-tool-uses.js';

const assistant = (parent: string | null, toolUseId: string) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }] },
});

describe('subagent-started background tasks', () => {
  it('flags a background task whose tool call was issued inside a subagent', () => {
    const ids = new Set<string>();
    recordSubagentToolUses(assistant('toolu_agent', 'toolu_nested_bash'), ids);
    expect(isSubagentToolUse('toolu_nested_bash', ids)).toBe(true);
  });

  it('does not flag a background task the PM started itself', () => {
    const ids = new Set<string>();
    recordSubagentToolUses(assistant(null, 'toolu_pm_bash'), ids);
    expect(isSubagentToolUse('toolu_pm_bash', ids)).toBe(false);
    expect(isSubagentToolUse(undefined, ids)).toBe(false);
  });
});
