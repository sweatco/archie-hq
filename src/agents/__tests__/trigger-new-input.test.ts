// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A proposal that asks for a new input, as the PM's trigger tools accept and store it, and the review card they post.
 *
 * Mock shape and handler extraction follow trigger-incoming-event.test.ts.
 */
import { MessageQueue } from '../message-queue.js';
import { mcpToolHandler } from '../../test-support/mcp.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Trigger } from '../../types/trigger.js';
import { expectDefined } from '../../test-support/assertions.js';

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi
    .fn()
    .mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
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
  logger: {
    agentAction: vi.fn(),
    agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

const { loadTrigger, saveTrigger, countActiveTriggers, updatePendingTrigger } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn(),
  countActiveTriggers: vi.fn(),
  updatePendingTrigger: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger, saveTrigger, countActiveTriggers, updatePendingTrigger };
});

const { getChannelInfo, getUserInfo, isChannelShared } = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  getUserInfo: vi.fn(),
  isChannelShared: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    getChannelInfo,
    getUserInfo,
    isChannelShared,
    fetchChannelIsPrivate: vi.fn().mockResolvedValue(true),
    postSlackMessage: vi.fn(),
  };
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

import { routineDigest } from '../../system/routine-review.js';

const TRIGGER_ID = 'trg-20261124-0900-notes1';
const ENDED = { pointer: '/type', op: 'equals', value: 'meeting.ended' } as const;
const NEW_INPUT = { type: 'incoming_event', new_input: { purpose: 'Meeting recordings' } };
const CHANNEL_BINDING = { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' };

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: new MessageQueue(),
    session: { active: false },
  } as unknown as Agent;
}

