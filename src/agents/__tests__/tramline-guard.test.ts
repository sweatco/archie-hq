import { describe, it, expect, vi } from 'vitest';
import {
  classifyTramlineTool,
  actionDigest,
  renderAction,
  indexTargets,
  mergeTargets,
  canApproveReleaseAction,
  releaseApprovers,
  extractPayload,
  recordIdsIn,
  createTramlineGuardHooks,
  createTramlineContextHook,
  TARGET_INDEX_LIMIT,
  type TramlineGuardPort,
} from '../tramline-guard.js';

const tool = (action: string) => `mcp__tramline__${action}`;

const SUB_ID = '4f3a1c2e-1111-4222-8333-444455556666';
const ROLLOUT_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

/** Run the PreToolUse guard and return its hook output. */
async function runGuard(port: TramlineGuardPort, tool_name: string, tool_input: unknown) {
  const [matcher] = createTramlineGuardHooks(port);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await matcher.hooks[0]({ tool_name, tool_input } as any, undefined as any, {} as any)) as any;
}

function fakePort(overrides: Partial<TramlineGuardPort> = {}): TramlineGuardPort {
  return {
    getTargets: () => ({}),
    recordTargets: () => {},
    consumeApproval: () => false,
    requestApproval: async () => 'posted',
    ...overrides,
  };
}

const denialReason = (result: { hookSpecificOutput?: { permissionDecisionReason?: string } }) =>
  result.hookSpecificOutput?.permissionDecisionReason ?? '';

const isDeny = (result: { hookSpecificOutput?: { permissionDecision?: string } }) =>
  result.hookSpecificOutput?.permissionDecision === 'deny';

describe('classifyTramlineTool', () => {
  it('ignores tools from other MCP servers', () => {
    expect(classifyTramlineTool('mcp__teamcity__trigger_build')).toBe('not-tramline');
    expect(classifyTramlineTool('Read')).toBe('not-tramline');
  });

  it('passes reads through', () => {
    expect(classifyTramlineTool(tool('get_release'))).toBe('read');
    expect(classifyTramlineTool(tool('get_release_analytics'))).toBe('read');
  });

  it('auto-allows the three state-mirroring writes', () => {
    expect(classifyTramlineTool(tool('poll_workflow_run_status'))).toBe('auto');
    expect(classifyTramlineTool(tool('fetch_workflow_run_status'))).toBe('auto');
    expect(classifyTramlineTool(tool('sync_submission_from_store'))).toBe('auto');
  });

  it('never allows the irreversible rollout and store actions', () => {
    for (const action of [
      'fully_release_rollout',
      'halt_rollout',
      'fully_release_previous_rollout',
      'prepare_submission',
      'cancel_submission_review',
    ]) {
      expect(classifyTramlineTool(tool(action))).toBe('never');
    }
  });

  it('gates the retry/trigger actions the agent is meant to use', () => {
    expect(classifyTramlineTool(tool('retry_submission'))).toBe('gated');
    expect(classifyTramlineTool(tool('retry_workflow_run'))).toBe('gated');
    expect(classifyTramlineTool(tool('start_release'))).toBe('gated');
  });

  // The safe default: an action added to the MCP server later must not arrive
  // ungated just because nobody remembered to classify it.
  it('gates an unknown tramline tool', () => {
    expect(classifyTramlineTool(tool('some_action_shipped_next_quarter'))).toBe('gated');
  });

  // The sync tools read like refreshes but fan out into ProcessCommits /
  // pull_request_closed! — one pushes a version-bump commit, the other can
  // finalize a release. They must never be classified as reads or auto.
  it('gates the deceptively-named sync actions', () => {
    expect(classifyTramlineTool(tool('sync_release_commits'))).toBe('gated');
    expect(classifyTramlineTool(tool('sync_release_pull_requests'))).toBe('gated');
  });
});

describe('actionDigest', () => {
  it('is stable across argument order', () => {
    const a = actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 6 });
    const b = actionDigest(tool('extend_soak'), { additional_hours: 6, release_id: 'r1' });
    expect(a).toBe(b);
  });

  it('binds to the target — a different id is a different digest', () => {
    const a = actionDigest(tool('retry_submission'), { id: SUB_ID });
    const b = actionDigest(tool('retry_submission'), { id: ROLLOUT_ID });
    expect(a).not.toBe(b);
  });

  it('binds to the action — the same target under another tool is a different digest', () => {
    expect(actionDigest(tool('retry_submission'), { id: SUB_ID }))
      .not.toBe(actionDigest(tool('trigger_submission'), { id: SUB_ID }));
  });

  it('binds to every argument, not just the target', () => {
    expect(actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 6 }))
      .not.toBe(actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 48 }));
  });

  it('ignores undefined arguments the SDK may include', () => {
    expect(actionDigest(tool('retry_submission'), { id: SUB_ID, extra: undefined }))
      .toBe(actionDigest(tool('retry_submission'), { id: SUB_ID }));
  });
});

