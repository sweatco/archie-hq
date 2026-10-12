/**
 * The Approve/Deny cards, which nothing else exercises.
 *
 * Approve/Deny cards are deliberately never retracted: editing a pending
 * proposal re-posts a card under the same trigger id, and a task can propose
 * more than once, so several live cards for one trigger is the normal state.
 * Everything here follows from that — a click can land on a card whose proposal
 * has since been approved, paused, withdrawn, or blocked by a cap, and the card
 * must report what actually happened rather than assert the outcome it was
 * built for.
 *
 * The two Bolt action handlers were the only part of that with no coverage: the
 * unit tests reach `handleTriggerApproval`/`handleTriggerDenial` directly, so
 * the status gate in the **no-task fallback** (taken when no task resolves from
 * the thread) and every branch of the card copy were unpinned. Both are
 * reachable only through the registered handler, which is why this file mounts
 * the app the way `subtype-sweep.test.ts` does and captures `app.action`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Application } from 'express';
import type { Trigger } from '../../../types/trigger.js';

// events.ts loads Bolt through `createRequire`, which bypasses vitest's module
// registry — so `module` is mocked and its `createRequire` hands back a fake Bolt.
// Unlike the sweep's fake, this one KEEPS the action handlers: they are the subject.
const bolt = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions = new Map<string, (arg: any) => Promise<unknown>>();
  class FakeApp {
    constructor(_opts: unknown) {}
    event(_name: string, _handler: unknown) {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action(name: string, handler: (arg: any) => Promise<unknown>) { actions.set(name, handler); }
    async start() {}
    async stop() {}
  }
  class FakeReceiver { constructor(_opts: unknown) {} }
  return { actions, exports: { App: FakeApp, ExpressReceiver: FakeReceiver, SocketModeReceiver: FakeReceiver } };
});

vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      const patched = (id: string) => (id === '@slack/bolt' ? bolt.exports : real(id));
      return Object.assign(patched, real);
    },
  };
});

const { updateMessage } = vi.hoisted(() => ({ updateMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage,
  getBotUserId: vi.fn().mockReturnValue('U_BOT'),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn().mockReturnValue('B_OURS'),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn(),
  isExternalUser: vi.fn().mockReturnValue(false),
  isChannelShared: vi.fn().mockResolvedValue(false),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn((s: string) => s),
  extractMessageContent: vi.fn(async () => ({ text: '' })),
}));

const { loadTrigger, deleteTrigger, enableProposedTrigger, withdrawPendingTrigger } = vi.hoisted(() => {
  const loadTrigger = vi.fn();
  const deleteTrigger = vi.fn().mockResolvedValue(undefined);
  const enableProposedTrigger = vi.fn().mockResolvedValue(null);
  // Faithful stand-in: the real one does the pending check and the removal
  // together under the trigger's lock, which only a real filesystem can show
  // (src/system/__tests__/trigger-store-concurrency.test.ts). Here it exists so
  // the handler's own branches — which outcome renders which card — stay testable.
  const withdrawPendingTrigger = vi.fn(async (id: string) => {
    const t = await loadTrigger(id);
    if (!t) return { outcome: 'gone' };
    if (t.status !== 'pending') return { outcome: 'resolved', status: t.status };
    await deleteTrigger(id);
    return { outcome: 'withdrawn' };
  });
  return { loadTrigger, deleteTrigger, enableProposedTrigger, withdrawPendingTrigger };
});
vi.mock('../../../system/trigger-store.js', () => ({ loadTrigger, deleteTrigger, enableProposedTrigger, withdrawPendingTrigger }));

vi.mock('../../../system/trigger-scheduler.js', () => ({
  getChannelMessageTriggers: vi.fn().mockReturnValue([]),
  fireTrigger: vi.fn().mockResolvedValue(undefined),
  triggerWhat: vi.fn((t: Trigger) => t.summary ?? ''),
  // Sentinel, not the real shape: this factory replaces the module wholesale, so
  // asserting block CONTENT here would assert against this stub. The real output
  // is pinned in src/system/__tests__/trigger-approval-blocks.test.ts; what these
  // tests check is the WIRING — which branch passes blocks through, which clears them.
  triggerCapExceeded: vi.fn().mockResolvedValue(false),
  buildTriggerApprovalBlocks: vi.fn((t: Trigger, notice?: string) => [{ type: 'actions', triggerId: t.id, notice }]),
  indexTrigger: vi.fn(),
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
}));

const { findTaskByThread } = vi.hoisted(() => ({ findTaskByThread: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByThread,
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));

const { taskGet, updateSlackMessageSafely } = vi.hoisted(() => ({
  taskGet: vi.fn(),
  updateSlackMessageSafely: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: taskGet, create: vi.fn() }, activeTasks: new Map() }));

vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('../../../system/event-bus.js', () => ({ onEvent: vi.fn(), offEvent: vi.fn(), emitEvent: vi.fn() }));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions', WORKDIR: '/tmp/workdir' }));
vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { mountSlackApp } from '../events.js';

const TRIGGER_ID = 'trg-20260729-1056-6nd69p';

function makeTrigger(status: Trigger['status']): Trigger {
  return {
    id: TRIGGER_ID,
    summary: 'the standup digest',
    status,
    created_by: 'U_REQ',
    created_at: '2026-07-29T10:56:00.000Z',
    binding: { type: 'channel', channel_id: 'C_STANDUP', channel_name: 'standup' },
    conditions: [{ type: 'schedule', cron: '0 9 * * 1-5', tz: 'Europe/London', next_run_at: '2026-07-30T08:00:00.000Z' }],
    action: { prompt: 'post the digest' },
  } as Trigger;
}

/** The Bolt payload for a click on a card sitting in a thread. */
const clickBody = {
  user: { id: 'U_CLICKER' },
  channel: { id: 'C_THREAD' },
  message: { ts: '1722250000.000100', thread_ts: '1722249000.000100' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function click(actionId: 'approve_trigger' | 'deny_trigger'): Promise<void> {
  const handler = bolt.actions.get(actionId);
  expect(handler, `${actionId} handler was never registered`).toBeDefined();
  await handler!({ action: { value: TRIGGER_ID }, ack: vi.fn().mockResolvedValue(undefined), body: clickBody });
}

/** The text the card was rewritten to. */
function cardText(): string {
  expect(updateSlackMessageSafely).toHaveBeenCalledTimes(1);
  return updateSlackMessageSafely.mock.calls[0]![2] as string;
}

/** The blocks the card was rewritten to. Empty means the buttons were retired. */
function cardBlocks(): unknown[] {
  expect(updateSlackMessageSafely).toHaveBeenCalledTimes(1);
  return updateSlackMessageSafely.mock.calls[0]![3] as unknown[];
}

beforeEach(async () => {
  vi.clearAllMocks();
  bolt.actions.clear();
  enableProposedTrigger.mockResolvedValue(null);
  deleteTrigger.mockResolvedValue(undefined);
  findTaskByThread.mockResolvedValue(undefined);
  await mountSlackApp({} as Application, { slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test' });
});

describe('deny_trigger — with no task, the status gate still holds', () => {
  // A card edit is authorized through the task, so with no task the card is left alone — but a
  // stale Deny must still not tear down a live automation.
  it('withdraws a still-pending proposal', async () => {
    loadTrigger.mockResolvedValue(makeTrigger('pending'));
    await click('deny_trigger');
    expect(deleteTrigger).toHaveBeenCalledWith(TRIGGER_ID);
  });

  it('does NOT delete an enabled or paused trigger', async () => {
    for (const status of ['enabled', 'paused'] as const) {
      vi.clearAllMocks();
      loadTrigger.mockResolvedValue(makeTrigger(status));
      await click('deny_trigger');
      expect(deleteTrigger, status).not.toHaveBeenCalled();
    }
  });

  it('touches no card and writes no finding', async () => {
    loadTrigger.mockResolvedValue(makeTrigger('pending'));
    await click('deny_trigger');
    expect(taskGet).not.toHaveBeenCalled();
    expect(updateSlackMessageSafely).not.toHaveBeenCalled();
  });
});

describe('deny_trigger — the card reports the task handler\'s real outcome', () => {
  function withTask(result: unknown) {
    findTaskByThread.mockResolvedValue('task-20260729-1054-e0dc5w');
    taskGet.mockResolvedValue({ handleTriggerDenial: vi.fn().mockResolvedValue(result), updateSlackMessageSafely });
  }

  it('says declined only when something was really withdrawn', async () => {
    withTask({ outcome: 'withdrawn' });
    await click('deny_trigger');
    expect(cardText()).toContain('Declined by <@U_CLICKER>');
  });

  it('reports a refused deny on a running trigger, not a declination', async () => {
    withTask({ outcome: 'already_live', status: 'enabled' });
    await click('deny_trigger');
    expect(cardText()).toContain('already approved and is running');
    expect(cardText()).not.toContain('Declined');
  });

  it('distinguishes paused from running on a refused deny', async () => {
    withTask({ outcome: 'already_live', status: 'paused' });
    await click('deny_trigger');
    expect(cardText()).toContain('currently paused');
  });

  it('reports a proposal that is no longer there', async () => {
    withTask({ outcome: 'not_found' });
    await click('deny_trigger');
    expect(cardText()).toContain('no longer around');
  });
});

describe('approve_trigger — with no task, approval is refused', () => {
  it('enables nothing and touches no card', async () => {
    loadTrigger.mockResolvedValue(makeTrigger('pending'));
    await click('approve_trigger');
    expect(enableProposedTrigger).not.toHaveBeenCalled();
    expect(updateSlackMessageSafely).not.toHaveBeenCalled();
  });
});

describe('approve_trigger — the card reads the real state instead of guessing', () => {
  // A null return from the approval path is now ROUTINE (an older card clicked
  // after the trigger is on), so it must not render as a failure with two
  // speculative causes. Each branch below is a distinct real state.
  function withTask(returned: Trigger | null) {
    findTaskByThread.mockResolvedValue('task-20260729-1054-e0dc5w');
    taskGet.mockResolvedValue({ handleTriggerApproval: vi.fn().mockResolvedValue(returned), updateSlackMessageSafely });
  }

  it('confirms the automation when the approval really enabled it', async () => {
    withTask(makeTrigger('enabled'));
    await click('approve_trigger');
    expect(cardText()).toContain('Approved by <@U_CLICKER>');
    expect(cardText()).toContain('is now on');
  });

  it('treats a second click on an earlier card as a no-op, not a failure', async () => {
    withTask(null);
    loadTrigger.mockResolvedValue(makeTrigger('enabled'));
    await click('approve_trigger');
    expect(cardText()).toContain('is already on');
    expect(cardText()).not.toContain('⚠️');
  });

  it('reports a trigger that was approved earlier and then paused', async () => {
    withTask(null);
    loadTrigger.mockResolvedValue(makeTrigger('paused'));
    await click('approve_trigger');
    expect(cardText()).toContain('currently paused');
    expect(cardText()).not.toContain('⚠️');
  });

  it('reports a withdrawn proposal as gone rather than as a limit problem', async () => {
    withTask(null);
    loadTrigger.mockResolvedValue(null);
    await click('approve_trigger');
    expect(cardText()).toContain('no longer around');
  });

  it('names the cap as the reason when the proposal is still sitting there pending', async () => {
    // The cap path deliberately leaves the proposal PENDING rather than deleting
    // it, which is the only thing that lets this branch distinguish "a limit was
    // reached" from "it was withdrawn" — the two the old copy had to guess between.
    withTask(null);
    loadTrigger.mockResolvedValue(makeTrigger('pending'));
    await click('approve_trigger');
    expect(cardText()).toContain('active-trigger limit was reached');
  });

  it('KEEPS the buttons on a cap refusal, so freeing a slot and approving again works', async () => {
    // The refusal leaves the proposal on disk precisely so the user can free a
    // slot and approve this same one. Passing an empty blocks array here strips
    // the action block from the card that says so, which left a proposal every
    // listing called "awaiting approval" and nothing left to click.
    withTask(null);
    loadTrigger.mockResolvedValue(makeTrigger('pending'));
    await click('approve_trigger');

    const blocks = cardBlocks();
    expect(blocks.length, 'a cap refusal must re-render the card, not retire it').toBeGreaterThan(0);
    expect(blocks).toMatchObject([{ type: 'actions', triggerId: TRIGGER_ID }]);
    // The notice is carried into the card, not only into the fallback text.
    expect((blocks[0] as { notice?: string }).notice).toContain('active-trigger limit was reached');
  });

  it('retires the buttons on every terminal outcome', async () => {
    // Enabled, paused and withdrawn are all decided — the card must not stay
    // clickable, or an old prompt keeps offering a choice that no longer exists.
    for (const state of ['enabled', 'paused'] as const) {
      vi.clearAllMocks();
      withTask(null);
      loadTrigger.mockResolvedValue(makeTrigger(state));
      await click('approve_trigger');
      expect(cardBlocks(), `${state} is terminal`).toEqual([]);
    }
    vi.clearAllMocks();
    withTask(null);
    loadTrigger.mockResolvedValue(null);
    await click('approve_trigger');
    expect(cardBlocks(), 'a withdrawn proposal is terminal').toEqual([]);
  });

  it('retires the buttons when the approval really enabled the trigger', async () => {
    withTask(makeTrigger('enabled'));
    await click('approve_trigger');
    expect(cardBlocks()).toEqual([]);
  });
});
