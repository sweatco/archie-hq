// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObservationStore } from '../../memory/observation-store.js';
import { InitiativeService, nextMorning, notificationWindow } from '../service.js';
import type { BackgroundModel } from '../model.js';
import type { ObservationSlack } from '../slack.js';
import type { TaskMetadata } from '../../types/task.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const TS = '1792490401.000001';
let root: string;
let store: ObservationStore;
let service: InitiativeService;
let slack: ObservationSlack;
let model: BackgroundModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-initiative-'));
  store = new ObservationStore(join(root, 'state.sqlite'), 'T1', NOW);
  store.channel('C1', true, false);
  slack = {
    inspect: vi.fn(async (channel: string) => channel === 'C1' ? { shared: false, ownerCanRead: true } : null),
    channels: vi.fn(async () => ['C1']), page: vi.fn(async () => ({ messages: store.snapshot('C1', TS)?.evidence ?? [] })),
    ownerDm: vi.fn(async () => 'D1'), verifyDm: vi.fn(async (channel) => channel === 'D1'),
    send: vi.fn(async () => '1792491000.000001'), find: vi.fn(async () => undefined), active: vi.fn(() => false),
    link: (channel, thread) => `https://slack.test/${channel}/${thread}`,
  };
  model = { complete: vi.fn(async (request) => ({ resolved: false, help: null, public: false, evidence: (request.input as { matter?: { evidence: number[] } }).matter?.evidence ?? [] })) as BackgroundModel['complete'] };
  service = new InitiativeService(store, slack, model, { mode: 'live', owner: 'U1', extractionModel: 'haiku', investigationModel: 'sonnet' }, () => NOW);
});
afterEach(() => { service.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });

async function extract(): Promise<string> {
  store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'I will release Friday' }, NOW);
  const evidence = store.snapshot('C1', TS)!.evidence.map((e) => e.id);
  vi.mocked(model.complete).mockResolvedValueOnce({ threads: [{ channel: 'C1', thread: TS,
    observations: [{ key: 'release', text: 'Release Friday', kind: 'commitment', evidence }],
    matters: [{ key: 'release', title: 'Release', detail: 'Release Friday', evidence, state: 'open', owner: 'U1', deadline: NOW + 60_000, explicit: true }],
  }] });
  store.schedule('extract', 'global', NOW);
  await service.tick(NOW);
  const id = store.matters()[0].id;
  store.run('UPDATE matters SET next_check=? WHERE id=?', NOW + 60_000, id);
  store.schedule('investigate', id, NOW + 60_000);
  return id;
}

async function investigate(help: string | null = 'I can prepare the release checklist.'): Promise<string> {
  const id = await extract();
  vi.mocked(model.complete).mockResolvedValueOnce({ resolved: false, help, public: false, evidence: store.matter(id)!.evidence });
  await service.tick(NOW + 60_000);
  return id;
}

