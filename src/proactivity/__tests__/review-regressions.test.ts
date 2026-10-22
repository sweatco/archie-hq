// SPDX-License-Identifier: AGPL-3.0-or-later
import { ObservationRecall } from '../recall.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { InitiativeStore } from '../store.js';
import type { Matter, SourceMessage } from '../types.js';
import type { TaskMetadata } from '../../types/task.js';
import { InitiativeService } from '../service.js';
import { ModelGateway, type BackgroundModel } from '../model.js';
import type { ObservationSlack } from '../slack.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const TS = ((NOW - 30_000) / 1000).toFixed(6);
let store: InitiativeStore;
let service: InitiativeService;
let slack: ObservationSlack;
let model: BackgroundModel;
let messages: SourceMessage[];

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  store = new InitiativeStore(':memory:', 'T1', NOW - 60_000);
  store.channel('C1', true, false);
  messages = [{ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'I will release today at noon.' }];
  store.record(messages[0], NOW);
  slack = {
    inspect: vi.fn(async () => ({ shared: false, ownerCanRead: true })),
    channels: vi.fn(async () => ['C1']), page: vi.fn(async () => ({ messages })),
    ownerDm: vi.fn(async () => 'D1'), verifyDm: vi.fn(async (channel) => channel === 'D1'),
    send: vi.fn(async () => 'sent-ts'), find: vi.fn(async () => undefined),
    active: vi.fn(() => false), link: (channel, thread) => `https://slack.test/${channel}/${thread}`,
  };
  model = { complete: vi.fn(async (request) => ({ resolved: false, help: null, public: false, evidence: (request.input as { matter: Matter }).matter.evidence })) as BackgroundModel['complete'] };
  service = new InitiativeService(store, slack, model, { mode: 'shadow', owner: 'U1', extractionModel: 'haiku', investigationModel: 'sonnet' }, () => NOW);
});
afterEach(() => { service.stop(); store.close(); vi.useRealTimers(); });

describe('independent PR review probes', () => {
  it('schedules a follow-up no later than an explicit approaching deadline', async () => {
    const evidence = store.snapshot('C1', TS)!.evidence.map((e) => e.id);
    vi.mocked(model.complete).mockResolvedValueOnce({ threads: [{ channel: 'C1', thread: TS, observations: [], matters: [{
      key: 'release', title: 'Release', detail: 'Release in one hour', evidence, state: 'open', owner: 'U1',
      deadline: NOW + 3_600_000, explicit: true,
    }] }] });
    store.schedule('extract', 'global', NOW);
    await service.tick(NOW);
    const matter = store.matters()[0];
    expect(model.complete).toHaveBeenCalledTimes(2);
    const due = Number(store['row']("SELECT due FROM jobs WHERE kind='investigate' AND target=?", matter.id)!.due);
    expect(due).toBeLessThanOrEqual(matter.deadline!);
  });

  it('repairs a transient metadata-lookup gap after successful full reconciliation', async () => {
    vi.mocked(slack.inspect).mockRejectedValueOnce(new Error('temporary Slack outage'));
    await new ObservationRecall(store, slack).search({ memory_destination: { channel_id: 'C1' } } as TaskMetadata, 'release', 10);
    store.schedule('collect', 'C1', NOW);
    store.schedule('thread', `C1:${TS}`, NOW, JSON.stringify({ channel: 'C1', thread: TS }));
    await service.tick(NOW);
    expect(store['row']("SELECT allowed FROM channels WHERE id='C1'")!.allowed).toBe(1);
    expect(slack.page).toHaveBeenCalled();
    expect(store.snapshot('C1', TS)!.gap).toBeNull();
  });

  it('does not retain execution slots forever after uncertain batch submissions', async () => {
    const batches = { list: vi.fn(async () => ({ data: [], has_more: false, last_id: null })), create: vi.fn(async () => { throw new Error('response lost'); }), retrieve: vi.fn(), results: vi.fn() };
    const gateway = new ModelGateway(store, { messages: { batches } } as unknown as Anthropic, 'provider-fixture');
    const request = { model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema: z.object({ answer: z.string() }) };
    for (let i = 0; i < 3; i++) await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toThrow('response lost');
    vi.setSystemTime(NOW + 91 * 86_400_000);
    gateway.expire(Date.now());
    await gateway.poll(new AbortController().signal);
    expect(store.budget(Date.now())).toBeGreaterThan(0);
    expect(gateway.batchCapacity()).toBeGreaterThan(0);
  });

  it('suppresses the same intervention when citation order changes', async () => {
    const replyTs = ((NOW - 20_000) / 1000).toFixed(6);
    messages.push({ channel: 'C1', thread: TS, ts: replyTs, version: replyTs, author: 'U2', text: 'The release checklist is ready.' });
    store.record(messages[1], NOW);
    const snapshot = store.snapshot('C1', TS)!;
    const evidence = snapshot.evidence.map((e) => e.id);
    const matter: Matter = { id: 'release', channel: 'C1', thread: TS, title: 'Release', detail: 'Prepare release', evidence,
      state: 'open', owner: 'U1', deadline: null, explicit: true, nextCheck: NOW, valid: true, policy: 'base' };
    store.apply([snapshot], [], [matter], 'base');
    store.enqueueDelivery({ id: 'previous', channel: 'D1', thread: null, text: 'I can prepare the release.', matters: [matter.id], evidence,
      policy: 'base', digest: false, state: 'sent', ts: 'prior-ts', created: NOW - 86_400_000 });
    vi.mocked(model.complete).mockResolvedValueOnce({ resolved: false, help: 'I can prepare the release.', public: false, evidence: [...evidence].reverse() });
    store.schedule('investigate', matter.id, NOW);
    await service.tick(NOW);
    expect(store.deliveries('pending')).toHaveLength(0);
  });
});
