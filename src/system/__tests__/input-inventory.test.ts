// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../shutdown.js', () => ({ getIsShuttingDown: () => false }));

import { IncomingStore, type MatchedConsumer } from '../../incoming/store.js';
import type { Input } from '../../incoming/types.js';
import type { TaskMetadata } from '../../types/task.js';
import type { Trigger } from '../../types/trigger.js';
import {
  describeInputHistory,
  describeInputs,
  HISTORY_LIMIT,
  listInputs,
  type InventoryLookups,
} from '../input-inventory.js';
import { triggerVisibleFrom, type TriggerOrigin } from '../trigger-visibility.js';

const MEETINGS = 'inp-MEETINGSAAAAAAAAAAAAAA';
const LEADS_INPUT = 'inp-LEADSAAAAAAAAAAAAAAAAA';
const NO_ROUTINE = 'inp-NOROUTINEAAAAAAAAAAAAA';
const OPERATOR_MADE = 'inp-OPERATORAAAAAAAAAAAAAA';
const NOTES = 'trg-20261124-0900-notes1';
const LEADS = 'trg-20261124-0900-leads1';
const NOW = Date.UTC(2026, 10, 25, 12, 0);
const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 24, hour, minute);

const DANA_DM: TriggerOrigin = { kind: 'dm', userId: 'U0DANA', channelId: 'D0DANA' };
const EVE_DM: TriggerOrigin = { kind: 'dm', userId: 'U0EVE', channelId: 'D0EVE' };
const GENERAL: TriggerOrigin = { kind: 'channel', channelId: 'C0GENERAL' };
const LEADS_CHANNEL: TriggerOrigin = { kind: 'channel', channelId: 'C0LEADS' };
const OPERATOR: TriggerOrigin = { kind: 'operator' };

function input(id: string, over: Partial<Input> = {}): Input {
  return {
    id,
    state: 'enabled',
    auth: 'standard_webhooks',
    secretRefs: ['sec-1'],
    filter: [],
    routines: [],
    revision: 1,
    owner: 'U0DANA',
    purpose: 'Meeting recordings',
    ...over,
  };
}