describe('initiative flow', () => {
  it('extracts unmentioned activity without creating a task and gates delivery on rollout approval', async () => {
    await investigate();
    expect(store.search('release', ['C1'])).toHaveLength(1);
    expect(store.deliveries('pending')).toHaveLength(1);
    expect(slack.send).not.toHaveBeenCalled();
    store.set('rollout_approved', 'base');
    await service.deliver(NOW + 60_000);
    expect(slack.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the next investigation scheduled for tomorrow', async () => {
    const id = await investigate(null);
    const due = store.row("SELECT due FROM jobs WHERE kind='investigate' AND target=?", id)?.due;
    expect(due).toBe(NOW + 60_000 + 86_400_000);
    expect(store.claim(NOW + 120_000)).toBeNull();
  });

  it('lets cancellation invalidate pending delivery before sending', async () => {
    await investigate();
    store.set('rollout_approved', 'base');
    vi.mocked(slack.page).mockResolvedValue({ messages: [{ channel: 'C1', thread: TS, ts: TS, version: '1792491000.000001', author: 'U1', text: 'Cancelled' }] });
    await service.deliver(NOW + 60_000);
    expect(slack.send).not.toHaveBeenCalled();
    expect(store.deliveries('pending')).toEqual([]);
  });

  it('rechecks mute after asynchronous thread validation', async () => {
    await investigate();
    store.set('rollout_approved', 'base');
    vi.mocked(slack.page).mockImplementation(async () => { store.set('mute', 'true'); return { messages: [] }; });
    await service.deliver(NOW + 60_000);
    expect(slack.send).not.toHaveBeenCalled();
  });

  it('does not race a normal PM task and does not retry uncertain Slack sends', async () => {
    await investigate();
    store.set('rollout_approved', 'base');
    vi.mocked(slack.active).mockReturnValue(true);
    await service.deliver(NOW + 60_000);
    expect(slack.send).not.toHaveBeenCalled();
    vi.mocked(slack.active).mockReturnValue(false);
    const matter = store.matters()[0];
    const previous = store.deliveries('cancelled')[0];
    store.enqueueDelivery({ ...previous, id: 'retry-test', matters: [matter.id], state: 'pending' });
    vi.mocked(slack.send).mockRejectedValue(new Error('Timeout after potential send'));
    await service.deliver(NOW + 60_000);
    expect(store.deliveries('uncertain')).toHaveLength(1);
    await service.deliver(NOW + 120_000);
    expect(slack.send).toHaveBeenCalledTimes(1);
    expect(slack.find).toHaveBeenCalled();
  });

  it('preserves incomplete coverage across access refresh', async () => {
    store.channel('C1', true, false, 'Outage may have hidden old-thread replies');
    await service.capture({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'New message' }, NOW);
    expect(store.snapshot('C1', TS)?.gap).toContain('Outage');
  });

  it('rechecks source access before extraction dispatch', async () => {
    store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'Release Friday' }, NOW);
    store.schedule('extract', 'global', NOW);
    vi.mocked(slack.inspect).mockResolvedValue(null);
    await service.tick(NOW);
    expect(model.complete).not.toHaveBeenCalled();
    expect(store.row("SELECT allowed FROM channels WHERE id='C1'")?.allowed).toBe(0);
  });

  it('keeps extraction requests within one public source channel', async () => {
    vi.mocked(slack.inspect).mockResolvedValue({ shared: true, ownerCanRead: true });
    for (const channel of ['C1', 'C2']) {
      store.channel(channel, true, channel === 'C2');
      store.record({ channel, thread: TS, ts: TS, version: TS, author: 'U1', text: 'Discussion' }, NOW);
    }
    vi.mocked(model.complete).mockImplementation(async (req) => ({ threads: (req.input as { threads: Array<{ channel: string; thread: string }> }).threads.map((s) => ({ channel: s.channel, thread: s.thread, observations: [], matters: [] })) }) as never);
    store.schedule('extract', 'global', NOW); await service.tick(NOW);
    expect(model.complete).toHaveBeenCalledTimes(2);
    for (const [req] of vi.mocked(model.complete).mock.calls) expect(new Set((req.input as { threads: Array<{ channel: string }> }).threads.map((s) => s.channel)).size).toBe(1);
  });

  it('checks related observation evidence and invalidates a pending nudge when that evidence changes', async () => {
    const id = await extract();
    const thread = '1792490402.000001';
    store.record({ channel: 'C1', thread, ts: thread, version: thread, author: 'U1', text: 'Release needs a checklist' }, NOW);
    const snapshot = store.snapshot('C1', thread)!;
    const evidence = snapshot.evidence.map((e) => e.id);
    store.apply([snapshot], [{ id: 'related', channel: 'C1', thread, kind: 'question', text: 'Release checklist', evidence }], [], 'base');
    vi.mocked(slack.page).mockImplementation(async (channel, _oldest, _latest, _cursor, source) => ({ messages: store.snapshot(channel, source ?? TS)?.evidence ?? [] }));
    vi.mocked(model.complete).mockResolvedValueOnce({ resolved: false, help: 'I can prepare the checklist.', public: false, evidence });
    await service.tick(NOW + 60_000);
    expect((vi.mocked(model.complete).mock.calls.at(-1)![0].input as { related: unknown[] }).related).toHaveLength(1);
    expect(store.deliveries('pending')).toHaveLength(1);
    store.record({ channel: 'C1', thread, ts: thread, version: '1792490403.000001', author: 'U1', text: 'Checklist completed' }, NOW + 120_000);
    expect(store.matter(id)?.valid).toBe(true);
    expect(store.deliveries('pending')).toEqual([]);
  });

  it('bounds large investigation context and preserves the newest end of a message', async () => {
    store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: `${'Context '.repeat(3000)}release cancelled` }, NOW);
    const snapshot = store.snapshot('C1', TS)!;
    const matter = { id: 'large', channel: 'C1', thread: TS, title: 'Release', detail: 'Friday release', evidence: snapshot.evidence.map((e) => e.id), state: 'open' as const, owner: 'U1', deadline: null, explicit: true, nextCheck: NOW, valid: true, policy: 'base' };
    store.apply([snapshot], [], [matter], 'base'); store.schedule('investigate', matter.id, NOW);
    vi.mocked(model.complete).mockResolvedValueOnce({ resolved: false, help: null, public: false, evidence: matter.evidence });
    await service.tick(NOW);
    const input = vi.mocked(model.complete).mock.calls[0][0].input as { thread: { gap: string; evidence: Array<{ text: string }> } };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(8000);
    expect(input.thread.gap).toContain('bounded');
    expect(input.thread.evidence[0].text).toContain('release cancelled');
  });

  it('does not retain a poisoned extraction and can recover on the next attempt', async () => {
    store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'Release Friday' }, NOW);
    vi.mocked(model.complete).mockResolvedValueOnce({ threads: [{ channel: 'C1', thread: TS,
      observations: [{ key: 'release', text: 'Release', kind: 'commitment', evidence: [999] }], matters: [] }] });
    store.schedule('extract', 'global', NOW);
    await service.tick(NOW);
    expect(store.rows('SELECT id FROM extractions')).toEqual([]);
    vi.mocked(model.complete).mockResolvedValueOnce({ threads: [{ channel: 'C1', thread: TS, observations: [], matters: [] }] });
    await service.tick(NOW + 5 * 60_000);
    expect(model.complete).toHaveBeenCalledTimes(2);
    expect(store.dirty()).toEqual([]);
  });

  it('retains validated extraction parts after interruption so larger threads can make progress', async () => {
    store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'Long context. '.repeat(1600) }, NOW);
    let calls = 0;
    vi.mocked(model.complete).mockImplementation(async (req) => {
      if (++calls === 2) { service.cancelAnalysis(); throw new Error('interrupted'); }
      return { threads: (req.input as { threads: Array<{ channel: string; thread: string }> }).threads.map((s) => ({ channel: s.channel, thread: s.thread, observations: [], matters: [] })) } as never;
    });
    store.schedule('extract', 'global', NOW); await service.tick(NOW);
    expect(store.rows('SELECT id FROM extractions')).toHaveLength(1);
    await service.tick(NOW + 5 * 60_000);
    expect(store.dirty()).toEqual([]);
    expect(vi.mocked(model.complete).mock.calls.filter(([r]) => (r.input as { carried: unknown[] }).carried.length === 0)).toHaveLength(1);
  });

  it('carries split-thread findings forward so a later cancellation replaces an earlier commitment', async () => {
    store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: `Release Friday. ${'Context '.repeat(2000)}` }, NOW);
    store.record({ channel: 'C1', thread: TS, ts: '1792490402.000001', version: '1792490402.000001', author: 'U1', text: 'Cancelled the release.' }, NOW);
    vi.mocked(model.complete).mockImplementation(async (req) => {
      const input = req.input as { threads: Array<{ channel: string; thread: string; evidence: Array<{ id: number; text: string }> }>; carried: unknown[] };
      const thread = input.threads[0];
      const cancelled = thread.evidence.find((e) => e.text.includes('Cancelled'));
      return { threads: [{ channel: thread.channel, thread: thread.thread, observations: [], matters: [{ key: cancelled ? 'cancelled' : 'release', title: 'Release', detail: cancelled ? 'Cancelled' : 'Friday',
        evidence: [cancelled?.id ?? thread.evidence[0].id], state: cancelled ? 'resolved' : 'open', owner: 'U1', deadline: null, explicit: true }] }] } as never;
    });
    store.schedule('extract', 'global', NOW);
    await service.tick(NOW);
    expect(vi.mocked(model.complete).mock.calls.length).toBeGreaterThan(1);
    expect(store.threadMatters('C1', TS)).toHaveLength(1);
    expect(store.threadMatters('C1', TS)[0].state).toBe('resolved');
    expect((vi.mocked(model.complete).mock.calls[1][0].input as { carried: unknown[] }).carried).toHaveLength(1);
  });

  it('detects a missed deletion from a fully paginated thread before delivery', async () => {
    const id = await investigate();
    store.set('rollout_approved', 'base');
    vi.mocked(slack.page).mockResolvedValue({ messages: [] });
    await service.deliver(NOW + 60_000);
    expect(store.matter(id)?.valid).toBe(false);
    expect(slack.send).not.toHaveBeenCalled();
  });

  it('revalidates an older parent without importing older thread history', async () => {
    const root = '100.000001';
    store.record({ channel: 'C1', thread: root, ts: root, version: root, author: 'U1', text: 'Old commitment', context: true }, NOW);
    store.record({ channel: 'C1', thread: root, ts: TS, version: TS, author: 'U1', text: 'New reply' }, NOW);
    const snapshot = store.snapshot('C1', root)!;
    const matter = { id: 'old-parent', channel: 'C1', thread: root, title: 'Commitment', detail: 'Old commitment', evidence: snapshot.evidence.map((e) => e.id), state: 'open' as const, owner: 'U1', deadline: null, explicit: true, nextCheck: NOW, valid: true, policy: 'base' };
    store.apply([snapshot], [], [matter], 'base');
    store.enqueueDelivery({ id: 'parent-reminder', channel: 'D1', thread: null, text: 'Follow up', matters: [matter.id], evidence: matter.evidence, policy: 'base', digest: false, state: 'pending', ts: null, created: NOW });
    store.set('rollout_approved', 'base');
    vi.mocked(slack.page).mockImplementation(async (_channel, _oldest, _latest, _cursor, thread) => ({ messages: thread ? snapshot.evidence.filter((e) => e.ts !== root) : [] }));
    await service.deliver(NOW + 60_000);
    expect(slack.page).toHaveBeenCalledWith('C1', root, root);
    expect(store.snapshot('C1', root)?.removed).toContainEqual(expect.objectContaining({ ts: root }));
    expect(store.matter(matter.id)?.valid).toBe(false);
    expect(slack.send).not.toHaveBeenCalled();
  });

  it('drains cheap jobs and does not refresh inactive threads forever', async () => {
    vi.mocked(slack.page).mockImplementation(async (channel, _oldest, _latest, _cursor, thread) => ({ messages: store.snapshot(channel, thread!)?.evidence ?? [] }));
    for (let i = 0; i < 70; i++) {
      const ts = (Number(TS) + i).toFixed(6);
      store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Discussion' }, NOW);
      store.schedule('thread', `C1:${ts}`, NOW, JSON.stringify({ channel: 'C1', thread: ts }));
    }
    await service.tick(NOW + 120_000);
    expect(store.rows("SELECT target FROM jobs WHERE kind='thread'")).toHaveLength(38);
  });

  it('provides source-scoped observation recall and owner-only matter recall', async () => {
    const id = await extract();
    const metadata = (channel_id: string) => ({ memory_destination: { channel_id } }) as TaskMetadata;
    expect(await service.search(metadata('C1'), 'release', 10)).toHaveLength(1);
    expect(await service.search(metadata('C2'), 'release', 10)).toEqual([]);
    expect(await service.read(metadata('C1'), 'matter', id)).toBe('Matter unavailable.');
    expect(await service.read(metadata('D1'), 'matter', id)).toMatchObject({ matter: { id } });
  });

  it('keeps collecting and schedules work after day 14 without expiration', async () => {
    service.seed(NOW);
    service.seed(NOW + 15 * 86_400_000);
    expect(store.setting('stop')).toBeUndefined();
    expect(store.setting('pause')).toBeUndefined();
    expect(store.rows('SELECT kind FROM jobs')).not.toHaveLength(0);
    expect(store.setting('live_start')).toBe(String(NOW));
  });
});

describe('Lisbon notification scheduling', () => {
  it('honors weekdays and the daylight-saving change', () => {
    expect(notificationWindow(Date.parse('2026-10-23T08:00:00Z'))).toBe(true);
    expect(notificationWindow(Date.parse('2026-10-26T08:00:00Z'))).toBe(false);
    expect(notificationWindow(Date.parse('2026-10-26T09:00:00Z'))).toBe(true);
    expect(notificationWindow(Date.parse('2026-10-24T10:00:00Z'))).toBe(false);
    expect(nextMorning(Date.parse('2026-10-23T18:00:00Z'))).toBe(Date.parse('2026-10-26T09:00:00Z'));
  });
});
