// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeStore } from '../store.js';
import { ProposalHandoff } from '../handoff.js';
import { InitiativeService } from '../service.js';
import type { ApprovedTaskRuntime, PreparedTaskInput } from '../task-adapter.js';
import { taskRuntimeState } from '../task-adapter.js';
import type { ProposalSlack } from '../slack.js';
import type { TaskMetadata } from '../../types/task.js';
import { proposalVersion } from '../proposals.js';
import { SourceCollector } from '../collection.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const TS = (NOW / 1000).toFixed(6);
let root: string;
let store: InitiativeStore;
let handoff: ProposalHandoff;
let slack: ProposalSlack;
let tasks: ApprovedTaskRuntime;
let records: Map<string, TaskMetadata>;
let repositories: string[];
let proposalId: string;

function freshHandoff() {
  const collection = new SourceCollector(store, slack);
  return new ProposalHandoff(store, slack, 'U_OWNER', () => repositories, source => collection.refresh(source, Date.now()), tasks);
}

async function presented() {
  await handoff.present(NOW);
  const delivery = store.deliveries('pending')[0];
  const service = new InitiativeService(store, slack, { complete: vi.fn() }, { mode: 'live', owner: 'U_OWNER', extractionModel: 'haiku', investigationModel: 'sonnet' }, () => NOW);
  await service.deliver(NOW);
  service.stop();
  expect(store.delivery(delivery.id)?.state).toBe('sent');
  return store.delivery(delivery.id)!;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'archie-handoff-'));
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW - 60_000);
  store.set('owner', 'U_OWNER'); store.set('delivery_enabled', 'true');
  store.channel('C1', true, false);
  const evidence = store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U_AUTHOR', text: 'We need a release checklist.' }, NOW)!;
  store.apply([store.snapshot('C1', TS)!], [], [{ id: 'release', channel: 'C1', thread: TS, title: 'Release checklist', detail: 'Prepare checklist', evidence: [evidence], state: 'open', owner: null, deadline: null, explicit: true, nextCheck: NOW, valid: true }]);
  proposalId = store.proposeCapability({ repository: 'owner/repo', outcome: 'Build a release checklist', evidence: [evidence], matter: 'release' });
  repositories = ['owner/repo']; records = new Map();
  tasks = {
    prepare: vi.fn(async (input: PreparedTaskInput) => {
      if (!records.has(input.taskId)) records.set(input.taskId, { task_id: input.taskId, channels: {}, default_channel: null, status: 'preparing',
        agent_sessions: {}, repositories: [], created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
        approved_start: { correlation: input.correlation, version: input.version, actor: input.actor, budget: 'task', phase: 'prepared', brief: input.brief } });
    }),
    start: vi.fn(async id => { const metadata = records.get(id)!; metadata.status = 'in_progress'; metadata.approved_start!.phase = 'ready'; }),
    read: vi.fn(async id => records.get(id) ?? null),
  };
  slack = {
    inspect: vi.fn(async () => ({ shared: false, ownerCanRead: true })), channels: vi.fn(async () => ['C1']),
    page: vi.fn(async () => ({ messages: store.snapshot('C1', TS)?.evidence ?? [] })),
    ownerDm: vi.fn(async () => 'D_OWNER'), verifyDm: vi.fn(async channel => channel === 'D_OWNER'),
    send: vi.fn(async () => '1792490500.000001'), find: vi.fn(async () => undefined), active: vi.fn(() => false), link: (channel, ts) => `https://slack.test/${channel}/${ts}`,
    updateProposal: vi.fn(async () => {}),
  };
  handoff = freshHandoff();
});
afterEach(async () => { await handoff.drainCards(); store.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('owner-approved proposal handoff', () => {
  it('uses the ordinary outbox and spending boundary without starting a task at presentation', async () => {
    const delivery = await presented();
    expect(delivery.text).toContain('normal task budgeting');
    expect(delivery.text).toContain('outside the $200/day');
    expect(tasks.prepare).not.toHaveBeenCalled();
    expect(slack.updateProposal).not.toHaveBeenCalled();
    await handoff.present(NOW);
    expect(store.deliveries('pending')).toEqual([]);
    expect(slack.send).toHaveBeenCalledTimes(1);
    expect(store.budget(NOW)).toBe(0);
  });

  it('requires the verified owner, a sent action and the exact current proposal version', async () => {
    const delivery = await presented();
    const version = delivery.proposal!.version;
    await expect(handoff.approve('U_OTHER', delivery.id, version)).rejects.toThrow('owner');
    await expect(handoff.approve('U_OWNER', 'forged-delivery', version)).rejects.toThrow('stale');
    await expect(handoff.approve('U_OWNER', delivery.id, 'old-version')).rejects.toThrow('stale');
    repositories = [];
    await expect(handoff.approve('U_OWNER', delivery.id, version)).rejects.toThrow('scope changed');
    expect(tasks.prepare).not.toHaveBeenCalled();
  });

  it('invalidates the action when its source is edited or access changes', async () => {
    const delivery = await presented();
    store.record({ channel: 'C1', thread: TS, ts: TS, version: (NOW / 1000 + 1).toFixed(6), author: 'U_AUTHOR', text: 'Cancelled.' }, NOW);
    await expect(handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version)).rejects.toThrow('evidence');
    expect(tasks.prepare).not.toHaveBeenCalled();
  });

  it('creates one correlated ordinary task for concurrent clicks and records approval before preparation', async () => {
    const delivery = await presented();
    await Promise.all([handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version), handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version)]);
    expect(records.size).toBe(1);
    expect(tasks.start).toHaveBeenCalledTimes(1);
    const record = store.handoff(proposalId)!;
    expect(record).toMatchObject({ actor: 'U_OWNER', budget: 'task', state: 'activated', version: proposalVersion(store.proposal(proposalId)!) });
    expect(vi.mocked(tasks.prepare).mock.calls[0][0]).toMatchObject({ taskId: record.task, destination: { channel: 'D_OWNER', thread: delivery.ts } });
    expect(vi.mocked(tasks.prepare).mock.calls[0][0].brief).toContain('untrusted="true"');
    expect(store.pendingProposalCount(NOW)).toBe(0);
  });

  it('consumes the original card after durable approval without letting a delayed Starting edit block activation or overwrite it', async () => {
    const delivery = await presented();
    let release!: () => void;
    const slowEdit = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(slack.updateProposal).mockImplementationOnce(async (_delivery, status) => {
      expect(store.handoff(proposalId)?.actor).toBe('U_OWNER');
      expect(status).toContain('Starting');
      await slowEdit;
    });
    const approval = handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    try {
      await vi.waitFor(() => expect(store.handoff(proposalId)?.state).toBe('activated'));
      await approval;
      expect(slack.updateProposal).toHaveBeenCalledTimes(1);
      await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
      expect(tasks.start).toHaveBeenCalledTimes(1);
    } finally { release(); await handoff.drainCards(); }
    const edits = vi.mocked(slack.updateProposal).mock.calls;
    expect(edits.map(call => call[1])).toEqual([expect.stringContaining('Starting'), expect.stringContaining('Task started')]);
    expect(edits[1][0]).toMatchObject({ id: delivery.id, ts: delivery.ts, text: delivery.text });
    expect(edits[1][2]).toBe(slack.link(delivery.channel, delivery.ts!));
    expect(store.handoff(proposalId)?.card_state).toBe('activated');
    await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    await handoff.recover(); await handoff.drainCards();
    expect(slack.updateProposal).toHaveBeenCalledTimes(2);
    expect(records.size).toBe(1);
  });

  it('recovers a failed final card edit after reopen without replaying the task or rewriting synced old cards', async () => {
    const delivery = await presented();
    vi.mocked(slack.updateProposal).mockImplementation(async (_delivery, status) => {
      if (status.startsWith('Task started')) throw new Error('Slack edit failed');
    });
    await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    await handoff.drainCards();
    expect(store.handoff(proposalId)).toMatchObject({ state: 'activated', card_retry: expect.any(Number) });
    expect(store.handoff(proposalId)?.card_state).not.toBe('activated');
    expect(store.pendingHandoffCards(NOW)).toEqual([]);
    store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', Date.now()); handoff = freshHandoff();
    vi.mocked(slack.updateProposal).mockClear(); vi.mocked(slack.updateProposal).mockResolvedValue();
    vi.advanceTimersByTime(60_000);
    await handoff.recover(); await handoff.drainCards();
    expect(slack.updateProposal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: delivery.id }), expect.stringContaining('Task started'), expect.any(String));
    expect(store.handoff(proposalId)?.card_state).toBe('activated');
    expect(store.pendingHandoffCards(Date.now())).toEqual([]);
    await handoff.recover(); await handoff.drainCards();
    expect(slack.updateProposal).toHaveBeenCalledTimes(1);
    expect(tasks.start).toHaveBeenCalledTimes(1);
  });

  it('recovers an abandoned card-write lease independently of approved task activation', async () => {
    const delivery = await presented();
    store.approveHandoff({ proposal: proposalId, version: delivery.proposal!.version, actor: 'U_OWNER', approved: NOW,
      task: 'task-before-restart', state: 'approved', budget: 'task', delivery: delivery.id });
    expect(store.claimHandoffCard(proposalId, NOW)).not.toBeNull();
    expect(store.claimHandoffCard(proposalId, NOW)).toBeNull();
    store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW); handoff = freshHandoff();
    await handoff.recover(); await handoff.drainCards();
    expect(store.handoff(proposalId)?.state).toBe('activated');
    expect(slack.updateProposal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    await handoff.recover(); await handoff.drainCards();
    expect(slack.updateProposal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: delivery.id }), expect.stringContaining('Task started'), expect.any(String));
    expect(records.size).toBe(1);
    expect(tasks.start).toHaveBeenCalledTimes(1);
  });

  it('treats a late callback for an already activated task as a replay even after its evidence changes', async () => {
    const delivery = await presented();
    const first = await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version); await handoff.drainCards();
    vi.mocked(slack.updateProposal).mockClear();
    store.record({ channel: 'C1', thread: TS, ts: TS, version: `${NOW / 1000 + 1}.000000`, author: 'U_AUTHOR', text: 'Later edit' }, NOW);
    const replay = await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version); await handoff.drainCards();
    expect(replay.task).toBe(first.task);
    expect(tasks.start).toHaveBeenCalledTimes(1);
    expect(slack.updateProposal).not.toHaveBeenCalled();
  });

  it('retries the current final state when a pending edit fails after activation', async () => {
    const delivery = await presented();
    let fail!: () => void;
    const delayedFailure = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('late edit failure')); });
    vi.mocked(slack.updateProposal).mockImplementationOnce(() => delayedFailure);
    const approval = handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    try {
      await vi.waitFor(() => expect(store.handoff(proposalId)?.state).toBe('activated'));
      await approval;
    } finally { fail(); await handoff.drainCards(); }
    vi.advanceTimersByTime(60_000);
    await handoff.recover(); await handoff.drainCards();
    expect(vi.mocked(slack.updateProposal).mock.calls.map(call => call[1])).toEqual([expect.stringContaining('Starting'), expect.stringContaining('Task started')]);
    expect(store.handoff(proposalId)?.card_state).toBe('activated');
  });

  it('leaves valid actions untouched on rejected clicks and consumes stale preparation without claiming activation', async () => {
    const delivery = await presented();
    await expect(handoff.approve('U_OTHER', delivery.id, delivery.proposal!.version)).rejects.toThrow('owner');
    await expect(handoff.approve('U_OWNER', delivery.id, 'forged-version')).rejects.toThrow('stale');
    expect(slack.updateProposal).not.toHaveBeenCalled();
    const original = vi.mocked(tasks.prepare).getMockImplementation()!;
    vi.mocked(tasks.prepare).mockImplementationOnce(async input => {
      await original(input);
      store.record({ channel: 'C1', thread: TS, ts: TS, version: `${NOW / 1000 + 1}.000000`, author: 'U_AUTHOR', text: 'Cancelled' }, NOW);
    });
    await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version); await handoff.drainCards();
    expect(store.handoff(proposalId)).toMatchObject({ state: 'stale', card_state: 'stale' });
    expect(vi.mocked(slack.updateProposal).mock.calls.at(-1)?.slice(1)).toEqual([expect.stringContaining('stale'), undefined]);
    expect(tasks.start).not.toHaveBeenCalled();
  });

  it('keeps a transient verification failure retryable after preparation', async () => {
    const delivery = await presented();
    const prepare = vi.mocked(tasks.prepare).getMockImplementation()!;
    vi.mocked(tasks.prepare).mockImplementationOnce(async input => {
      await prepare(input);
      vi.mocked(slack.inspect).mockRejectedValueOnce(new Error('temporary access outage'));
    });
    const result = await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    expect(result.state).toBe('prepared');
    expect(tasks.start).not.toHaveBeenCalled();
    await handoff.recover();
    expect(store.handoff(proposalId)?.state).toBe('prepared');
    expect(tasks.start).not.toHaveBeenCalled();
    store.channel('C1', true, false);
    store.apply([store.snapshot('C1', TS)!], [], [store.matter('release')!]);
    await handoff.recover();
    expect(store.handoff(proposalId)?.state).toBe('activated');
    expect(tasks.start).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(1);
  });

  it('never activates an incomplete task when evidence changes during preparation', async () => {
    const delivery = await presented();
    const prepare = vi.mocked(tasks.prepare).getMockImplementation()!;
    vi.mocked(tasks.prepare).mockImplementationOnce(async input => {
      await prepare(input);
      store.record({ channel: 'C1', thread: TS, ts: TS, version: (NOW / 1000 + 1).toFixed(6), author: 'U_AUTHOR', text: 'Cancelled' }, NOW);
    });
    const result = await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
    expect(result.state).toBe('stale');
    expect(records.get(result.task)?.status).toBe('preparing');
    await handoff.recover();
    expect(tasks.start).not.toHaveBeenCalled();
  });

  it('reconciles a prepared task after a database reopen without inventing another identity', async () => {
    const delivery = await presented();
    const original = vi.mocked(tasks.prepare).getMockImplementation()!;
    vi.mocked(tasks.prepare).mockImplementationOnce(async input => { await original(input); throw new Error('crash after first task write'); });
    await expect(handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version)).rejects.toThrow('crash');
    await handoff.drainCards();
    const first = store.handoff(proposalId)!;
    expect(records.get(first.task)?.status).toBe('preparing');
    store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
    handoff = freshHandoff();
    await handoff.recover();
    expect(records.size).toBe(1);
    expect(tasks.start).toHaveBeenCalledTimes(1);
    expect(store.handoff(proposalId)?.task).toBe(first.task);
  });

  it('reconciles activation before acknowledgement and never treats parking as success', async () => {
    const delivery = await presented();
    const start = vi.mocked(tasks.start).getMockImplementation()!;
    vi.mocked(tasks.start).mockImplementationOnce(async id => { await start(id); throw new Error('acknowledgement lost'); });
    await expect(handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version)).rejects.toThrow('acknowledgement lost');
    await handoff.drainCards();
    store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
    handoff = freshHandoff(); await handoff.recover();
    expect(tasks.start).toHaveBeenCalledTimes(1);
    const record = store.handoff(proposalId)!;
    const metadata = records.get(record.task)!;
    metadata.status = 'completed'; metadata.waiting_for = 'user';
    expect((await handoff.describe(proposalId)).runtime).toContain('user');
    expect((await handoff.describe(proposalId)).outcome).toBe('unverified');
    metadata.waiting_for = 'edit_mode'; expect(taskRuntimeState(metadata)).toContain('edit_mode');
    metadata.waiting_for = 'time_budget'; expect(taskRuntimeState(metadata)).toContain('time_budget');
    metadata.waiting_for = 'research_budget'; expect(taskRuntimeState(metadata)).toContain('research_budget');
  });
});

