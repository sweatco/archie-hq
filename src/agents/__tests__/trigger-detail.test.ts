/**
 * The read side of trigger management, and the one validation that keeps an author filter honest.
 *
 * Two defects are pinned here, both found on the same live trigger. It watched #sweatcoin-mobile for a
 * report posted by an app, and its `from_user` held that app's `B…` id — the id Archie's own knowledge log
 * prints as the author of a bot post. Nothing refused it at creation, and `list_triggers` rendered it back
 * as "from a specific person", so the trigger was announced, listed as active, and never fired, while the
 * agent asked about it could say neither who was filtered nor what instruction ran.
 *
 * Mock shape and handler extraction follow post-to-channel-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-123/repos'),
  isThreadMuted: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

const { loadTrigger, saveTrigger, countActiveTriggers } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn().mockResolvedValue(undefined),
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger, saveTrigger, countActiveTriggers };
});

vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas: vi.fn(),
  buildOtherChannelContextSection: vi.fn().mockResolvedValue(''),
  collectCanvasFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({ collectPinnedFileAllowlist: vi.fn() }));

import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}

/**
 * A task with no linked Slack channel resolves to the OPERATOR trigger origin, which sees every trigger.
 * That is deliberate here: visibility is `trigger-visibility.ts`'s subject and has its own suite — what these
 * cases are about is what an agent that has already passed the gate is allowed to READ.
 */
