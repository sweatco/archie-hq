// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InitiativeStore } from '../store.js';
import { InitiativeService } from '../service.js';
import { ObservationRecall } from '../recall.js';
import type { BackgroundModel } from '../model.js';
import type { ObservationSlack } from '../slack.js';
import type { Matter } from '../types.js';
import type { TaskMetadata } from '../../types/task.js';
import { expectDefined } from '../../test-support/assertions.js';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const DAY = 86_400_000;
let store: InitiativeStore;
let slack: ObservationSlack;
let model: BackgroundModel;
let service: InitiativeService;

function matter(id: string, owner: string | null, age = 0, channel = 'C1'): Matter {
  store.channel(channel, true, false);
  const thread = `${(NOW - age) / 1000}.${id.charCodeAt(0).toString().padStart(6, '0')}`;
  const evidence = expectDefined(
    store.record(
      {
        channel,
        thread,
        ts: thread,
        version: thread,
        author: owner ?? 'U_AUTHOR',
        text: `${id}: I will prepare the release checklist.`,
      },
      NOW - age,
    ),
  );
  const value: Matter = {
    id,
    channel,
    thread,
    title: id,
    detail: `Prepare ${id}`,
    evidence: [evidence],
    owner,
    state: 'open',
    deadline: null,
    explicit: true,
    valid: true,
    nextCheck: NOW,
  };
  store.apply(
    [expectDefined(store.snapshot(channel, thread))],
    [{ id, channel, thread, text: `Release ${id}`, evidence: [evidence], kind: 'commitment' }],
    [value],
  );
  return value;
}

beforeEach(() => {
  store = new InitiativeStore(':memory:', 'T1', NOW - 10 * DAY);
  slack = {
    inspect: vi.fn<ObservationSlack['inspect']>(async (_channel, recipient) => ({
      shared: false,
      recipientCanRead: recipient !== 'U_BLOCKED',
    })),
    channels: async () => ['C1'],
    page: vi.fn<ObservationSlack['page']>(async (channel, _oldest, _latest, _cursor, thread) => ({
      messages: store.snapshot(channel, expectDefined(thread))?.evidence ?? [],
    })),
    dm: vi.fn<ObservationSlack['dm']>(async (user) => `D_${user}`),
    recipient: vi.fn<ObservationSlack['recipient']>(async (channel) =>
      channel.startsWith('D_') ? channel.slice(2) : null,
    ),
    verifyDm: vi.fn<ObservationSlack['verifyDm']>(async (channel, user) => channel === `D_${user}`),
    send: vi.fn<ObservationSlack['send']>(
      async (delivery) => `${NOW / 1000}.${delivery.id.length}`,
    ),
    find: async () => undefined,
    active: () => false,
    link: (channel, thread) => `https://slack.test/${channel}/${thread}`,
  };
  model = {
    complete: vi.fn(async (request: Parameters<BackgroundModel['complete']>[0]) => {
      const current = (request.input as { matter: Matter }).matter;
      return {
        resolved: false,
        help: `I can prepare ${current.title}.`,
        public: false,
        evidence: current.evidence,
      };
    }) as BackgroundModel['complete'],
  };
  service = new InitiativeService(
    store,
    slack,
    model,
    { mode: 'live', extractionModel: 'haiku', investigationModel: 'sonnet' },
    () => NOW,
  );
});
afterEach(() => {
  service.stop();
  store.close();
});

it('routes nudges and digests to two responsible employees, never the administrator by default', async () => {
  for (const [id, owner] of [
    ['alpha', 'U_ALICE'],
    ['bravo', 'U_BOB'],
  ] as const) {
    matter(id, owner);
    store.schedule('investigate', id, NOW);
  }
  await service.tick(NOW, true);
  expect(
    store
      .deliveries('sent')
      .map((delivery) => [delivery.channel, delivery.recipient, delivery.matters]),
  ).toEqual([
    ['D_U_ALICE', 'U_ALICE', ['alpha']],
    ['D_U_BOB', 'U_BOB', ['bravo']],
  ]);
  store.schedule('digest', 'global', NOW);
  await service.tick(NOW, true);
  const digests = store.deliveries('sent').filter((delivery) => delivery.digest);
  expect(digests.map((delivery) => [delivery.channel, delivery.matters])).toEqual([
    ['D_U_ALICE', ['alpha']],
    ['D_U_BOB', ['bravo']],
  ]);
  expect(digests[0].text).not.toContain('bravo');
  expect(digests[1].text).not.toContain('alpha');
  expect(slack.dm).not.toHaveBeenCalledWith('U_ADMIN');
});