it('persists bounded queue progress past ineligible rows and wraps for earlier arrivals', async () => {
  const seed = store.proposal(proposalId)!;
  store['run']('DELETE FROM proposals');
  for (let n = 0; n < 20; n++) store['run']('INSERT INTO proposals VALUES (?,?)', `30-${n.toString().padStart(2, '0')}`, JSON.stringify({ ...seed, matter: 'missing' }));
  const current = store.proposeCapability(seed);
  const reads = vi.spyOn(store, 'proposal');
  await handoff.present(NOW);
  expect(reads).toHaveBeenCalledTimes(20);
  expect(store.deliveries('pending')).toEqual([]);
  expect(store.setting('proposal_cursor')).toBe('30-19');
  store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
  handoff = freshHandoff();
  const matter = { ...store.matter(seed.matter)!, id: 'earlier-0' };
  store.apply([store.snapshot('C1', TS)!], [], [store.matter(seed.matter)!, matter]);
  const earlier = store.proposeCapability({ ...seed, matter: matter.id });
  expect(earlier < current).toBe(true);
  await handoff.present(NOW);
  expect(store.deliveries('pending').map(delivery => delivery.proposal?.id)).toEqual([current]);
  await handoff.present(NOW);
  expect(store.deliveries('pending').map(delivery => delivery.proposal?.id)).toContain(earlier);
  expect(store['row']('SELECT count(*) AS n FROM proposals')?.n).toBe(22);
});