describe('recordIdsIn', () => {
  it('picks out record ids and ignores slugs', () => {
    expect(recordIdsIn({ app_slug: 'sweatcoin', train_slug: 'sweatcoin-ios', id: SUB_ID })).toEqual([SUB_ID]);
  });
});

describe('renderAction', () => {
  it('describes the consequence and names the target', () => {
    const rendered = renderAction(tool('retry_submission'), { id: SUB_ID }, {
      [SUB_ID]: '253.0.0 IOS · store submission · (failed)',
    });
    expect(rendered?.summary).toContain('Retry this failed store submission');
    expect(rendered?.summary).toContain('253.0.0 IOS · store submission · (failed)');
    expect(rendered?.target).toBe('253.0.0 IOS · store submission · (failed)');
  });

  // The load-bearing safety property: an unlabelled uuid means the approver
  // would be trusting the agent's word for what the button points at.
  it('refuses to render when the target id is not in the index', () => {
    expect(renderAction(tool('retry_submission'), { id: SUB_ID }, {})).toBeUndefined();
    expect(renderAction(tool('retry_submission'), { id: SUB_ID }, undefined)).toBeUndefined();
  });

  it('renders slug-addressed actions with no index at all', () => {
    const rendered = renderAction(
      tool('start_release'),
      { app_slug: 'sweatcoin', train_slug: 'sweatcoin-ios', release_type: 'hotfix' },
      undefined,
    );
    expect(rendered?.summary).toContain('Start a new release');
    expect(rendered?.summary).toContain('app_slug=sweatcoin');
    expect(rendered?.summary).toContain('release_type=hotfix');
    expect(rendered?.target).toBeUndefined();
  });

  it('spells out the blast radius of the sync actions', () => {
    const rendered = renderAction(tool('sync_release_commits'), { release_id: 'slug-abc' }, undefined);
    expect(rendered?.summary).toContain('version-bump commit');
    expect(rendered?.summary).toContain('backmerge');
  });

  it('falls back to a generic description for an unclassified action', () => {
    const rendered = renderAction(tool('brand_new_action'), { app_slug: 'sweatcoin' }, undefined);
    expect(rendered?.summary).toContain('brand_new_action');
  });
});

describe('indexTargets', () => {
  const payload = {
    release: {
      id: '11111111-1111-4111-8111-111111111111',
      release_version: '253.0.0',
      status: 'on_track',
      platform_runs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          platform: 'ios',
          status: 'on_track',
          store_submissions: [{ id: SUB_ID, status: 'failed' }],
          store_rollouts: [{ id: ROLLOUT_ID, status: 'started' }],
        },
      ],
    },
  };

  it('labels nested ids with version, platform, kind and state', () => {
    const index = indexTargets(payload);
    expect(index[SUB_ID]).toBe('253.0.0 IOS · store submission · (failed)');
    expect(index[ROLLOUT_ID]).toBe('253.0.0 IOS · staged rollout · (started)');
  });

  it('labels the release and platform run themselves', () => {
    const index = indexTargets(payload);
    expect(index['11111111-1111-4111-8111-111111111111']).toContain('253.0.0');
    expect(index['22222222-2222-4222-8222-222222222222']).toContain('platform run');
  });

  it('survives an unexpected payload shape without throwing', () => {
    expect(() => indexTargets(null)).not.toThrow();
    expect(indexTargets({ nonsense: 1 })).toEqual({});
    expect(indexTargets([{ id: 'not-a-uuid' }])).toEqual({});
  });
});

describe('mergeTargets', () => {
  it('keeps existing labels and adds new ones', () => {
    expect(mergeTargets({ a: 'one' }, { b: 'two' })).toEqual({ a: 'one', b: 'two' });
  });

  it('lets a fresh label win over a stale one', () => {
    expect(mergeTargets({ [SUB_ID]: 'old' }, { [SUB_ID]: 'new' })).toEqual({ [SUB_ID]: 'new' });
  });

  it('evicts the oldest entries past the cap', () => {
    const existing: Record<string, string> = {};
    for (let i = 0; i < TARGET_INDEX_LIMIT; i++) existing[`id-${i}`] = `label-${i}`;
    const merged = mergeTargets(existing, { fresh: 'kept' });
    expect(Object.keys(merged)).toHaveLength(TARGET_INDEX_LIMIT);
    expect(merged.fresh).toBe('kept');
    expect(merged['id-0']).toBeUndefined();
  });
});

