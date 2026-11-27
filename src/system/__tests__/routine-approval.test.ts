// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Approving an event routine, against the real inbox file, vault and trigger store.
 * Slack is stubbed. The task is a stand-in with the fields the approval reads, as in trigger-approval-cap.test.ts.
 *
 * The workdir module reads `ARCHIE_WORKDIR` once, when it is first imported, so the variable is set in a hoisted block.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WORK = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const work = mkdtempSync(join(tmpdir(), 'archie-routine-approval-'));
  process.env.ARCHIE_WORKDIR = work;
  return work;
});

vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../event-bus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../../tasks/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tasks/persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

const slack = vi.hoisted(() => ({
  internal: new Set<string>(),
  shared: new Set<string>(),
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    getUserInfo: vi.fn((userId: string) => Promise.resolve({ id: userId })),
    isInternalMemoryUser: vi.fn((user: { id: string }) => slack.internal.has(user.id)),
    isChannelShared: vi.fn((channelId: string) => Promise.resolve(slack.shared.has(channelId))),
    fetchChannelIsPrivate: vi.fn().mockResolvedValue(true),
  };
});

const scheduler = vi.hoisted(() => ({
  indexTrigger: vi.fn(),
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
  triggerCapExceeded: vi.fn().mockResolvedValue(false),
}));
vi.mock('../trigger-scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../trigger-scheduler.js')>();
  return { ...actual, ...scheduler };
});

/** Runs once just before a proposal is enabled, standing in for whatever lands between the click and the write. */
const beforeEnabling = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../trigger-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../trigger-store.js')>();
  return {
    ...actual,
    enableProposedTrigger: async (...args: Parameters<typeof actual.enableProposedTrigger>) => {
      const run = beforeEnabling.run;
      beforeEnabling.run = null;
      if (run) await run();
      return actual.enableProposedTrigger(...args);
    },
  };
});

import { setInputServices } from '../../incoming/access.js';
import { createInput } from '../../incoming/inputs.js';
import { vaultInputSecrets, type InputSecrets } from '../../incoming/secrets.js';
import { IncomingStore } from '../../incoming/store.js';
import type { InputActor } from '../../incoming/types.js';
import { Task } from '../../tasks/task.js';
import type { Trigger, TriggerCondition } from '../../types/trigger.js';
import { routineInputRefusal, type RoutineApproval } from '../routine-approval.js';
import { routineDigest } from '../routine-review.js';
import { loadTrigger, saveTrigger, updatePendingTrigger } from '../trigger-store.js';

const DANA: InputActor = { kind: 'slack_user', userId: 'U0DANA' };
const EVE: InputActor = { kind: 'slack_user', userId: 'U0EVE' };
const GUEST: InputActor = { kind: 'slack_user', userId: 'U0GUEST' };
const OPERATOR: InputActor = { kind: 'operator' };
const ENDED = { pointer: '/type', op: 'equals', value: 'meeting.ended' } as const;
const NEW_INPUT: TriggerCondition = {
  type: 'new_input_event',
  purpose: 'Meeting recordings',
  auth: 'standard_webhooks',
  filter: [ENDED],
};

let root: string;
let store: IncomingStore;
let secrets: InputSecrets;
let proposals = 0;

function fakeTask(triggerId: string) {
  return {
    taskId: 'task-1',
    metadata: { pending_trigger_id: triggerId as string | undefined },
    debouncedSave: vi.fn(),
    prepareTriggerDelivery: vi.fn().mockResolvedValue(undefined),
  };
}