it('rechecks the work thread audience even when the model cites only a related source', async () => {
  store['run']('DELETE FROM proposals');
  store.channel('C2', true, false);
  const relatedThread = '1792490403.000001';
  const evidence = store.record({ channel: 'C2', thread: relatedThread, ts: relatedThread, version: relatedThread, author: 'U_AUTHOR', text: 'Related release requirements.' }, NOW)!;
  const id = store.proposeCapability({ repository: 'owner/repo', outcome: 'Prepare the release checklist', evidence: [evidence], matter: 'release' });
  vi.mocked(slack.page).mockImplementation(async (channel, _oldest, _latest, _cursor, thread) => ({ messages: store.snapshot(channel, thread ?? TS)?.evidence ?? [] }));
  const card = await presented();
  expect(store.proposalSources(id)).toEqual([{ channel: 'C1', thread: TS }, { channel: 'C2', thread: relatedThread }]);
  vi.mocked(slack.inspect).mockImplementation(async channel => channel === 'C1' ? null : { shared: false, ownerCanRead: true });
  await expect(handoff.approve('U_OWNER', card.id, card.proposal!.version)).rejects.toThrow('access');
  expect(tasks.prepare).not.toHaveBeenCalled();
});

it('requires a new card approval after fresh work evidence changes a pending suggestion', async () => {
  const oldCard = await presented();
  const fresh = store.record({ channel: 'C1', thread: TS, ts: '1792490402.000001', version: '1792490402.000001', author: 'U_AUTHOR', text: 'New scope: prepare a deployment checklist instead.' }, NOW)!;
  const matter = { ...store.matter('release')!, evidence: [fresh], detail: 'New deployment checklist scope' };
  store.apply([store.snapshot('C1', TS)!], [], [matter]);
  const next = store.proposeCapability({ repository: 'owner/repo', outcome: 'Prepare the newly requested deployment checklist', evidence: [fresh], matter: matter.id });
  expect(next).not.toBe(proposalId);
  await expect(handoff.approve('U_OWNER', oldCard.id, oldCard.proposal!.version)).rejects.toThrow('context');
  expect(tasks.prepare).not.toHaveBeenCalled();
  await handoff.present(NOW);
  const newCard = store.deliveries('pending').find(delivery => delivery.proposal?.id === next)!;
  expect(newCard.proposal?.version).not.toBe(oldCard.proposal?.version);
  expect(store.handoff(next)).toBeNull();
  expect(store.pendingProposalCount(NOW)).toBe(1);
});

