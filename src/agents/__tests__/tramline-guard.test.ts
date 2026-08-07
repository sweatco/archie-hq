import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  classifyTramlineTool,
  actionDigest,
  renderAction,
  isRenderFailure,
  indexTargets,
  mergeTargets,
  stateRefusal,
  canApproveReleaseAction,
  releaseApprovers,
  extractPayload,
  targetRefsIn,
  createTramlineGuardHooks,
  createTramlineContextHook,
  TARGET_INDEX_LIMIT,
  type RenderedAction,
  type TramlineGuardPort,
} from '../tramline-guard.js';

const tool = (action: string) => `mcp__tramline__${action}`;

/**
 * A real `GET /api/v2/releases/:id` body, generated from Tramline's own
 * `Api::V2::*Serializer` classes rather than hand-written from the domain model.
 *
 * This matters more than it looks: the first version of the label index was
 * written against the domain model, shared almost no keys with the API, and
 * produced prompts that could not distinguish the iOS and Android sides of a
 * release — on the one flow this feature exists for. The unit tests did not
 * catch it because their fixture was built to match the implementation. Driving
 * the tests from the API's actual output is the fix for that class of mistake,
 * so keep this fixture generated, never edited by hand.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tramline-release-payload.json'), 'utf8'),
);

const RELEASE = FIXTURE.release;
const ANDROID = RELEASE.platform_runs.find((r: { platform: string }) => r.platform === 'android');
const IOS = RELEASE.platform_runs.find((r: { platform: string }) => r.platform === 'ios');
const ANDROID_WORKFLOW_RUN = ANDROID.production_releases[0].build.workflow_run.id;
const IOS_WORKFLOW_RUN = IOS.production_releases[0].build.workflow_run.id;
const ANDROID_SUBMISSION = ANDROID.production_releases[0].store_submission.id;
const IOS_SUBMISSION = IOS.production_releases[0].store_submission.id;
const ANDROID_ROLLOUT = ANDROID.production_releases[0].store_submission.store_rollout.id;
const INDEX = indexTargets(FIXTURE);

async function runGuard(port: TramlineGuardPort, tool_name: string, tool_input: unknown) {
  const [matcher] = createTramlineGuardHooks(port);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await matcher.hooks[0]({ tool_name, tool_input } as any, undefined as any, {} as any)) as any;
}

function fakePort(overrides: Partial<TramlineGuardPort> = {}): TramlineGuardPort {
  return {
    getTargets: () => INDEX,
    recordTargets: () => {},
    consumeApproval: () => false,
    requestApproval: async () => 'posted',
    ...overrides,
  };
}

const denialReason = (r: { hookSpecificOutput?: { permissionDecisionReason?: string } }) =>
  r.hookSpecificOutput?.permissionDecisionReason ?? '';
const isDeny = (r: { hookSpecificOutput?: { permissionDecision?: string } }) =>
  r.hookSpecificOutput?.permissionDecision === 'deny';

/** renderAction with the failure case narrowed away, for readability. */
function rendered(toolName: string, input: unknown, targets = INDEX): RenderedAction {
  const result = renderAction(toolName, input, targets);
  if (isRenderFailure(result)) throw new Error(`expected a rendered action, got ${result}`);
  return result;
}

const APPROVERS = { ARCHIE_RELEASE_APPROVERS: 'U1,U2' };