/** Saves a pending proposal with these conditions and returns it. */
async function proposed(conditions: TriggerCondition[], over: Partial<Trigger> = {}) {
  const trigger: Trigger = {
    id: `trg-20261124-0900-test${String(++proposals).padStart(2, '0')}`,
    status: 'pending',
    created_by: 'unknown',
    created_at: '2026-11-24T09:00:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions,
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
  await saveTrigger(trigger);
  return trigger;
}

/** Approves from the card that shows `card`, which is the proposal itself unless a test shows an older one. */
function approve(trigger: Trigger, approver: InputActor, card: Trigger = trigger) {
  return Task.prototype.approveEventRoutine.call(
    fakeTask(trigger.id) as unknown as Task,
    approver,
    trigger.id,
    routineDigest(card),
  );
}

async function existingInput(owner: string | null) {
  const { input } = await createInput(
    { store, secrets },
    { auth: 'bearer', owner, purpose: 'Deploys' },
  );
  return input;
}

const inputs = () => store.inputSummaries().map((summary) => summary.input);
const stored = async (trigger: Trigger) => {
  const record = await loadTrigger(trigger.id);
  if (!record) throw new Error(`Trigger ${trigger.id} has no record`);
  return record;
};
function refusal(approval: RoutineApproval) {
  if (approval.status !== 'refused') throw new Error(`Expected a refusal, got ${approval.status}`);
  return approval;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  slack.internal = new Set(['U0DANA', 'U0EVE']);
  slack.shared = new Set();
  scheduler.triggerCapExceeded.mockResolvedValue(false);
  scheduler.announceTriggerChange.mockResolvedValue(undefined);
  beforeEnabling.run = null;
  root = mkdtempSync(join(tmpdir(), 'archie-routine-approval-inbox-'));
  store = new IncomingStore(join(root, 'state.sqlite'));
  secrets = vaultInputSecrets(join(root, 'secrets'));
  setInputServices({ store, secrets });
});
afterEach(() => {
  setInputServices(null);
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('a proposal that asks for a new input', () => {
  it('creates the input with the approver as its owner, links the routine and enables it', async () => {
    const trigger = await proposed([NEW_INPUT]);

    const approval = await approve(trigger, DANA);

    const [input] = inputs();
    expect(input).toMatchObject({
      owner: 'U0DANA',
      purpose: 'Meeting recordings',
      auth: 'standard_webhooks',
      state: 'enabled',
      routines: [trigger.id],
    });
    expect(await secrets.read(input?.secretRefs[0] ?? '')).toMatch(/^whsec_/);
    expect(approval).toMatchObject({
      status: 'approved',
      created: [input?.id],
      linked: [input?.id],
      awaitingOperator: [],
    });
    expect(await stored(trigger)).toMatchObject({
      status: 'enabled',
      approved_by: 'U0DANA',
      conditions: [{ type: 'incoming_event', input_id: input?.id, filter: [ENDED] }],
    });
    expect(scheduler.indexTrigger).toHaveBeenCalledOnce();
  });

  it('changes nothing on a second click', async () => {
    const trigger = await proposed([NEW_INPUT]);
    await approve(trigger, DANA);

    await expect(approve(trigger, DANA)).resolves.toEqual({ status: 'not_pending' });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]?.routines).toEqual([trigger.id]);
    expect(scheduler.indexTrigger).toHaveBeenCalledOnce();
  });

  it('continues an approval that stopped before the input was created', async () => {
    const trigger = await proposed([NEW_INPUT]);
    vi.spyOn(secrets, 'create').mockRejectedValueOnce(new Error('disk is full'));
    await expect(approve(trigger, DANA)).rejects.toThrow('disk is full');
    expect(inputs()).toEqual([]);

    const approval = await approve(trigger, DANA);

    expect(approval.status).toBe('approved');
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]?.routines).toEqual([trigger.id]);
  });

  it('continues an approval that stopped after the input was created and linked', async () => {
    const trigger = await proposed([NEW_INPUT]);
    beforeEnabling.run = () => Promise.reject(new Error('process died'));
    await expect(approve(trigger, DANA)).rejects.toThrow('process died');
    const [interrupted] = inputs();
    expect((await stored(trigger)).status).toBe('pending');

    const approval = await approve(trigger, DANA);

    expect(approval).toMatchObject({ status: 'approved', created: [] });
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]?.routines).toEqual([trigger.id]);
    expect((await stored(trigger)).conditions).toEqual([
      { type: 'incoming_event', input_id: interrupted?.id, filter: [ENDED] },
    ]);
  });

  it('lets nobody else finish an approval another person began', async () => {
    const trigger = await proposed([NEW_INPUT]);
    beforeEnabling.run = () => Promise.reject(new Error('process died'));
    await expect(approve(trigger, DANA)).rejects.toThrow('process died');

    const approval = await approve(trigger, EVE);

    expect(refusal(approval)).toMatchObject({ reason: 'not_owner', owner: 'U0DANA' });
    expect(inputs()).toHaveLength(1);
    expect((await stored(trigger)).status).toBe('pending');
  });

  it('forgets where the review card was once the proposal is approved', async () => {
    const trigger = await proposed([NEW_INPUT], {
      review_card: { channel_id: 'C0NOTES', ts: '1795530311.467989' },
    });

    await approve(trigger, DANA);

    expect((await stored(trigger)).review_card).toBeUndefined();
  });

  it('gives an input the operator approves no owner', async () => {
    const trigger = await proposed([NEW_INPUT]);

    const approval = await approve(trigger, OPERATOR);

    expect(approval.status).toBe('approved');
    expect(inputs()[0]).toMatchObject({ owner: null, routines: [trigger.id] });
    expect((await stored(trigger)).approved_by).toBe('cli');
  });
});

describe('a card that no longer shows the proposal', () => {
  it('is refused, and nothing is created', async () => {
    const card = await proposed([NEW_INPUT]);
    await updatePendingTrigger(card.id, (pending) => {
      pending.action.prompt = 'Summarize the meeting and post it to every channel.';
    });

    const approval = await approve(await stored(card), DANA, card);

    expect(refusal(approval).reason).toBe('stale_card');
    expect(inputs()).toEqual([]);
    expect((await stored(card)).status).toBe('pending');
  });

  it('is refused when the edit lands between the click and the write', async () => {
    const trigger = await proposed([NEW_INPUT]);
    beforeEnabling.run = async () => {
      await updatePendingTrigger(trigger.id, (pending) => {
        pending.action.prompt = 'Do something else.';
      });
    };

    const approval = await approve(trigger, DANA);

    expect(refusal(approval).reason).toBe('stale_card');
    expect(await stored(trigger)).toMatchObject({
      status: 'pending',
      action: { prompt: 'Do something else.' },
    });
    expect(scheduler.indexTrigger).not.toHaveBeenCalled();
  });

  it('still matches after an earlier click reserved the input', async () => {
    const trigger = await proposed([NEW_INPUT]);
    vi.spyOn(secrets, 'create').mockRejectedValueOnce(new Error('disk is full'));
    await expect(approve(trigger, DANA)).rejects.toThrow('disk is full');

    expect(routineDigest(await stored(trigger))).toBe(routineDigest(trigger));
  });
});