describe('releaseApprovers / canApproveReleaseAction', () => {
  it('parses and trims the allowlist', () => {
    expect([...releaseApprovers({ ARCHIE_RELEASE_APPROVERS: 'U1, U2 ,U3' })]).toEqual(['U1', 'U2', 'U3']);
  });

  // Fail closed: an unconfigured deployment behaves exactly as today (Archie
  // reads, humans act) rather than letting anyone in the channel click.
  it('authorizes nobody when the allowlist is unset or empty', () => {
    expect(canApproveReleaseAction('U1', {})).toBe(false);
    expect(canApproveReleaseAction('U1', { ARCHIE_RELEASE_APPROVERS: '' })).toBe(false);
    expect(canApproveReleaseAction('U1', { ARCHIE_RELEASE_APPROVERS: '  ,  ' })).toBe(false);
  });

  it('authorizes only listed users', () => {
    const env = { ARCHIE_RELEASE_APPROVERS: 'U1,U2' };
    expect(canApproveReleaseAction('U1', env)).toBe(true);
    expect(canApproveReleaseAction('U9', env)).toBe(false);
    expect(canApproveReleaseAction(undefined, env)).toBe(false);
  });
});

describe('extractPayload', () => {
  it('parses the MCP text-content envelope', () => {
    expect(extractPayload({ content: [{ type: 'text', text: '{"release":{"id":"x"}}' }] }))
      .toEqual({ release: { id: 'x' } });
  });

  it('tolerates an already-parsed object', () => {
    expect(extractPayload({ release: { id: 'x' } })).toEqual({ release: { id: 'x' } });
  });

  it('returns undefined for non-JSON text rather than throwing', () => {
    expect(extractPayload({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined();
    expect(extractPayload(undefined)).toBeUndefined();
  });
});

describe('createTramlineGuardHooks', () => {
  it('lets reads and auto-allowed writes straight through', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const port = fakePort({ requestApproval });

    for (const action of ['get_release', 'poll_workflow_run_status', 'sync_submission_from_store']) {
      const result = await runGuard(port, tool(action), { id: SUB_ID });
      expect(result).toEqual({ continue: true });
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('ignores tools from other servers', async () => {
    const result = await runGuard(fakePort(), 'mcp__teamcity__trigger_build', { buildTypeId: 'x' });
    expect(result).toEqual({ continue: true });
  });

  it('denies a never-allowed action without asking anyone', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(fakePort({ requestApproval }), tool('fully_release_rollout'), { id: ROLLOUT_ID });

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('not available to agents');
    expect(denialReason(result)).toContain('tramline.sweatco.team');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requests approval for a gated action and denies this attempt', async () => {
    // Typed argument so `mock.calls[0][0]` is inspectable — the point of this
    // test is *what* the guard asks approval for, not just that it asked.
    const requestApproval = vi.fn(
      async (_request: { digest: string; tool: string; summary: string; target?: string }) => 'posted' as const,
    );
    const port = fakePort({
      requestApproval,
      getTargets: () => ({ [SUB_ID]: '253.0.0 IOS · store submission · (failed)' }),
    });

    const result = await runGuard(port, tool('retry_submission'), { id: SUB_ID });

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('needs human approval');
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      tool: 'retry_submission',
      digest: actionDigest(tool('retry_submission'), { id: SUB_ID }),
      target: '253.0.0 IOS · store submission · (failed)',
    });
  });

  it('proceeds once an approval for that exact call is spendable', async () => {
    const consumeApproval = vi.fn(() => true);
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(
      fakePort({ consumeApproval, requestApproval }),
      tool('retry_submission'),
      { id: SUB_ID },
    );

    expect(result).toEqual({ continue: true });
    expect(consumeApproval).toHaveBeenCalledWith(actionDigest(tool('retry_submission'), { id: SUB_ID }));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('denies with an actionable message when the target was never read', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(
      fakePort({ requestApproval, getTargets: () => ({}) }),
      tool('retry_submission'),
      { id: SUB_ID },
    );

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('get_release');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a second gated action while one is pending', async () => {
    const port = fakePort({
      requestApproval: async () => 'already-pending',
      getTargets: () => ({ [SUB_ID]: '253.0.0 IOS · store submission · (failed)' }),
    });

    const result = await runGuard(port, tool('retry_submission'), { id: SUB_ID });
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('already waiting for approval');
  });
});

describe('createTramlineContextHook', () => {
  it('indexes ids from a read response', async () => {
    const recordTargets = vi.fn();
    const hook = createTramlineContextHook({ recordTargets });
    await hook.hooks[0](
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        tool_name: tool('get_release'),
        tool_response: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              release: {
                id: '11111111-1111-4111-8111-111111111111',
                release_version: '253.0.0',
                platform_runs: [{ id: '22222222-2222-4222-8222-222222222222', platform: 'ios', status: 'on_track' }],
              },
            }),
          }],
        },
      } as any,
      undefined as any,
      {} as any,
    );

    expect(recordTargets).toHaveBeenCalledTimes(1);
    expect(recordTargets.mock.calls[0][0]['22222222-2222-4222-8222-222222222222']).toContain('platform run');
  });

  it('does not index action responses — only reads', async () => {
    const recordTargets = vi.fn();
    const hook = createTramlineContextHook({ recordTargets });
    await hook.hooks[0](
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { tool_name: tool('retry_submission'), tool_response: { content: [{ type: 'text', text: '{"id":"x"}' }] } } as any,
      undefined as any,
      {} as any,
    );
    expect(recordTargets).not.toHaveBeenCalled();
  });
});
