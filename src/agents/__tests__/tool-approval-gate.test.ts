import { describe, it, expect, vi } from 'vitest';
import {
  parseMcpToolName,
  deniedToolNames,
  classifyToolCall,
  callDigest,
  renderCall,
  createToolApprovalHooks,
  type McpToolPolicy,
  type McpServerPolicy,
  type ToolApprovalPort,
} from '../tool-approval-gate.js';

/**
 * A realistic policy — the shape the Tramline server declares in the plugins
 * repo's .mcp.json: reads run ungated, release-lifecycle mutations are disabled
 * outright, everything else needs a human.
 */
const TRAMLINE: McpServerPolicy = {
  default: 'ask',
  tiers: {
    list_apps: 'allow',
    get_release: 'allow',
    get_release_analytics: 'allow',
    start_release: 'deny',
  },
  // Titles only where the method name is a bad button on its own.
  titles: {
    retry_workflow_run: 'Re-run the failed CI build for this release',
    fully_release_rollout: 'Release this rollout to 100% of users immediately — irreversible',
  },
};

const POLICY: McpToolPolicy = { tramline: TRAMLINE };

const tool = (action: string) => `mcp__tramline__${action}`;

async function runGate(port: Partial<ToolApprovalPort>, tool_name: string, tool_input: unknown, policy = POLICY) {
  const fullPort: ToolApprovalPort = {
    consumeApproval: () => false,
    requestApproval: async () => 'posted',
    ...port,
  };
  const [matcher] = createToolApprovalHooks(policy, fullPort);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await matcher.hooks[0]({ tool_name, tool_input } as any, undefined as any, {} as any)) as any;
}

const denialReason = (r: { hookSpecificOutput?: { permissionDecisionReason?: string } }) =>
  r.hookSpecificOutput?.permissionDecisionReason ?? '';
const isDeny = (r: { hookSpecificOutput?: { permissionDecision?: string } }) =>
  r.hookSpecificOutput?.permissionDecision === 'deny';

describe('parseMcpToolName', () => {
  it('splits server and tool', () => {
    expect(parseMcpToolName('mcp__tramline__retry_workflow_run'))
      .toEqual({ server: 'tramline', tool: 'retry_workflow_run' });
  });

  it('handles dashed and underscored server keys', () => {
    expect(parseMcpToolName('mcp__atlassian-rovo-mcp__getJiraIssue'))
      .toEqual({ server: 'atlassian-rovo-mcp', tool: 'getJiraIssue' });
    expect(parseMcpToolName('mcp__aws_billing__get_cost'))
      .toEqual({ server: 'aws_billing', tool: 'get_cost' });
  });

  it('rejects non-MCP tools', () => {
    expect(parseMcpToolName('Read')).toBeUndefined();
    expect(parseMcpToolName('mcp__no_tool_part')).toBeUndefined();
  });
});

// A deny-tier tool is withheld from the agent up front, so it never plans
// around a tool it cannot use. The gate is the backstop, not the only stop.
describe('deniedToolNames', () => {
  it('lists every deny-tier tool as its qualified SDK name', () => {
    expect(deniedToolNames(POLICY)).toEqual(['mcp__tramline__start_release']);
  });


  it('does not withhold tools that only fall to a deny default', () => {
    // Their names aren't knowable at load time — the gate refuses them at call time.
    expect(deniedToolNames({ x: { default: 'deny', tiers: {}, titles: {} } })).toEqual([]);
  });
});

describe('classifyToolCall', () => {
  it('leaves non-MCP tools and unmanaged servers alone', () => {
    expect(classifyToolCall(POLICY, 'Read')).toBeUndefined();
    expect(classifyToolCall(POLICY, 'mcp__teamcity__trigger_build')).toBeUndefined();
    expect(classifyToolCall(undefined, tool('get_release'))).toBeUndefined();
  });

  it('classifies listed tools by their tier', () => {
    expect(classifyToolCall(POLICY, tool('get_release'))?.tier).toBe('allow');
    expect(classifyToolCall(POLICY, tool('start_release'))?.tier).toBe('deny');
    expect(classifyToolCall(POLICY, tool('retry_workflow_run'))?.tier).toBe('ask');
  });

  // A tool the server ships next quarter arrives gated, not silently open.
  it('falls back to the server default for unlisted tools', () => {
    expect(classifyToolCall(POLICY, tool('some_tool_shipped_next_quarter'))?.tier).toBe('ask');
  });
});

