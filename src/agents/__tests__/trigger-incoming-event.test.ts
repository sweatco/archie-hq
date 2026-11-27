// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `incoming_event` condition as the PM's trigger tools accept, store and read it back.
 *
 * Mock shape and handler extraction follow trigger-detail.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const { loadTrigger, saveTrigger, countActiveTriggers } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn(),
  countActiveTriggers: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger, saveTrigger, countActiveTriggers };
});

const { getChannelInfo, getUserInfo } = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  getUserInfo: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, getChannelInfo, getUserInfo, postSlackMessage: vi.fn() };
});

vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas: vi.fn(),
  buildOtherChannelContextSection: vi.fn().mockResolvedValue(''),
  collectCanvasFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({ collectPinnedFileAllowlist: vi.fn() }));

import { setInputServices } from '../../incoming/access.js';
import { IncomingStore } from '../../incoming/store.js';
import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

const INPUT_ID = 'inp-AAAAAAAAAAAAAAAAAAAAAA';
const TRIGGER_ID = 'trg-20261121-0900-notes1';
const DM_CHANNEL = 'D0DANA';
const ON_EVENT = { type: 'incoming_event', input_id: INPUT_ID };
const ENDED = { pointer: '/type', op: 'equals', value: 'meeting.ended' } as const;
const SCHEDULE = { type: 'schedule', cron: '0 9 * * *', tz: 'UTC' };

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: new MessageQueue(),
    session: { active: false },
  } as unknown as Agent;
}

/** A task in the DM when `dm` is set; otherwise an operator task, which may manage any trigger. */
function makeTask(dm = false): Task {
  const key = `slack:${DM_CHANNEL}:1.0`;
  return {
    taskId: 'task-1',
    isActive: true,
    metadata: dm
      ? {
          channels: { [key]: { type: 'slack', channel_id: DM_CHANNEL, thread_id: '1.0' } },
          default_channel: key,
        }
      : { channels: {}, default_channel: null },
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    prepareTriggerDelivery: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(true),
  } as unknown as Task;
}

async function call(name: string, task: Task, args: Record<string, unknown>): Promise<string> {
  const handler = mcpToolHandler(createOrchestrationMcpServer(makeAgent(), task), name);
  return expectDefined((await handler(args)).content[0]).text;
}