describe('classifyTramlineTool', () => {
  it('ignores tools from other MCP servers', () => {
    expect(classifyTramlineTool('mcp__teamcity__trigger_build')).toBe('not-tramline');
    expect(classifyTramlineTool('Read')).toBe('not-tramline');
  });

  it('passes reads through', () => {
    expect(classifyTramlineTool(tool('get_release'))).toBe('read');
    expect(classifyTramlineTool(tool('get_release_analytics'))).toBe('read');
  });

  // Only polling an in-progress run is genuinely side-effect-free. The other two
  // that used to live here reach Tramline code that starts production releases
  // and puts rollouts on automatic schedules.
  it('auto-allows only the in-progress CI poll', () => {
    expect(classifyTramlineTool(tool('poll_workflow_run_status'))).toBe('auto');
    expect(classifyTramlineTool(tool('fetch_workflow_run_status'))).toBe('gated');
    expect(classifyTramlineTool(tool('sync_submission_from_store'))).toBe('gated');
  });

  // The never-list is closed under EFFECT, not name. Each of these reaches an
  // irreversible outcome; several were laundering another entry on the list.
  it('never allows the irreversible actions or their aliases', () => {
    for (const action of [
      'fully_release_rollout',
      'enable_automatic_rollout',      // self-rescheduling walk to 100%
      'halt_rollout',
      'fully_release_previous_rollout',
      'prepare_submission',
      'update_submission_build',       // re-prepares + force-pushes metadata
      'submit_for_review',             // its only exit is also never-allowed
      'cancel_submission_review',
      'start_release',
      'stop_release',
    ]) {
      expect(classifyTramlineTool(tool(action)), action).toBe('never');
    }
  });

  it('gates the retry/re-trigger actions the agent is meant to use', () => {
    for (const action of ['retry_submission', 'retry_workflow_run', 'trigger_workflow_run', 'retry_pre_release']) {
      expect(classifyTramlineTool(tool(action)), action).toBe('gated');
    }
  });

  it('gates an unknown tramline tool', () => {
    expect(classifyTramlineTool(tool('some_action_shipped_next_quarter'))).toBe('gated');
  });

  it('gates the deceptively-named sync actions', () => {
    expect(classifyTramlineTool(tool('sync_release_commits'))).toBe('gated');
    expect(classifyTramlineTool(tool('sync_release_pull_requests'))).toBe('gated');
  });
});

describe('actionDigest', () => {
  it('is stable across argument order', () => {
    expect(actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 6 }))
      .toBe(actionDigest(tool('extend_soak'), { additional_hours: 6, release_id: 'r1' }));
  });

  it('binds to the target', () => {
    expect(actionDigest(tool('retry_submission'), { id: ANDROID_SUBMISSION }))
      .not.toBe(actionDigest(tool('retry_submission'), { id: IOS_SUBMISSION }));
  });

  it('binds to the action', () => {
    expect(actionDigest(tool('retry_submission'), { id: ANDROID_SUBMISSION }))
      .not.toBe(actionDigest(tool('trigger_submission'), { id: ANDROID_SUBMISSION }));
  });

  it('binds to every argument, not just the target', () => {
    expect(actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 6 }))
      .not.toBe(actionDigest(tool('extend_soak'), { release_id: 'r1', additional_hours: 48 }));
  });

  it('ignores undefined arguments the SDK may include', () => {
    expect(actionDigest(tool('retry_submission'), { id: ANDROID_SUBMISSION, extra: undefined }))
      .toBe(actionDigest(tool('retry_submission'), { id: ANDROID_SUBMISSION }));
  });

  it('distinguishes nested argument shapes', () => {
    expect(actionDigest(tool('x'), { a: { b: 1 } })).not.toBe(actionDigest(tool('x'), { a: { b: 2 } }));
    expect(actionDigest(tool('x'), { a: [1, 2] })).not.toBe(actionDigest(tool('x'), { a: [2, 1] }));
    expect(actionDigest(tool('x'), { a: null })).not.toBe(actionDigest(tool('x'), { a: '' }));
    expect(actionDigest(tool('x'), { a: 1 })).not.toBe(actionDigest(tool('x'), { a: '1' }));
  });
});

describe('targetRefsIn', () => {
  it('picks out record ids and ignores slugs', () => {
    expect(targetRefsIn({ app_slug: 'sweatcoin', train_slug: 'sweatcoin-ios', id: ANDROID_SUBMISSION }))
      .toEqual([ANDROID_SUBMISSION]);
  });
});