/** An operator task, which may manage any trigger. */
function makeTask(): Task {
  return {
    taskId: 'task-1',
    isActive: true,
    metadata: { channels: {}, default_channel: null },
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    prepareTriggerDelivery: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(true),
    updateSlackMessageSafely: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

async function call(name: string, task: Task, args: Record<string, unknown>): Promise<string> {
  const handler = mcpToolHandler(createOrchestrationMcpServer(makeAgent(), task), name);
  return expectDefined((await handler(args)).content[0]).text;
}

function proposal(conditions: unknown[]) {
  return {
    binding: CHANNEL_BINDING,
    conditions,
    action_prompt: 'Summarize the meeting.',
    summary: 'Meeting notes',
  };
}

function saved(): Trigger {
  expect(saveTrigger).toHaveBeenCalledTimes(1);
  return expectDefined(saveTrigger.mock.calls[0])[0] as Trigger;
}

function stored(over: Partial<Trigger> = {}): Trigger {
  return {
    id: TRIGGER_ID,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-24T09:00:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [{ type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA' }],
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'on');
  loadTrigger.mockResolvedValue(null);
  saveTrigger.mockResolvedValue(undefined);
  countActiveTriggers.mockResolvedValue(0);
  getUserInfo.mockResolvedValue({ name: 'dana', realName: 'Dana', tz: 'UTC' });
  isChannelShared.mockResolvedValue(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('propose_trigger with a new input', () => {
  it('stores what the input should be and creates nothing', async () => {
    const out = await call(
      'propose_trigger',
      makeTask(),
      proposal([{ ...NEW_INPUT, event_filter: [ENDED] }]),
    );

    expect(out).toMatch(/the person who approves becomes the owner of that input/);
    expect(saved()).toMatchObject({
      status: 'pending',
      conditions: [
        {
          type: 'new_input_event',
          purpose: 'Meeting recordings',
          auth: 'standard_webhooks',
          filter: [ENDED],
        },
      ],
    });
  });

  it('posts the review card, whose reference carries the digest of what it shows', async () => {
    const task = makeTask();

    await call('propose_trigger', task, proposal([NEW_INPUT]));

    const [, blocks, , , , reference] = expectDefined(
      vi.mocked(task.postInteractiveToUser).mock.calls[0],
    );
    expect(reference).toBe(`${saved().id}|${routineDigest(saved())}`);
    const shown = JSON.stringify(blocks);
    expect(shown).toContain('New input “Meeting recordings”, a signed webhook');
    expect(shown).toContain('#notes, a private channel');
    expect(shown).toContain('Summarize the meeting.');
  });

  it('takes a bearer token when the sender cannot sign', async () => {
    await call(
      'propose_trigger',
      makeTask(),
      proposal([{ type: 'incoming_event', new_input: { purpose: 'Deploys', auth: 'bearer' } }]),
    );

    expect(saved().conditions).toEqual([
      { type: 'new_input_event', purpose: 'Deploys', auth: 'bearer' },
    ]);
  });

  it.each([
    [
      'a purpose that could mention people',
      [{ type: 'incoming_event', new_input: { purpose: 'Notes <!channel>' } }],
      /Invalid new_input\.purpose/,
    ],
    [
      'an empty purpose',
      [{ type: 'incoming_event', new_input: { purpose: '  ' } }],
      /Invalid new_input\.purpose/,
    ],
    [
      'a new input beside an existing one in the same condition',
      [{ ...NEW_INPUT, input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA' }],
      /either `input_id` or `new_input`/,
    ],
    ['two new inputs', [NEW_INPUT, NEW_INPUT], /takes events from one input/],
    [
      'a new input beside an existing one',
      [NEW_INPUT, { type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA' }],
      /takes events from one input/,
    ],
    [
      'a schedule beside it',
      [NEW_INPUT, { type: 'schedule', cron: '0 9 * * *', tz: 'UTC' }],
      /cannot share a trigger/,
    ],
  ])('refuses %s and stores nothing', async (_name, conditions, message) => {
    const out = await call('propose_trigger', makeTask(), proposal(conditions));

    expect(out).toMatch(message);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('refuses an event routine in a channel shared with another organisation', async () => {
    isChannelShared.mockResolvedValue(true);
    const task = makeTask();

    const out = await call('propose_trigger', task, proposal([NEW_INPUT]));

    expect(out).toMatch(/cannot run in a channel shared with another organisation/);
    expect(isChannelShared).toHaveBeenCalledWith('C0NOTES');
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(task.postInteractiveToUser).not.toHaveBeenCalled();
  });

  it('leaves other triggers in a shared channel alone', async () => {
    isChannelShared.mockResolvedValue(true);

    const out = await call(
      'propose_trigger',
      makeTask(),
      proposal([{ type: 'schedule', cron: '0 9 * * *', tz: 'UTC' }]),
    );

    expect(out).toMatch(/proposed/i);
    expect(isChannelShared).not.toHaveBeenCalled();
  });
});

describe('update_trigger', () => {
  it('refuses a new input on an approved trigger', async () => {
    loadTrigger.mockResolvedValue(stored());

    const out = await call('update_trigger', makeTask(), {
      id: TRIGGER_ID,
      conditions: [NEW_INPUT],
    });

    expect(out).toMatch(/only be set up through a proposal/);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('accepts a new input on a proposal and posts the new review', async () => {
    const pending = stored({ status: 'pending' });
    loadTrigger.mockResolvedValue(pending);
    updatePendingTrigger.mockImplementation((_id: string, mutate: (trigger: Trigger) => void) => {
      mutate(pending);
      return Promise.resolve({ outcome: 'updated', trigger: pending });
    });
    const task = makeTask();

    const out = await call('update_trigger', task, { id: TRIGGER_ID, conditions: [NEW_INPUT] });

    expect(out).toMatch(/updated and re-posted for approval/);
    expect(pending.conditions).toEqual([
      { type: 'new_input_event', purpose: 'Meeting recordings', auth: 'standard_webhooks' },
    ]);
    const [, , , , , reference] = expectDefined(
      vi.mocked(task.postInteractiveToUser).mock.calls[0],
    );
    expect(reference).toBe(`${TRIGGER_ID}|${routineDigest(pending)}`);
  });

  it('still edits the conditions of an approved event routine, as before', async () => {
    loadTrigger.mockResolvedValue(stored());

    const out = await call('update_trigger', makeTask(), {
      id: TRIGGER_ID,
      conditions: [
        { type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA', event_filter: [ENDED] },
      ],
    });

    expect(out).not.toMatch(/Could not update/);
  });
});

describe('get_trigger', () => {
  it('reads a proposal back with the input it would create', async () => {
    loadTrigger.mockResolvedValue(
      stored({
        status: 'pending',
        conditions: [{ type: 'new_input_event', purpose: 'Meeting recordings', auth: 'bearer' }],
      }),
    );

    const out = await call('get_trigger', makeTask(), { id: TRIGGER_ID });

    expect(out).toContain(
      'a new input “Meeting recordings” (bearer), created when the proposal is approved',
    );
  });
});

describe('the review card of a proposal that is edited', () => {
  const FIRST_CARD = { channel_id: 'C0NOTES', ts: '1795530311.467989' };
  const SECOND_CARD = { channel_id: 'C0NOTES', ts: '1795530322.348299' };

  /** A task whose card reaches Slack at `card`, reported the way the real task reports it. */
  function taskPostingAt(card: { channel_id: string; ts: string } | null): Task {
    const task = makeTask();
    vi.mocked(task.postInteractiveToUser).mockImplementation(
      (_text, _blocks, _type, _channel, _context, _ref, onPosted) => {
        if (card) onPosted?.(card);
        return Promise.resolve(card !== null);
      },
    );
    return task;
  }

  /** Lets the store apply its change to `record`, as the real store does to the record on disk. */
  function storeHolding(record: Trigger): void {
    updatePendingTrigger.mockImplementation((_id: string, mutate: (trigger: Trigger) => void) => {
      mutate(record);
      return Promise.resolve({ outcome: 'updated', trigger: record });
    });
  }

  it('remembers where the first card landed and retires nothing', async () => {
    const record = stored({ status: 'pending' });
    storeHolding(record);
    const task = taskPostingAt(FIRST_CARD);

    await call('propose_trigger', task, proposal([NEW_INPUT]));

    expect(record.review_card).toEqual(FIRST_CARD);
    expect(task.updateSlackMessageSafely).not.toHaveBeenCalled();
  });

  it('retires the earlier card as soon as the edit posts a new one', async () => {
    const pending = stored({ status: 'pending', review_card: FIRST_CARD });
    loadTrigger.mockResolvedValue(pending);
    storeHolding(pending);
    const task = taskPostingAt(SECOND_CARD);

    await call('update_trigger', task, { id: TRIGGER_ID, action_prompt: 'Summarize it twice.' });

    expect(task.updateSlackMessageSafely).toHaveBeenCalledWith(
      'C0NOTES',
      FIRST_CARD.ts,
      'ℹ️ This card is out of date: the proposal changed after it was posted. Use the newest card in this thread.',
      [],
    );
    expect(pending.review_card).toEqual(SECOND_CARD);
  });

  it('keeps the earlier card when no new card reached Slack', async () => {
    const pending = stored({ status: 'pending', review_card: FIRST_CARD });
    loadTrigger.mockResolvedValue(pending);
    storeHolding(pending);
    const task = taskPostingAt(null);

    const out = await call('update_trigger', task, {
      id: TRIGGER_ID,
      action_prompt: 'Summarize it twice.',
    });

    expect(out).toMatch(/NO new approval card could be posted/);
    expect(task.updateSlackMessageSafely).not.toHaveBeenCalled();
    expect(pending.review_card).toEqual(FIRST_CARD);
  });

  it('still posts the new card when the earlier one cannot be retired', async () => {
    const pending = stored({ status: 'pending', review_card: FIRST_CARD });
    loadTrigger.mockResolvedValue(pending);
    storeHolding(pending);
    const task = taskPostingAt(SECOND_CARD);
    vi.mocked(task.updateSlackMessageSafely).mockRejectedValue(new Error('message_not_found'));

    const out = await call('update_trigger', task, {
      id: TRIGGER_ID,
      action_prompt: 'Summarize it twice.',
    });

    expect(out).toMatch(/updated and re-posted for approval/);
    expect(pending.review_card).toEqual(SECOND_CARD);
  });
});