it('reserves two interventions and one digest per destination while retaining the global financial cap', async () => {
  for (const [id, owner] of [
    ['a', 'U_ALICE'],
    ['b', 'U_ALICE'],
    ['c', 'U_ALICE'],
    ['d', 'U_BOB'],
    ['e', 'U_BOB'],
    ['f', 'U_BOB'],
  ] as const) {
    matter(id, owner);
    store.schedule('investigate', id, NOW);
  }
  await service.tick(NOW, true);
  expect(
    store.deliveries('sent').filter((delivery) => delivery.recipient === 'U_ALICE'),
  ).toHaveLength(2);
  expect(
    store.deliveries('sent').filter((delivery) => delivery.recipient === 'U_BOB'),
  ).toHaveLength(2);
  store.schedule('digest', 'global', NOW);
  await service.tick(NOW, true);
  store.schedule('digest', 'global', NOW);
  await service.tick(NOW, true);
  expect(store.deliveries('sent').filter((delivery) => delivery.digest)).toHaveLength(2);
  expect(store.reserve(200_000_000, true, NOW)).toBeTruthy();
  expect(store.reserve(1, true, NOW)).toBeNull();
});

it.each([null, 'U_BLOCKED'])(
  'keeps private help silent for unknown or inaccessible responsibility: %s',
  async (owner) => {
    matter('alpha', owner);
    store.schedule('investigate', 'alpha', NOW);
    store.schedule('digest', 'global', NOW);
    await service.tick(NOW, true);
    expect(slack.dm).not.toHaveBeenCalled();
    expect(slack.send).not.toHaveBeenCalled();
  },
);

it.each([null, 'U_ALICE', 'U_BLOCKED'])(
  'sends public help with no recipient or employee lookup: owner=%s',
  async (owner) => {
    const current = matter('alpha', owner, 5 * DAY);
    vi.mocked(model.complete).mockResolvedValue({
      resolved: false,
      help: 'Here is a useful checklist.',
      public: true,
      evidence: current.evidence,
    });
    store.schedule('investigate', current.id, NOW);
    await service.tick(NOW, true);
    expect(store.deliveries('sent')).toMatchObject([
      { channel: 'C1', thread: current.thread, recipient: null },
    ]);
    expect(slack.dm).not.toHaveBeenCalled();
    expect(
      vi.mocked(slack.inspect).mock.calls.every(([, recipient]) => recipient === undefined),
    ).toBe(true);
  },
);

it.each(['unavailable', 'missing', 'denied'])(
  'preserves public help when an optional private suggestion lookup is %s',
  async (failure) => {
    const current = matter('alpha', 'U_ALICE', 5 * DAY);
    service.config.repositories = ['owner/repo'];
    vi.mocked(slack.inspect).mockImplementation(async (_channel, recipient) => {
      if (!recipient) return { shared: false, recipientCanRead: false };
      if (failure === 'unavailable') throw new Error('Employee lookup unavailable');
      return failure === 'missing' ? null : { shared: false, recipientCanRead: false };
    });
    vi.mocked(model.complete).mockResolvedValue({
      resolved: false,
      help: 'Here is a useful checklist.',
      public: true,
      evidence: current.evidence,
      suggestion: {
        repository: 'owner/repo',
        outcome: 'Prepare the checklist',
        evidence: current.evidence,
      },
    });
    store.schedule('investigate', current.id, NOW);
    await service.tick(NOW, true);
    expect(slack.inspect).toHaveBeenCalledWith('C1', 'U_ALICE');
    expect(store.matter(current.id)?.valid).toBe(true);
    expect(store.attention.channelProgress('C1')?.allowed).toBe(1);
    expect(store.listProposals()).toEqual([]);
    expect(store.deliveries('sent')).toMatchObject([
      { channel: 'C1', thread: current.thread, recipient: null },
    ]);
    expect(slack.dm).not.toHaveBeenCalled();
  },
);

it('sends a pending public reply after responsibility changes', async () => {
  const current = matter('alpha', 'U_ALICE', 5 * DAY);
  store.enqueueDelivery({
    id: 'public',
    channel: 'C1',
    thread: current.thread,
    text: 'Useful public help',
    matters: [current.id],
    recipient: null,
    evidence: current.evidence,
    digest: false,
    state: 'pending',
    ts: null,
    created: NOW,
  });
  store.attention.saveMatter({ ...current, owner: 'U_BOB' });
  await service.deliver(NOW);
  expect(store.delivery('public')).toMatchObject({ state: 'sent', recipient: null });
  expect(slack.dm).not.toHaveBeenCalled();
});