function makeTask(): Task {
  return {
    taskId: 'task-1',
    isActive: true,
    metadata: { channels: {}, default_channel: null },
    touch: vi.fn(), debouncedSave: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
    prepareTriggerDelivery: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

function getHandler(name: string, task: Task): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createOrchestrationMcpServer(makeAgent(), task);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

/** The live trigger this suite was written from, reduced to the fields under test. */
const WATCHER: Trigger = {
  id: 'trg-20260820-1219-w6751m',
  status: 'enabled',
  created_by: 'U03RQQTE1EF',
  created_at: '2026-08-20T12:19:00.559Z',
  approved_by: 'U03RQQTE1EF',
  binding: { type: 'channel', channel_id: 'C05MFQCEN0N', channel_name: 'sweatcoin-mobile' },
  conditions: [{
    type: 'channel_message',
    channel_id: 'C05MFQCEN0N',
    match: { contains: 'Expired Feature Flags Report', from_user: 'B0A9ZRW2TS9' },
  }],
  action: { prompt: 'DEDUPLICATION — CHECK THIS FIRST. Do nothing at all if a report was already produced today.' },
  summary: 'Flag Release Status report',
};

beforeEach(() => {
  vi.clearAllMocks();
  loadTrigger.mockResolvedValue(null);
  countActiveTriggers.mockResolvedValue(0);
});

describe('get_trigger reads back everything an edit has to preserve', () => {
  it('names the watched channel, the keyword, the author id and the full action prompt', async () => {
    loadTrigger.mockResolvedValue(WATCHER);

    const out = textOf(await getHandler('get_trigger', makeTask())({ id: WATCHER.id }));

    expect(out).toContain('C05MFQCEN0N');
    expect(out).toContain('Expired Feature Flags Report');
    // The whole point: the author filter is a concrete id, not "a specific person".
    expect(out).toContain('B0A9ZRW2TS9');
    expect(out).not.toMatch(/a specific person/i);
    // And the instruction is quoted in full rather than clipped to its first sentence, because an agent
    // rewriting `action_prompt` replaces all of it.
    expect(out).toContain(WATCHER.action.prompt);
    expect(out).toContain('Flag Release Status report');
    // A `B…` filter is called what it is, so the agent can tell a bot watch from a person watch.
    expect(out).toMatch(/app\/bot id/i);
  });

  it('says so when a condition has no filters, rather than leaving the reader to infer it', async () => {
    loadTrigger.mockResolvedValue({
      ...WATCHER,
      conditions: [{ type: 'channel_message', channel_id: 'C05MFQCEN0N' }],
    } satisfies Trigger);

    const out = textOf(await getHandler('get_trigger', makeTask())({ id: WATCHER.id }));

    expect(out).toMatch(/body filter: none/i);
    expect(out).toMatch(/author filter: none/i);
  });

  it('surfaces the cron, timezone and next run of a schedule condition', async () => {
    loadTrigger.mockResolvedValue({
      ...WATCHER,
      conditions: [{ type: 'schedule', cron: '0 9 * * 1-5', tz: 'Europe/London', next_run_at: '2026-09-03T08:00:00.000Z' }],
    } satisfies Trigger);

    const out = textOf(await getHandler('get_trigger', makeTask())({ id: WATCHER.id }));

    expect(out).toContain('0 9 * * 1-5');
    expect(out).toContain('Europe/London');
    expect(out).toContain('2026-09-03T08:00:00.000Z');
  });

  it('warns that a conditions edit replaces the whole list', async () => {
    loadTrigger.mockResolvedValue(WATCHER);

    const out = textOf(await getHandler('get_trigger', makeTask())({ id: WATCHER.id }));

    expect(out).toMatch(/REPLACES the whole list/i);
  });

  it('refuses an id that resolves to nothing', async () => {
    const out = textOf(await getHandler('get_trigger', makeTask())({ id: 'trg-nope' }));
    expect(out).toMatch(/No trigger trg-nope found/);
  });

  // A pending proposal is not yet a trigger anywhere else in this surface (`list_triggers` and
  // `update_trigger` both filter it out); the read tool must not become the one way to see one.
  it('refuses a pending proposal', async () => {
    loadTrigger.mockResolvedValue({ ...WATCHER, status: 'pending' } satisfies Trigger);
    const out = textOf(await getHandler('get_trigger', makeTask())({ id: WATCHER.id }));
    expect(out).toMatch(/No trigger .* found/);
  });
});

describe('an author filter must be an id a message can actually carry', () => {
  const proposal = (from_user: string) => ({
    binding: { type: 'channel' as const, channel_id: 'C05MFQCEN0N', channel_name: 'sweatcoin-mobile' },
    conditions: [{ type: 'channel_message' as const, channel_id: 'C05MFQCEN0N', contains: 'Expired Feature Flags Report', from_user }],
    action_prompt: 'produce the flag release status report',
    summary: 'Flag Release Status report',
  });

  // Refused at the source: an unmatchable filter otherwise produces a trigger that is approved, announced
  // and listed as active, and then silently never fires — indistinguishable from "nobody posted".
  it.each(['flagbot', '@flagbot', 'Expired Flags Bot', 'C05MFQCEN0N', 'b0a9zrw2ts9'])(
    'refuses %j',
    async (from_user) => {
      const task = makeTask();

      const out = textOf(await getHandler('propose_trigger', task)(proposal(from_user)));

      expect(out).toMatch(/not a Slack author id/i);
      expect(task.metadata.pending_trigger_id).toBeUndefined();
      expect(saveTrigger).not.toHaveBeenCalled();
    },
  );

  // The controls. Both id kinds a message's author can be must get through — a `B…` especially, since the
  // bot id IS the author id for the app posts these watches exist for.
  it.each(['U03RQQTE1EF', 'W03RQQTE1EF', 'B0A9ZRW2TS9'])('accepts %s', async (from_user) => {
    const task = makeTask();

    const out = textOf(await getHandler('propose_trigger', task)(proposal(from_user)));

    expect(out).not.toMatch(/not a Slack author id/i);
    expect(task.metadata.pending_trigger_id).toBeDefined();
    expect(saveTrigger).toHaveBeenCalled();
    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.conditions[0]).toMatchObject({ match: { from_user } });
  });

  // The same validator has to sit on the edit path, or a rejected filter can simply be applied afterwards.
  it('refuses an unmatchable filter on update_trigger too', async () => {
    loadTrigger.mockResolvedValue(WATCHER);

    const out = textOf(await getHandler('update_trigger', makeTask())({
      id: WATCHER.id,
      conditions: [{ type: 'channel_message', channel_id: 'C05MFQCEN0N', from_user: 'flagbot' }],
    }));

    expect(out).toMatch(/not a Slack author id/i);
    expect(saveTrigger).not.toHaveBeenCalled();
  });
});
