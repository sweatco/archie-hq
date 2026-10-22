// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { InitiativeService } from '../service.js';
import { publicFollowupAt } from '../decisions.js';
import type { Matter, SourceMessage } from '../types.js';
import type { ObservationSlack } from '../slack.js';
import type { BackgroundModel } from '../model.js';

const START = Date.parse('2026-10-19T10:00:00Z');
const DAY = 86_400_000;
let root: string;
let store: InitiativeStore;
let service: InitiativeService;
let slack: ObservationSlack;
let model: BackgroundModel;
let message: SourceMessage;
const freshService = () => new InitiativeService(store, slack, model, { mode: 'shadow', owner: 'U1', extractionModel: 'haiku', investigationModel: 'sonnet' }, Date.now);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START);
  root = mkdtempSync(join(tmpdir(), 'initiative-timing-'));
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', START - 60_000);
  store.channel('C1', true, false);
  const ts = ((START - 30_000) / 1000).toFixed(6);
  message = { channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Please prepare the release checklist.' };
  store.record(message, START);
  slack = {
    inspect: async () => ({ shared: false, ownerCanRead: true }), channels: async () => ['C1'],
    page: async () => ({ messages: [message] }), ownerDm: async () => 'D1', verifyDm: async channel => channel === 'D1',
    send: vi.fn(async () => 'sent'), find: async () => undefined, active: () => false, link: (channel, thread) => `${channel}/${thread}`,
  };
  model = { complete: vi.fn(async request => ({ resolved: false, help: null, public: false, evidence: (request.input as { matter: Matter }).matter.evidence })) as BackgroundModel['complete'] };
  service = freshService();
});
afterEach(() => { service.stop(); service.release(); store.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

function seed(nextCheck = START, deadline: number | null = null): Matter {
  const snapshot = store.snapshot('C1', message.thread)!;
  const matter: Matter = { id: `C1:${message.thread}:m:release`, channel: 'C1', thread: message.thread, title: 'Release checklist', detail: 'Prepare checklist', evidence: snapshot.evidence.map(e => e.id), state: 'open', owner: 'U1', deadline, explicit: true, nextCheck, valid: true, policy: 'base' };
  store.apply([snapshot], [], [matter], 'base');
  store.schedule('investigate', matter.id, nextCheck);
  return matter;
}

async function editDeadline(matter: Matter, deadline: number): Promise<void> {
  const now = START + 60_000;
  vi.setSystemTime(now);
  message = { ...message, version: (now / 1000).toFixed(6), text: `The checklist deadline changed to ${deadline}.` };
  store.record(message, now);
  const evidence = store.snapshot('C1', message.thread)!.evidence.map(e => e.id);
  vi.mocked(model.complete).mockResolvedValueOnce({ threads: [{ channel: 'C1', thread: message.thread, observations: [], matters: [{ key: 'release', title: matter.title, detail: message.text, evidence, state: 'open', owner: 'U1', deadline, explicit: true }] }] });
  store.schedule('extract', 'global', now);
  await service.tick(now, true);
}

it('reassesses after restart at the inactivity boundary and reuses stable phases', async () => {
  const matter = seed();
  await service.tick(START, true);
  expect(model.complete).toHaveBeenCalledTimes(1);
  const boundary = publicFollowupAt(store.snapshot('C1', message.thread)!)!;
  vi.setSystemTime(boundary - 60_000);
  await service.tick(Date.now(), true);
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(store.matter(matter.id)?.nextCheck).toBe(boundary);
  service.stop(); service.release(); store.close();
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', Date.now()); service = freshService();
  vi.mocked(model.complete).mockResolvedValue({ resolved: false, help: 'Can I prepare this still-open checklist?', public: true, evidence: matter.evidence });
  vi.setSystemTime(boundary);
  await service.tick(Date.now(), true);
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(store.deliveries('pending').some(delivery => delivery.channel === 'C1')).toBe(true);
  store.attention.setNextCheck(boundary + 60_000, matter.id);
  store.schedule('investigate', matter.id, boundary + 60_000);
  vi.setSystemTime(boundary + 60_000);
  await service.tick(Date.now(), true);
  expect(model.complete).toHaveBeenCalledTimes(2);
});

it('counts Friday inactivity through Tuesday and treats a later human edit as new activity', async () => {
  const friday = Date.parse('2026-10-16T10:00:00Z');
  const ts = (friday / 1000).toFixed(6);
  message = { ...message, ts, thread: ts, version: ts, context: true };
  store.record(message, friday);
  const tuesday = Date.parse('2026-10-20T10:00:00Z');
  expect(publicFollowupAt(store.snapshot('C1', ts)!)).toBe(tuesday);
  message = { ...message, version: (tuesday / 1000).toFixed(6), text: 'Updated request' };
  store.record(message, tuesday);
  expect(publicFollowupAt(store.snapshot('C1', ts)!)).toBe(Date.parse('2026-10-22T10:00:00Z'));
});

it('advances a shortened source deadline to its preparation window', async () => {
  const matter = seed(START + DAY);
  const deadline = START + 60_000 + 3_600_000;
  await editDeadline(matter, deadline);
  expect(store.matter(matter.id)?.nextCheck).toBe(deadline - 15 * 60_000);
  expect(store['row']("SELECT due FROM jobs WHERE kind='investigate' AND target=?", matter.id)?.due).toBe(deadline - 15 * 60_000);
});

it('does not postpone an existing earlier check when the source deadline moves later', async () => {
  const matter = seed(START + 3_600_000, START + 2 * 3_600_000);
  await editDeadline(matter, START + DAY);
  expect(store.matter(matter.id)?.nextCheck).toBe(START + 3_600_000);
});

it.each(['later', 'not useful'] as const)('preserves the human %s decision across an earlier source deadline', async action => {
  const matter = seed(START + DAY);
  store.feedback(matter.id, action, START, START + DAY);
  await editDeadline(matter, START + 5 * 60_000);
  expect(store.matter(matter.id)).toMatchObject({ state: action === 'later' ? 'snoozed' : 'dismissed', nextCheck: START + DAY });
  expect(model.complete).toHaveBeenCalledTimes(1);
});