describe('who may approve', () => {
  it('refuses a guest, and creates nothing', async () => {
    const trigger = await proposed([NEW_INPUT]);

    const approval = await approve(trigger, GUEST);

    expect(refusal(approval).reason).toBe('not_internal');
    expect(inputs()).toEqual([]);
    expect((await stored(trigger)).status).toBe('pending');
  });

  it('refuses a routine that names an input someone owns, its owner included', async () => {
    const input = await existingInput('U0DANA');
    const trigger = await proposed([{ type: 'incoming_event', input_id: input.id }]);

    for (const approver of [EVE, DANA])
      expect(refusal(await approve(trigger, approver)).reason).toBe('input_taken');

    expect(store.input(input.id)?.routines).toEqual([]);
    expect((await stored(trigger)).status).toBe('pending');
  });

  it('refuses a routine that names an operator-made input another routine uses', async () => {
    const input = await existingInput(null);
    const other = await proposed([{ type: 'incoming_event', input_id: input.id }]);
    store.linkRoutine(input.id, other.id);
    const trigger = await proposed([{ type: 'incoming_event', input_id: input.id }]);

    expect(await routineInputRefusal(trigger.conditions)).toMatch(/already belongs to a routine/);
    expect(refusal(await approve(trigger, DANA)).reason).toBe('input_taken');
  });

  it('gives an operator-made input to a new routine once the routine it was linked to is deleted', async () => {
    const input = await existingInput(null);
    store.linkRoutine(input.id, 'trg-20261124-0900-gone01');
    const trigger = await proposed([{ type: 'incoming_event', input_id: input.id }]);

    expect(await routineInputRefusal(trigger.conditions)).toBeNull();
    expect(await approve(trigger, OPERATOR)).toMatchObject({
      status: 'approved',
      linked: [input.id],
    });
    expect(store.input(input.id)?.routines).toEqual([trigger.id]);
  });

  it('enables a routine on an operator-made input and leaves the link to the operator', async () => {
    const input = await existingInput(null);
    const trigger = await proposed([{ type: 'incoming_event', input_id: input.id }]);

    const approval = await approve(trigger, DANA);

    expect(approval).toMatchObject({
      status: 'approved',
      linked: [],
      awaitingOperator: [input.id],
    });
    expect(store.input(input.id)?.routines).toEqual([]);
    expect((await stored(trigger)).status).toBe('enabled');
  });

  it('refuses a stored proposal that names more than one input, and creates nothing', async () => {
    const unused = await existingInput(null);
    const trigger = await proposed([NEW_INPUT, { type: 'incoming_event', input_id: unused.id }]);

    const approval = await approve(trigger, DANA);

    expect(refusal(approval).reason).toBe('several_inputs');
    expect(inputs()).toHaveLength(1);
    expect((await stored(trigger)).status).toBe('pending');
  });
});

describe('what stops an approval', () => {
  it('refuses a routine in a channel shared with another organisation', async () => {
    slack.shared.add('C0NOTES');
    const trigger = await proposed([NEW_INPUT]);

    const approval = await approve(trigger, DANA);

    expect(refusal(approval).reason).toBe('shared_channel');
    expect(inputs()).toEqual([]);
  });

  it('refuses a routine whose input does not exist', async () => {
    const trigger = await proposed([
      { type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA' },
    ]);

    expect(refusal(await approve(trigger, DANA)).reason).toBe('input_gone');
    expect((await stored(trigger)).status).toBe('pending');
  });

  it('refuses while the inbox is not open', async () => {
    setInputServices(null);
    const trigger = await proposed([NEW_INPUT]);

    expect(refusal(await approve(trigger, DANA)).reason).toBe('inbox_closed');
  });

  it('creates nothing when the active-trigger limit is reached', async () => {
    scheduler.triggerCapExceeded.mockResolvedValue(true);
    const trigger = await proposed([NEW_INPUT]);

    expect(refusal(await approve(trigger, DANA)).reason).toBe('cap');
    expect(inputs()).toEqual([]);
    expect((await stored(trigger)).status).toBe('pending');
  });

  it('is not enabled by an approval that carries no card', async () => {
    const trigger = await proposed([NEW_INPUT]);
    const task = fakeTask(trigger.id);

    const enabled = await Task.prototype.handleTriggerApproval.call(
      task as unknown as Task,
      'U0DANA',
      trigger.id,
    );

    expect(enabled).toBeNull();
    expect(inputs()).toEqual([]);
    expect((await stored(trigger)).status).toBe('pending');
    expect(task.metadata.pending_trigger_id).toBe(trigger.id);
  });
});