describe('callDigest', () => {
  it('is stable across argument order', () => {
    expect(callDigest('s', 't', { a: 1, b: 2 })).toBe(callDigest('s', 't', { b: 2, a: 1 }));
  });

  it('binds to server, tool, and every argument', () => {
    const base = callDigest('s', 't', { a: 1 });
    expect(callDigest('other', 't', { a: 1 })).not.toBe(base);
    expect(callDigest('s', 'other', { a: 1 })).not.toBe(base);
    expect(callDigest('s', 't', { a: 2 })).not.toBe(base);
    expect(callDigest('s', 't', { a: 1, extra: true })).not.toBe(base);
  });

  it('ignores undefined arguments the SDK may include', () => {
    expect(callDigest('s', 't', { a: 1, b: undefined })).toBe(callDigest('s', 't', { a: 1 }));
  });

  it('distinguishes nested argument shapes', () => {
    expect(callDigest('s', 't', { a: [1, 2] })).not.toBe(callDigest('s', 't', { a: [2, 1] }));
    expect(callDigest('s', 't', { a: 1 })).not.toBe(callDigest('s', 't', { a: '1' }));
  });
});

describe('renderCall', () => {
  const call = { server: 'tramline', tool: 'retry_workflow_run', tier: 'ask' as const };

  it("uses the policy's title for the tool plus sanitized arguments", () => {
    const r = renderCall(TRAMLINE, call, { id: 'wf-1' });
    expect(r.heading).toBe('Re-run the failed CI build for this release');
    expect(r.summary).toContain('`tramline:retry_workflow_run`');
    expect(r.summary).toContain('id=`wf-1`');
  });

  // Terse but honest — and the arguments show either way. The tool's own
  // description is unreachable: the CLI never exposes it to us.
  it('falls back to the bare identity for an untitled tool', () => {
    expect(renderCall(TRAMLINE, { ...call, tool: 'unlisted_tool' }, {}).heading)
      .toBe('Run `tramline:unlisted_tool`');
  });

  // The prompt must be authored by the engine. A string argument is the one
  // part the agent controls, and unescaped it can append its own lines.
  it('neutralizes newlines and mrkdwn in argument values', () => {
    const r = renderCall(TRAMLINE, { ...call, tool: 'extend_soak' }, {
      release_id: 'r1',
      additional_hours: '6\n*Note:* pre-agreed with the release manager — safe to approve',
    });
    expect(r.summary).not.toContain('\n*Note:*');
    expect(r.heading).not.toContain('\n');
  });

  // A title is authored in the plugins repo rather than by the agent, but it is
  // rendered rather than trusted verbatim.
  it('neutralizes newlines and mrkdwn in a title', () => {
    const policy: McpServerPolicy = {
      ...TRAMLINE,
      titles: { retry_workflow_run: 'Retry a build\n*Note:* pre-approved by the team' },
    };
    const r = renderCall(policy, call, {});
    expect(r.heading).not.toContain('\n');
    expect(r.heading).not.toContain('*Note:*');
  });

  // The digest covers null arguments, so hiding them would have the approver
  // approve an argument they were never shown.
  it('renders null arguments instead of dropping them', () => {
    expect(renderCall(TRAMLINE, call, { id: 'wf-1', reason: null }).summary).toContain('reason=`null`');
  });

  // Slack refuses a section over 3000 chars; an uncapped list would make such a
  // call permanently unapprovable rather than merely ugly.
  it('caps the number of arguments shown', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const summary = renderCall(TRAMLINE, call, many).summary;
    expect(summary).toContain('(+28 more)');
    expect(summary.length).toBeLessThan(3000);
  });

  it('caps long argument values and long titles', () => {
    expect(renderCall(TRAMLINE, call, { id: 'x'.repeat(500) }).summary.length).toBeLessThan(400);
    const longTitle: McpServerPolicy = { ...TRAMLINE, titles: { retry_workflow_run: 'd'.repeat(500) } };
    expect(renderCall(longTitle, call, {}).heading.length).toBeLessThanOrEqual(200);
  });
});