it('revalidates and requeues a never-sent cancelled card after transient access recovery', async () => {
  await handoff.present(NOW);
  const first = store.deliveries('pending')[0];
  const service = new InitiativeService(store, slack, { complete: vi.fn() }, { mode: 'live', owner: 'U_OWNER', extractionModel: 'test', investigationModel: 'test' }, () => NOW);
  try {
    vi.mocked(slack.inspect).mockRejectedValueOnce(new Error('temporary metadata outage'));
    await service.deliver(NOW);
    expect(store.delivery(first.id)?.state).toBe('cancelled');
    store.channel('C1', true, false);
    store.apply([store.snapshot('C1', TS)!], [], [store.matter('release')!]);
    await handoff.present(NOW + 60_000);
    await service.deliver(NOW + 60_000);
    expect(store.delivery(first.id)?.state).toBe('sent');
    expect(slack.send).toHaveBeenCalledTimes(1);
    await handoff.present(NOW + 120_000);
    await service.deliver(NOW + 120_000);
    expect(slack.send).toHaveBeenCalledTimes(1);
  } finally { service.stop(); service.release(); }
});

it.each(['sending', 'uncertain', 'sent', 'attempted-cancelled', 'approved'] as const)('never requeues a %s card during recovery', async state => {
  const delivery = await presented();
  if (state === 'approved') await handoff.approve('U_OWNER', delivery.id, delivery.proposal!.version);
  else {
    store['run']('UPDATE deliveries SET state=?,ts=?,slot_day=? WHERE id=?', state === 'attempted-cancelled' ? 'cancelled' : state,
      state === 'sent' ? delivery.ts : null, '2026-10-20', delivery.id);
  }
  await handoff.present(NOW + 60_000);
  expect(store.deliveries('pending')).toEqual([]);
  expect(slack.send).toHaveBeenCalledTimes(1);
  await handoff.drainCards();
});