// The property the whole gate is justified on: the human can tell what they are
// approving. These run against the API-derived fixture.
describe('indexTargets against a real API payload', () => {
  it('carries version and platform on every nested record', () => {
    expect(INDEX[ANDROID_WORKFLOW_RUN]).toContain('253.0.0');
    expect(INDEX[ANDROID_WORKFLOW_RUN]).toContain('ANDROID');
    expect(INDEX[IOS_WORKFLOW_RUN]).toContain('253.0.0');
    expect(INDEX[IOS_WORKFLOW_RUN]).toContain('IOS');
  });

  // The regression that made the feature unusable: two failed RC runs on a
  // cross-platform release rendered byte-identically.
  it('never renders two records of the same kind identically', () => {
    expect(INDEX[ANDROID_WORKFLOW_RUN]).not.toBe(INDEX[IOS_WORKFLOW_RUN]);
    expect(INDEX[ANDROID_SUBMISSION]).not.toBe(INDEX[IOS_SUBMISSION]);

    // Keyed on ids only: the release *slug* is a deliberate alias of the release
    // id and shares its label, so it is not a collision.
    const isUuid = (k: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k);
    const labels = Object.entries(INDEX).filter(([k]) => isUuid(k)).map(([, v]) => v);
    expect(new Set(labels).size, `duplicate labels: ${JSON.stringify(labels)}`).toBe(labels.length);
  });

  it('names the kind of each record correctly', () => {
    expect(INDEX[ANDROID_WORKFLOW_RUN]).toContain('CI workflow run');
    expect(INDEX[ANDROID_SUBMISSION]).toContain('store submission');
    expect(INDEX[ANDROID_ROLLOUT]).toContain('staged rollout');
    expect(INDEX[ANDROID.production_releases[0].build.id]).toContain('build');
    expect(INDEX[ANDROID.latest_beta_release.id]).toContain('beta release');
    expect(INDEX[ANDROID.id]).toContain('platform run');
    expect(INDEX[RELEASE.id]).toContain('release');
  });

  it('labels the release itself with its version', () => {
    expect(INDEX[RELEASE.id]).toContain('253.0.0');
  });

  // A build's own version_name must not overwrite the platform run's context.
  it('does not let a child record drop the inherited platform', () => {
    expect(INDEX[ANDROID.production_releases[0].build.id]).toContain('ANDROID');
    expect(INDEX[IOS.production_releases[0].build.id]).toContain('IOS');
  });

  it('carries the build number so two builds are distinguishable', () => {
    expect(INDEX[IOS.production_releases[0].build.id]).toContain('21799');
    expect(INDEX[ANDROID.production_releases[0].build.id]).toContain('21800');
  });

  it('carries rollout percentages, because on a rollout the number is the decision', () => {
    expect(INDEX[ANDROID_ROLLOUT]).toMatch(/next 1%/);
    expect(INDEX[ANDROID_ROLLOUT]).toMatch(/stage 1\/7/);
  });

  it('carries the store for a submission', () => {
    expect(INDEX[ANDROID_SUBMISSION]).toContain('Play Store');
    expect(INDEX[IOS_SUBMISSION]).toContain('App Store');
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
    expect(mergeTargets({ x: 'old' }, { x: 'new' })).toEqual({ x: 'new' });
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

describe('renderAction', () => {
  it('describes the consequence and names the target', () => {
    const r = rendered(tool('retry_submission'), { id: IOS_SUBMISSION });
    expect(r.summary).toContain('Retry this failed store submission');
    expect(r.summary).toContain('IOS');
    expect(r.target).toBe(INDEX[IOS_SUBMISSION]);
  });

  it('refuses when the target id is not in the index', () => {
    expect(renderAction(tool('retry_submission'), { id: '11111111-2222-4333-8444-555555555555' }, {}))
      .toBe('unlabelled-target');
  });

  // Default-to-refused: an action nobody has written a consequence for must not
  // become a one-click button labelled with a method name.
  it('refuses an action with no registered description', () => {
    expect(renderAction(tool('some_action_shipped_next_quarter'), { id: ANDROID_SUBMISSION }, INDEX))
      .toBe('no-description');
  });

  it('spells out the blast radius of the sync actions', () => {
    const r = rendered(tool('sync_release_commits'), { release_id: RELEASE.slug });
    expect(r.summary).toContain('version-bump commit');
    expect(r.summary).toContain('backmerge');
  });

  it('warns that a submission retry can overwrite store metadata', () => {
    expect(rendered(tool('retry_submission'), { id: ANDROID_SUBMISSION }).summary).toMatch(/overwrites its metadata/);
  });

  it('warns that pause is a no-op on a manual Play rollout', () => {
    expect(rendered(tool('pause_rollout'), { id: ANDROID_ROLLOUT }).summary).toMatch(/changes nothing/);
  });
});

describe('stateRefusal', () => {
  it('allows a routine advance', () => {
    expect(stateRefusal('increase_rollout', '253.0.0 ANDROID · staged rollout · stage 1/7 · (started)'))
      .toBeUndefined();
  });

  // At the last stage this action IS fully_release_rollout, which is never-allowed.
  it('refuses an advance that would complete the rollout', () => {
    const refusal = stateRefusal('increase_rollout', '253.0.0 ANDROID · staged rollout · stage 7/7 · (started)');
    expect(refusal).toContain('100% of users');
    expect(refusal).toContain('fully_release_rollout');
  });

  it('refuses when the stage is not visible rather than guessing', () => {
    expect(stateRefusal('increase_rollout', '253.0.0 ANDROID · staged rollout · (started)'))
      .toContain('not visible');
  });

  it('does not apply to other actions', () => {
    expect(stateRefusal('pause_rollout', 'stage 7/7')).toBeUndefined();
  });

  // A non-staged Play rollout goes to 100% the moment it starts.
  it('refuses starting a rollout that is not staged', () => {
    const refusal = stateRefusal('start_rollout', '253.0.0 ANDROID · staged rollout · not staged, at 0% · (created)');
    expect(refusal).toContain('not staged');
    expect(refusal).toContain('100% of users');
  });

  it('allows starting a genuinely staged rollout', () => {
    expect(stateRefusal('start_rollout', '253.0.0 ANDROID · staged rollout · next 1%, stage 1/7 · (created)'))
      .toBeUndefined();
  });

  it('refuses starting a rollout whose staging is not visible', () => {
    expect(stateRefusal('start_rollout', '253.0.0 ANDROID · staged rollout · (created)')).toContain('does not say');
  });
});

describe('releaseApprovers / canApproveReleaseAction', () => {
  it('parses and trims the allowlist', () => {
    expect([...releaseApprovers({ ARCHIE_RELEASE_APPROVERS: 'U1, U2 ,U3' })]).toEqual(['U1', 'U2', 'U3']);
  });

  it('authorizes nobody when the allowlist is unset or empty', () => {
    expect(canApproveReleaseAction('U1', {})).toBe(false);
    expect(canApproveReleaseAction('U1', { ARCHIE_RELEASE_APPROVERS: '' })).toBe(false);
    expect(canApproveReleaseAction('U1', { ARCHIE_RELEASE_APPROVERS: '  ,  ' })).toBe(false);
  });

  it('authorizes only listed users', () => {
    expect(canApproveReleaseAction('U1', APPROVERS)).toBe(true);
    expect(canApproveReleaseAction('U9', APPROVERS)).toBe(false);
    expect(canApproveReleaseAction(undefined, APPROVERS)).toBe(false);
  });
});

describe('extractPayload', () => {
  const body = JSON.stringify({ release: { id: 'x' } });

  // The repo does not agree with itself about this shape (research-tools assumes
  // a bare array), and guessing wrong deadlocks the gate — so handle all of them.
  it('parses the { content: [...] } envelope', () => {
    expect(extractPayload({ content: [{ type: 'text', text: body }] })).toEqual({ release: { id: 'x' } });
  });

  it('parses a bare array of content blocks', () => {
    expect(extractPayload([{ type: 'text', text: body }])).toEqual({ release: { id: 'x' } });
  });

  it('parses a { text } wrapper and a raw string', () => {
    expect(extractPayload({ text: body })).toEqual({ release: { id: 'x' } });
    expect(extractPayload(body)).toEqual({ release: { id: 'x' } });
  });

  it('tolerates an already-parsed object', () => {
    expect(extractPayload({ release: { id: 'x' } })).toEqual({ release: { id: 'x' } });
  });

  it('returns undefined for non-JSON rather than throwing', () => {
    expect(extractPayload({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined();
    expect(extractPayload(undefined)).toBeUndefined();
  });
});

describe('createTramlineGuardHooks', () => {
  it('lets reads and the CI poll straight through', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    for (const action of ['get_release', 'list_releases', 'poll_workflow_run_status']) {
      expect(await runGuard(fakePort({ requestApproval }), tool(action), { id: ANDROID_WORKFLOW_RUN }))
        .toEqual({ continue: true });
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('ignores tools from other servers', async () => {
    expect(await runGuard(fakePort(), 'mcp__teamcity__trigger_build', { buildTypeId: 'x' }))
      .toEqual({ continue: true });
  });

  it('denies a never-allowed action without asking anyone', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(fakePort({ requestApproval }), tool('fully_release_rollout'), { id: ANDROID_ROLLOUT });

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('not available to agents');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('denies enable_automatic_rollout — the laundering path to 100%', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(
      fakePort({ requestApproval }),
      tool('enable_automatic_rollout'),
      { id: ANDROID_ROLLOUT },
    );
    expect(isDeny(result)).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requests approval for a gated action and denies this attempt', async () => {
    const requestApproval = vi.fn(
      async (_r: { digest: string; tool: string; summary: string; target?: string }) => 'posted' as const,
    );
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', 'U1');
    try {
      const result = await runGuard(fakePort({ requestApproval }), tool('retry_workflow_run'), { id: IOS_WORKFLOW_RUN });

      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('needs human approval');
      expect(requestApproval).toHaveBeenCalledTimes(1);
      const request = requestApproval.mock.calls[0][0];
      expect(request.tool).toBe('retry_workflow_run');
      expect(request.digest).toBe(actionDigest(tool('retry_workflow_run'), { id: IOS_WORKFLOW_RUN }));
      // The approver must be able to see WHICH platform they are re-running.
      expect(request.target).toContain('IOS');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Posting a button nobody can press AND parking the task would be worse than
  // the read-only status quo, not equal to it.
  it('refuses without posting or parking when no approvers are configured', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', '');
    try {
      const result = await runGuard(fakePort({ requestApproval }), tool('retry_workflow_run'), { id: IOS_WORKFLOW_RUN });
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('no release approvers are configured');
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('proceeds once an approval for that exact call is spendable', async () => {
    const consumeApproval = vi.fn(() => true);
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(
      fakePort({ consumeApproval, requestApproval }),
      tool('retry_submission'),
      { id: ANDROID_SUBMISSION },
    );

    expect(result).toEqual({ continue: true });
    expect(consumeApproval).toHaveBeenCalledWith(actionDigest(tool('retry_submission'), { id: ANDROID_SUBMISSION }));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('denies with an actionable message when the target was never read', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGuard(
      fakePort({ requestApproval, getTargets: () => ({}) }),
      tool('retry_submission'),
      { id: ANDROID_SUBMISSION },
    );

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('get_release');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a terminal-stage rollout advance instead of asking for approval', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const terminal = { ...INDEX, [ANDROID_ROLLOUT]: '253.0.0 ANDROID · staged rollout · stage 7/7 · (started)' };
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', 'U1');
    try {
      const result = await runGuard(
        fakePort({ requestApproval, getTargets: () => terminal }),
        tool('increase_rollout'),
        { id: ANDROID_ROLLOUT },
      );
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('100% of users');
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a second gated action while one is pending', async () => {
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', 'U1');
    try {
      const result = await runGuard(
        fakePort({ requestApproval: async () => 'already-pending' }),
        tool('retry_submission'),
        { id: ANDROID_SUBMISSION },
      );
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('already waiting for approval');
    } finally {
      vi.unstubAllEnvs();
    }
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
        tool_response: { content: [{ type: 'text', text: JSON.stringify(FIXTURE) }] },
      } as any,
      undefined as any,
      {} as any,
    );

    expect(recordTargets).toHaveBeenCalledTimes(1);
    expect(recordTargets.mock.calls[0][0][IOS_WORKFLOW_RUN]).toContain('IOS');
  });

  it('indexes a bare-array response shape too', async () => {
    const recordTargets = vi.fn();
    const hook = createTramlineContextHook({ recordTargets });
    await hook.hooks[0](
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { tool_name: tool('get_release'), tool_response: [{ type: 'text', text: JSON.stringify(FIXTURE) }] } as any,
      undefined as any,
      {} as any,
    );
    expect(recordTargets).toHaveBeenCalledTimes(1);
    expect(Object.keys(recordTargets.mock.calls[0][0]).length).toBeGreaterThan(5);
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

// The prompt must be authored by us. A string argument is the one part the agent
// controls, and unescaped it can append its own lines to the Slack message.
describe('argument rendering cannot forge prompt content', () => {
  it('neutralizes newlines and mrkdwn in an argument value', () => {
    const r = rendered(tool('extend_soak'), {
      release_id: RELEASE.slug,
      additional_hours: '6\n*Note:* pre-agreed with the release manager — safe to approve',
    });
    expect(r.summary).not.toContain('\n*Note:*');
    expect(r.summary).not.toMatch(/\*Note:\*/);
    expect(r.summary.split('\n').filter((l) => l.startsWith('*')).length).toBeLessThanOrEqual(2);
  });

  it('caps a long argument value', () => {
    const r = rendered(tool('extend_soak'), { release_id: RELEASE.slug, additional_hours: 'x'.repeat(500) });
    expect(r.summary.length).toBeLessThan(400);
  });
});

// Tramline accepts release_id as a UUID *or* a slug; matching UUIDs alone let the
// agent skip the "must have read it" requirement on every release-level action.
describe('slug-addressed targets', () => {
  it('indexes the release slug alongside its id', () => {
    expect(INDEX[RELEASE.slug]).toBe(INDEX[RELEASE.id]);
  });

  it('refuses a slug-addressed release action the task has not read', () => {
    expect(renderAction(tool('complete_release'), { release_id: 'some-other-release' }, INDEX))
      .toBe('unlabelled-target');
  });

  it('renders a slug-addressed action once the release has been read', () => {
    expect(rendered(tool('complete_release'), { release_id: RELEASE.slug }).target).toContain('253.0.0');
  });
});

describe('the guard fails closed', () => {
  it('denies instead of throwing when an argument overflows the canonicalizer', async () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 60_000; i++) deep = [deep];
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', 'U1');
    try {
      const result = await runGuard(fakePort(), tool('retry_submission'), { id: ANDROID_SUBMISSION, junk: deep });
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('errored while evaluating');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('denies when the port throws', async () => {
    vi.stubEnv('ARCHIE_RELEASE_APPROVERS', 'U1');
    try {
      const result = await runGuard(
        fakePort({ requestApproval: async () => { throw new Error('slack down'); } }),
        tool('retry_submission'),
        { id: ANDROID_SUBMISSION },
      );
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('slack down');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still lets a non-tramline tool through', async () => {
    expect(await runGuard(fakePort({ getTargets: () => { throw new Error('boom'); } }), 'Read', { file_path: '/x' }))
      .toEqual({ continue: true });
  });
});