describe('createToolApprovalHooks', () => {
  it('lets unmanaged tools and allow-tier tools straight through', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    for (const name of ['Read', 'mcp__teamcity__list_builds', tool('get_release'), tool('list_apps')]) {
      expect(await runGate({ requestApproval }, name, {})).toEqual({ continue: true });
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // Belt to the disallowedTools braces: a deny-tier call that somehow reaches
  // the gate is refused without bothering a human.
  it('refuses a deny-tier call without posting an approval', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGate({ requestApproval }, tool('start_release'), {});
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('disabled by the `tramline` tool policy');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses an unlisted call under a deny default', async () => {
    const policy: McpToolPolicy = { locked: { default: 'deny', tiers: {}, titles: {} } };
    const result = await runGate({}, 'mcp__locked__anything', {}, policy);
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('cannot be run by any agent');
  });

  it('requests approval for an ask-tier call and denies this attempt', async () => {
    const requestApproval = vi.fn(
      async (_r: { digest: string; server: string; tool: string; summary: string; heading: string }) =>
        'posted' as const,
    );
    const result = await runGate({ requestApproval }, tool('retry_workflow_run'), { id: 'wf-1' });

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('needs human approval');
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const request = requestApproval.mock.calls[0][0];
    expect(request.digest).toBe(callDigest('tramline', 'retry_workflow_run', { id: 'wf-1' }));
    expect(request.heading).toBe('Re-run the failed CI build for this release');
  });


  it('raises a prompt for an untitled tool using its bare identity', async () => {
    const requestApproval = vi.fn(async (r: { heading: string }) => { void r; return 'posted' as const; });
    await runGate({ requestApproval }, tool('some_untitled_tool'), { id: 'x' });
    expect(requestApproval.mock.calls[0][0].heading).toBe('Run `tramline:some_untitled_tool`');
  });

  it('proceeds exactly once a grant for that call is spendable', async () => {
    const consumeApproval = vi.fn(() => true);
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGate({ consumeApproval, requestApproval }, tool('retry_workflow_run'), { id: 'wf-1' });

    expect(result).toEqual({ continue: true });
    expect(consumeApproval).toHaveBeenCalledWith(callDigest('tramline', 'retry_workflow_run', { id: 'wf-1' }));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a second gated call while one is pending', async () => {
    const result = await runGate({ requestApproval: async () => 'already-pending' }, tool('retry_workflow_run'), {});
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('already waiting for approval');
  });

  // Server and tool names reach the gate as model-supplied strings, so a
  // prototype hit must not be mistaken for a policy.
  it('does not treat inherited properties as policy', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    expect(await runGate({ requestApproval }, 'mcp__constructor__x', {})).toEqual({ continue: true });
    expect(await runGate({ requestApproval }, tool('constructor'), {})).not.toEqual({ continue: true });
    expect(requestApproval).toHaveBeenCalledTimes(1); // the tramline one is gated, not crashed
  });

  it('waits for the spend to be durable before letting the call through', async () => {
    const order: string[] = [];
    const consumeApproval = vi.fn(() => {
      order.push('spend');
      return Promise.resolve(true).then((v) => { order.push('flushed'); return v; });
    });
    const result = await runGate({ consumeApproval }, tool('retry_workflow_run'), { id: 'wf-1' });
    expect(result).toEqual({ continue: true });
    expect(order).toEqual(['spend', 'flushed']);
  });

  describe('fails closed', () => {
    it('denies instead of throwing when an argument overflows the canonicalizer', async () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 60_000; i++) deep = [deep];
      const result = await runGate({}, tool('retry_workflow_run'), { id: 'wf-1', junk: deep });
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('errored while evaluating');
    });

    it('denies when the port throws', async () => {
      const result = await runGate(
        { requestApproval: async () => { throw new Error('slack down'); } },
        tool('retry_workflow_run'),
        { id: 'wf-1' },
      );
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('slack down');
    });

    it('still lets unmanaged tools through when the port is broken', async () => {
      const broken = { consumeApproval: () => { throw new Error('boom'); } };
      expect(await runGate(broken, 'Read', { file_path: '/x' })).toEqual({ continue: true });
      expect(await runGate(broken, tool('get_release'), {})).toEqual({ continue: true });
    });
  });
});