function proposal(conditions: unknown[], binding: Record<string, unknown> = CHANNEL_BINDING) {
  return { binding, conditions, action_prompt: 'Summarize the meeting.', summary: 'Meeting notes' };
}
const CHANNEL_BINDING = { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' };

function saved(): Trigger {
  expect(saveTrigger).toHaveBeenCalledTimes(1);
  return expectDefined(saveTrigger.mock.calls[0])[0] as Trigger;
}

function routine(over: Partial<Trigger> = {}): Trigger {
  return {
    id: TRIGGER_ID,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-21T09:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [{ type: 'incoming_event', input_id: INPUT_ID, filter: [ENDED] }],
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
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('propose_trigger with an incoming_event condition', () => {
  it('stores the input and the filter, and names both on the approval card', async () => {
    const task = makeTask();

    const out = await call(
      'propose_trigger',
      task,
      proposal([{ ...ON_EVENT, event_filter: [ENDED] }]),
    );

    expect(out).toMatch(/proposed .* once an operator links it to the input/);
    expect(saved()).toMatchObject({
      status: 'pending',
      binding: CHANNEL_BINDING,
      conditions: [{ type: 'incoming_event', input_id: INPUT_ID, filter: [ENDED] }],
    });
    expect(vi.mocked(task.postInteractiveToUser).mock.calls[0]?.[0]).toContain(
      `on an event from input \`${INPUT_ID}\` where \`/type\` is "meeting.ended"`,
    );
  });

  it('stores no filter when none is given', async () => {
    await call('propose_trigger', makeTask(), proposal([ON_EVENT]));

    expect(saved().conditions).toEqual([{ type: 'incoming_event', input_id: INPUT_ID }]);
  });

  it('accepts a DM destination', async () => {
    getChannelInfo.mockResolvedValue({
      id: DM_CHANNEL,
      name: 'DM with Dana',
      isIm: true,
      imUserId: 'U0DANA',
    });

    const out = await call(
      'propose_trigger',
      makeTask(true),
      proposal([ON_EVENT], { type: 'user' }),
    );

    expect(out).toMatch(/proposed/i);
    expect(saved().binding).toMatchObject({
      type: 'user',
      user_id: 'U0DANA',
      channel_id: DM_CHANNEL,
    });
  });

  it.each([
    ['no input id', [{ type: 'incoming_event' }], /needs the `input_id`/],
    [
      'an input id of another shape',
      [{ type: 'incoming_event', input_id: 'inp-1` <!channel>' }],
      /needs the `input_id`/,
    ],
    [
      'a pointer that is not RFC 6901',
      [{ ...ON_EVENT, event_filter: [{ pointer: 'type', op: 'present' }] }],
      /Invalid event_filter/,
    ],
    [
      'an equals check without a value',
      [{ ...ON_EVENT, event_filter: [{ pointer: '/type', op: 'equals' }] }],
      /Invalid event_filter/,
    ],
    ['a schedule beside it', [ON_EVENT, SCHEDULE], /cannot share a trigger/],
    [
      'a channel_message beside it',
      [{ type: 'channel_message', channel_id: 'C0NOTES' }, ON_EVENT],
      /cannot share a trigger/,
    ],
  ])('refuses %s and stores nothing', async (_name, conditions, message) => {
    const out = await call('propose_trigger', makeTask(), proposal(conditions));

    expect(out).toMatch(message);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('refuses the condition while incoming events are off', async () => {
    vi.stubEnv('ARCHIE_INCOMING_EVENTS', 'off');

    const out = await call('propose_trigger', makeTask(), proposal([ON_EVENT]));

    expect(out).toMatch(/Incoming events are not enabled/);
    expect(saveTrigger).not.toHaveBeenCalled();
  });
});

describe('an existing event routine', () => {
  it('is read back with its input and its filter exactly as stored', async () => {
    loadTrigger.mockResolvedValue(routine());

    const out = await call('get_trigger', makeTask(), { id: TRIGGER_ID });

    expect(out).toContain(`an event received by input ${INPUT_ID}`);
    expect(out).toContain(`event_filter (every check must pass): ${JSON.stringify([ENDED])}`);
  });

  it('cannot gain a schedule through an edit', async () => {
    loadTrigger.mockResolvedValue(routine());

    const out = await call('update_trigger', makeTask(), {
      id: TRIGGER_ID,
      conditions: [ON_EVENT, SCHEDULE],
    });

    expect(out).toMatch(/cannot share a trigger/);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'pending'] as const)(
    'cannot gain a second input through an edit while %s',
    async (status) => {
      loadTrigger.mockResolvedValue(routine({ status }));

      const out = await call('update_trigger', makeTask(), {
        id: TRIGGER_ID,
        conditions: [ON_EVENT, { type: 'incoming_event', input_id: 'inp-BBBBBBBBBBBBBBBBBBBBBB' }],
      });

      expect(out).toMatch(/Could not update the trigger: A trigger takes events from one input/);
      expect(saveTrigger).not.toHaveBeenCalled();
    },
  );
});

describe('an input that already belongs to a routine', () => {
  const OTHER_TRIGGER = 'trg-20261121-0900-other1';
  let root: string;
  let store: IncomingStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archie-trigger-input-'));
    store = new IncomingStore(join(root, 'state.sqlite'));
    store.insertInput(
      {
        id: INPUT_ID,
        state: 'enabled',
        auth: 'standard_webhooks',
        secretRefs: ['sec-1'],
        filter: [],
        routines: [TRIGGER_ID],
        revision: 1,
        owner: 'U0DANA',
        purpose: 'Meeting recordings',
      },
      1000,
    );
    setInputServices({
      store,
      secrets: {
        create: () => Promise.reject(new Error('unused')),
        read: () => Promise.reject(new Error('unused')),
        remove: () => Promise.reject(new Error('unused')),
      },
    });
  });
  afterEach(() => {
    setInputServices(null);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('cannot be named by a new proposal', async () => {
    const out = await call('propose_trigger', makeTask(), proposal([ON_EVENT]));

    expect(out).toMatch(/Could not create the trigger: that input already belongs to a routine/);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('cannot be taken over by another routine through an edit', async () => {
    loadTrigger.mockResolvedValue(routine({ id: OTHER_TRIGGER, conditions: [] }));

    const out = await call('update_trigger', makeTask(), {
      id: OTHER_TRIGGER,
      conditions: [ON_EVENT],
    });

    expect(out).toMatch(/Could not update the trigger: that input already belongs to a routine/);
  });

  it('can still be named by its own routine in an edit', async () => {
    loadTrigger.mockResolvedValue(routine());

    const out = await call('update_trigger', makeTask(), {
      id: TRIGGER_ID,
      conditions: [{ ...ON_EVENT, event_filter: [ENDED] }],
    });

    expect(out).not.toMatch(/already belongs to a routine/);
  });
});