it('uses the existing priority reserve for every investigation, including non-admin and unowned matters', async () => {
  for (const [id, owner] of [
    ['alpha', 'U_ALICE'],
    ['bravo', null],
  ] as const) {
    matter(id, owner);
    store.schedule('investigate', id, NOW);
  }
  await service.tick(NOW, true);
  expect(vi.mocked(model.complete).mock.calls.map(([request]) => request.priority)).toEqual([
    true,
    true,
  ]);
  expect(store.reserve(150_000_000, false, NOW)).toBeTruthy();
  expect(store.reserve(1, false, NOW)).toBeNull();
  expect(store.reserve(50_000_000, true, NOW)).toBeTruthy();
  expect(store.reserve(1, true, NOW)).toBeNull();
});

it('limits recall to the actual DM recipient, owned matters and currently readable source channels', async () => {
  matter('alpha', 'U_ALICE');
  matter('bravo', 'U_BOB');
  matter('charlie', 'U_BLOCKED', 0, 'C2');
  const recall = new ObservationRecall(store, slack);
  const metadata = (user: string) =>
    ({ memory_destination: { channel_id: `D_${user}` } }) as TaskMetadata;
  expect(await recall.read(metadata('U_ALICE'), 'matters')).toMatchObject([{ id: 'alpha' }]);
  expect(await recall.read(metadata('U_ALICE'), 'matter', 'bravo')).toBe('Matter unavailable.');
  vi.mocked(slack.inspect).mockImplementation(async (channel, recipient) => ({
    shared: false,
    recipientCanRead: !(channel === 'C2' && recipient === 'U_ALICE'),
  }));
  expect(await recall.search(metadata('U_ALICE'), 'Release', 10)).toHaveLength(2);
  expect(slack.inspect).toHaveBeenCalledWith('C2', 'U_ALICE');
  const forged = { ...metadata('U_BOB'), approved_start: { actor: 'U_ALICE' } } as TaskMetadata;
  expect(await recall.search(forged, 'Release', 10)).toEqual([]);
});

it('cancels an unsent nudge after ownership changes instead of transferring its recipient', async () => {
  const current = matter('alpha', 'U_ALICE');
  service.config.mode = 'shadow';
  store.schedule('investigate', current.id, NOW);
  await service.tick(NOW, true);
  const delivery = store.deliveries('pending')[0];
  store.attention.saveMatter({ ...current, owner: 'U_BOB' });
  service.config.mode = 'live';
  await service.deliver(NOW);
  expect(store.delivery(delivery.id)).toMatchObject({ recipient: 'U_ALICE', state: 'cancelled' });
  expect(slack.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  'deduplicates within the intended private recipient or public thread after responsibility changes: public=%s',
  async (publicReply) => {
    const current = matter('alpha', 'U_ALICE', publicReply ? 5 * DAY : 0);
    vi.mocked(model.complete).mockResolvedValue({
      resolved: false,
      help: 'Here is useful help.',
      public: publicReply,
      evidence: current.evidence,
    });
    store.schedule('investigate', current.id, NOW);
    await service.tick(NOW, true);
    store.attention.saveMatter({ ...expectDefined(store.matter(current.id)), owner: 'U_BOB' });
    store.attention.setNextCheck(NOW, current.id);
    store.schedule('investigate', current.id, NOW);
    await service.tick(NOW, true);
    expect(store.deliveries('sent').map((delivery) => delivery.channel)).toEqual(
      publicReply ? ['C1'] : ['D_U_ALICE', 'D_U_BOB'],
    );
  },
);

it.each(['U_ADMIN', 'Alice'])(
  'does not turn an administrator ID or a display name invented by extraction into responsibility: %s',
  async (owner) => {
    store.channel('C1', true, false);
    const thread = `${NOW / 1000}.000001`;
    const evidence = expectDefined(
      store.record(
        {
          channel: 'C1',
          thread,
          ts: thread,
          version: thread,
          author: 'U_ALICE',
          text: 'I will prepare the checklist.',
        },
        NOW,
      ),
    );
    vi.mocked(model.complete).mockResolvedValueOnce({
      threads: [
        {
          channel: 'C1',
          thread,
          observations: [],
          matters: [
            {
              key: 'alpha',
              title: 'Checklist',
              detail: 'Prepare checklist',
              evidence: [evidence],
              state: 'open',
              owner,
              deadline: null,
              explicit: true,
            },
          ],
        },
      ],
    });
    store.schedule('extract', 'global', NOW);
    await service.tick(NOW, true);
    expect(store.matters()[0]?.owner).toBeNull();
    expect(slack.dm).not.toHaveBeenCalled();
  },
);