function routine(id: string, over: Partial<Trigger> = {}): Trigger {
  return {
    id,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-24T09:00:00.000Z',
    approved_by: 'U0DANA',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [{ type: 'incoming_event', input_id: MEETINGS }],
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
}

let root: string;
let store: IncomingStore;
let routines: Map<string, Trigger>;
let tasks: Map<string, Pick<TaskMetadata, 'status' | 'default_channel' | 'channels'>>;
let deliveries: number;

function lookupsFrom(origin: TriggerOrigin): InventoryLookups {
  return {
    loadTrigger: (id) => Promise.resolve(routines.get(id) ?? null),
    visible: (shown) =>
      triggerVisibleFrom(shown, origin, (channel) => Promise.resolve(channel === 'C0LEADS')),
    task: (id) => Promise.resolve(tasks.get(id) ?? null),
  };
}

const listFrom = async (origin: TriggerOrigin) =>
  describeInputs(await listInputs({ store, secrets: unusedVault }, origin, lookupsFrom(origin)));

const historyFrom = (origin: TriggerOrigin, inputId = MEETINGS) =>
  describeInputHistory({ store, secrets: unusedVault }, inputId, origin, lookupsFrom(origin));

const unusedVault = {
  create: () => Promise.reject(new Error('unused')),
  read: () => Promise.reject(new Error('unused')),
  remove: () => Promise.reject(new Error('unused')),
};

const forRoutine = (id: string): MatchedConsumer => ({
  kind: 'routine',
  consumerId: id,
  snapshot: '{}',
});

function deliver(receivedAt: number, consumers: MatchedConsumer[], inputId = MEETINGS): void {
  deliveries += 1;
  store.receive(
    {
      inputId,
      binding: 'generic',
      eventKey: `msg_${deliveries}`,
      digest: `d${deliveries}`,
      body: Buffer.from('{}'),
      receivedAt,
    },
    consumers,
  );
}

function finish(state: 'accepted' | 'skipped' | 'failed', reason?: string, taskId?: string): void {
  const claimed = store.claimHandoff(NOW, 60_000);
  if (!claimed) throw new Error('No handoff was waiting');
  if (taskId)
    store.saveReservation(claimed.handoff.id, claimed.token, JSON.stringify({ task_id: taskId }));
  store.finishHandoff(claimed.handoff.id, claimed.token, state, reason ?? null);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-input-inventory-'));
  store = new IncomingStore(join(root, 'state.sqlite'));
  deliveries = 0;
  tasks = new Map();
  routines = new Map([
    [NOTES, routine(NOTES)],
    [
      LEADS,
      routine(LEADS, {
        status: 'paused',
        binding: { type: 'channel', channel_id: 'C0LEADS', channel_name: 'leads' },
        summary: 'Lead alerts',
      }),
    ],
  ]);
  store.insertInput(input(MEETINGS, { routines: [NOTES] }), at(8));
  store.insertInput(input(LEADS_INPUT, { routines: [LEADS], purpose: 'Lead forms' }), at(8));
  store.insertInput(input(NO_ROUTINE, { purpose: 'Deploys', auth: 'bearer' }), at(8));
  store.insertInput(input(OPERATOR_MADE, { owner: null, purpose: '' }), at(8));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the inventory', () => {
  it('shows the owner every input of theirs in their own DM, also one nothing takes events from', async () => {
    deliver(at(9), []);

    expect(await listFrom(DANA_DM)).toBe(
      [
        'Inputs visible here (3):',
        `• [${MEETINGS}] “Meeting recordings” — enabled, signed, owned by <@U0DANA>; last delivery 2026-11-24 09:00 UTC`,
        `    routine [${NOTES}] (enabled) “Meeting notes” — delivers to #notes`,
        `• [${LEADS_INPUT}] “Lead forms” — enabled, signed, owned by <@U0DANA>; no delivery on record`,
        `    routine [${LEADS}] (paused) “Lead alerts” — delivers to #leads`,
        `• [${NO_ROUTINE}] “Deploys” — enabled, bearer, owned by <@U0DANA>; no delivery on record`,
        '    nothing takes its events yet',
      ].join('\n'),
    );
  });

  it('lists from another conversation only an input whose routine is visible there', async () => {
    const listed = await listFrom(GENERAL);

    expect(listed).toContain('Inputs visible here (1):');
    expect(listed).toContain(`routine [${NOTES}] (enabled) “Meeting notes”`);
    expect(listed).not.toContain('Lead');
    expect(listed).not.toContain(LEADS_INPUT);
    expect(listed).not.toContain(NO_ROUTINE);
  });

  it("lists a private channel's input from that channel", async () => {
    const listed = await listFrom(LEADS_CHANNEL);

    expect(listed).toContain('Inputs visible here (2):');
    expect(listed).toContain(`routine [${LEADS}] (paused) “Lead alerts” — delivers to #leads`);
    expect(listed).toContain(`routine [${NOTES}]`);
  });

  it("gives another person's DM no more than a channel would get", async () => {
    const listed = await listFrom(EVE_DM);

    expect(listed).toContain(`routine [${NOTES}]`);
    expect(listed).not.toContain('Lead');
    expect(listed).not.toContain(NO_ROUTINE);
  });

  it('shows the operator every input, including one nothing takes events from', async () => {
    const listed = await listFrom(OPERATOR);

    expect(listed).toContain('Inputs visible here (4):');
    expect(listed).toContain(
      `• [${OPERATOR_MADE}] (no purpose set) — enabled, signed, managed by the operator; no delivery on record\n    nothing takes its events yet`,
    );
  });

  it('marks a linked routine that no longer exists, for those who see every input', async () => {
    routines.delete(LEADS);

    expect(await listFrom(DANA_DM)).toContain(`routine [${LEADS}] (no longer exists)`);
    expect(await listFrom(LEADS_CHANNEL)).not.toContain(LEADS_INPUT);
  });

  it('leaves out a deleted input', async () => {
    store.markInputDeleted(NO_ROUTINE);

    expect(await listFrom(DANA_DM)).not.toContain(NO_ROUTINE);
  });

  it('says so when nothing is visible', async () => {
    routines.clear();

    expect(await listFrom(GENERAL)).toBe('There are no incoming events inputs visible from here.');
  });
});

describe('the history of an input', () => {
  function everyOutcome(): void {
    deliver(at(9, 0), []);
    store.pauseInput(MEETINGS);
    deliver(at(9, 5), [forRoutine(NOTES)]);
    store.resumeInput(MEETINGS);

    deliver(at(9, 10), [forRoutine(NOTES)]);
    finish('skipped', 'routine_paused');

    deliver(at(9, 15), [forRoutine(NOTES)]);
    finish('failed', 'attempts_exhausted', 'task-uncertain');
    tasks.set('task-uncertain', { status: 'completed', default_channel: null, channels: {} });

    deliver(at(9, 20), [forRoutine(NOTES)]);
    finish('accepted', undefined, 'task-quiet');
    tasks.set('task-quiet', { status: 'in_progress', default_channel: null, channels: {} });

    deliver(at(9, 25), [forRoutine(NOTES)]);
    finish('accepted', undefined, 'task-posted');
    tasks.set('task-posted', {
      status: 'completed',
      default_channel: 'C0NOTES',
      channels: {
        C0NOTES: {
          type: 'slack',
          thread_id: '1795530309.733459',
          channel_id: 'C0NOTES',
          channel_name: 'notes',
          last_processed_ts: '1795530309.733459',
          url: 'https://example.slack.com/archives/C0NOTES/p1795530309733459',
        },
      },
    });

    // Left waiting, so it is made last: a claim takes the oldest waiting handoff.
    deliver(at(9, 35), [forRoutine(NOTES)]);
  }

  it("tells the outcomes apart in the owner's DM", async () => {
    everyOutcome();
    const notes = `[${NOTES}] “Meeting notes”`;

    expect(await historyFrom(DANA_DM)).toBe(
      [
        `History of input [${MEETINGS}] “Meeting recordings”, newest first. Deliveries stay on record for 30 days. No event content is kept.`,
        `• 2026-11-24 09:35 UTC — received: ${notes} has not started yet`,
        `• 2026-11-24 09:25 UTC — delivered: ${notes} ran as task-posted and posted in its conversation — https://example.slack.com/archives/C0NOTES/p1795530309733459`,
        `• 2026-11-24 09:20 UTC — handed off: ${notes} started task-quiet (in_progress); it has not posted yet`,
        `• 2026-11-24 09:15 UTC — uncertain: ${notes} was not recorded as started (starting it failed too many times), yet task-uncertain exists (completed)`,
        `• 2026-11-24 09:10 UTC — skipped: ${notes} did not run — the routine was paused`,
        '• 2026-11-24 09:05 UTC — skipped: the input was paused',
        '• 2026-11-24 09:00 UTC — skipped: a filter excluded it, or no routine was taking events',
      ].join('\n'),
    );
  });

  it('calls a run skipped when its Task was prepared and never started', async () => {
    deliver(at(9, 15), [forRoutine(NOTES)]);
    finish('failed', 'interrupted', 'task-prepared');
    tasks.set('task-prepared', { status: 'preparing', default_channel: null, channels: {} });

    expect(await historyFrom(DANA_DM)).toContain('skipped: ');
    expect(await historyFrom(DANA_DM)).not.toContain('uncertain');
  });

  it("reads a private channel's input from that channel, and refuses it elsewhere", async () => {
    deliver(at(9), [forRoutine(LEADS)], LEADS_INPUT);
    finish('skipped', 'routine_paused');

    expect(await historyFrom(LEADS_CHANNEL, LEADS_INPUT)).toContain(
      `• 2026-11-24 09:00 UTC — skipped: [${LEADS}] “Lead alerts” did not run — the routine was paused`,
    );
    expect(await historyFrom(GENERAL, LEADS_INPUT)).toBe(
      `Input ${LEADS_INPUT} isn't visible from here, so its history can't be read from this conversation.`,
    );
  });

  it('shows a reason it has no words for as recorded', async () => {
    deliver(at(9), [forRoutine(NOTES)]);
    finish('skipped', 'something_new');

    expect(await historyFrom(DANA_DM)).toContain('did not run — something_new');
  });

  it("reports only routines' handoffs", async () => {
    deliver(at(9), [{ kind: 'proactivity', consumerId: 'digest', snapshot: '{}' }], NO_ROUTINE);

    const shown = await historyFrom(DANA_DM, NO_ROUTINE);

    expect(shown).toContain('• 2026-11-24 09:00 UTC — received');
    expect(shown).not.toContain('proactivity');
  });

  it('refuses an input with no routine visible from here', async () => {
    deliver(at(9), [], NO_ROUTINE);

    expect(await historyFrom(GENERAL, NO_ROUTINE)).toBe(
      `Input ${NO_ROUTINE} isn't visible from here, so its history can't be read from this conversation.`,
    );
  });

  it('says when an input is unknown or has nothing on record', async () => {
    expect(await historyFrom(DANA_DM, 'inp-NOSUCHAAAAAAAAAAAAAAAA')).toBe(
      'No input inp-NOSUCHAAAAAAAAAAAAAAAA found.',
    );
    expect(await historyFrom(DANA_DM)).toBe(
      `Input [${MEETINGS}] “Meeting recordings” has no delivery on record. Deliveries stay on record for 30 days. No event content is kept.`,
    );
  });

  it('shows the newest deliveries only and says so', async () => {
    for (let minute = 0; minute <= HISTORY_LIMIT; minute += 1) deliver(at(9) + minute * 1000, []);

    const shown = await historyFrom(DANA_DM);

    expect(shown.split('\n').filter((line) => line.startsWith('•'))).toHaveLength(HISTORY_LIMIT);
    expect(shown).toContain(`Showing the newest ${HISTORY_LIMIT}.`);
  });
});
