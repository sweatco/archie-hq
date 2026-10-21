// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservationStore } from '../../memory/observation-store.js';
import { InitiativeService } from '../service.js';
import { LearningService } from '../learning.js';
import { AdmissionDeferred, ModelGateway, type BackgroundModel } from '../model.js';
import { captureDecision, replayDecision, replayModel } from '../replay.js';
import type { ObservationSlack } from '../slack.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const TS = (NOW / 1000).toFixed(6);
const config = { mode: 'shadow' as const, owner: 'U1', extractionModel: 'claude-haiku-5-5', investigationModel: 'claude-sonnet-5-5' };
let store: ObservationStore;
let slack: ObservationSlack;
beforeEach(() => {
  store = new ObservationStore(':memory:', 'T1', NOW - 1000);
  store.channel('C1', true, false);
  store.record({ channel: 'C1', thread: TS, ts: TS, version: TS, author: 'U1', text: 'Please prepare the urgent release checklist' }, NOW);
  slack = { inspect: async () => ({ shared: false, ownerCanRead: true }), active: () => false } as unknown as ObservationSlack;
});
afterEach(() => { store.close(); });

function result(request: Parameters<BackgroundModel['complete']>[0], omit = false): unknown {
  const input = request.input as { threads?: Array<{ channel: string; thread: string; evidence: Array<{ id: number }> }>; matter?: { evidence: number[] } };
  return input.threads ? { threads: input.threads.map((s) => ({ channel: s.channel, thread: s.thread, observations: [], matters: omit ? [] : [{ key: 'release', title: 'Release', detail: 'Checklist required', evidence: s.evidence.map((e) => e.id),
    state: 'open', owner: 'U1', deadline: NOW + 86400000, explicit: true, reopen: false }] })) }
    : { resolved: false, help: 'I can draft the checklist.', public: false, evidence: input.matter!.evidence };
}

describe('production-path snapshot replay', () => {
  it('replays extraction, first investigation and delivery checks without changing production state', async () => {
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW);
    const complete = vi.fn(async (request) => result(request)) as BackgroundModel['complete'];
    const replay = await replayDecision(store, input, 'base', '{}', { complete }, false, new AbortController().signal);
    expect(replay.interventions).toHaveLength(1);
    expect(replay.interventions[0].channel).toBe('D_REPLAY');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.matters()).toEqual([]);
    expect(store.deliveries('sent')).toEqual([]);
    expect(store.rows('SELECT kind FROM jobs')).toEqual([]);
  });

  it('records before extraction and keeps zero-matter decisions as completed no-action cases', async () => {
    const learning = new LearningService(store, new ModelGateway(store), config.investigationModel, [], async () => true);
    const model: BackgroundModel = { complete: vi.fn(async (request) => {
      expect(store.rows('SELECT id FROM episodes')).toHaveLength(1);
      return result(request, true) as never;
    }) };
    const service = new InitiativeService(store, slack, model, config, () => NOW, learning);
    store.schedule('extract', 'global', NOW); await service.tick(NOW, true); service.stop();
    const input = JSON.parse(String(store.row('SELECT payload FROM episodes')!.payload)).decision;
    const replay = await replayDecision(store, input, 'base', '{}', model, false, new AbortController().signal);
    expect(replay).toEqual({ interventions: [], matters: [] });
  });

  it('preserves recorded manual suppression and active PM work', async () => {
    slack.active = () => true;
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW);
    const replay = await replayDecision(store, input, 'base', '{}', { complete: async (request) => result(request) as never }, false, new AbortController().signal);
    expect(replay.interventions).toEqual([]);
    expect(replay.matters).toHaveLength(1);
  });

  it('refuses an incomplete source read instead of inventing an empty complete thread', async () => {
    store.run('UPDATE threads SET gap=?', 'Pagination missing');
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW);
    const complete = vi.fn(async (request) => result(request, true)) as BackgroundModel['complete'];
    await expect(replayDecision(store, input, 'base', '{}', { complete }, false, new AbortController().signal)).rejects.toThrow('Recorded source coverage is incomplete');
    expect(complete).not.toHaveBeenCalled();
  });

  it('imports prior delivery facts even when new activity has invalidated their matter', async () => {
    const snapshot = store.snapshot('C1', TS)!;
    const evidence = snapshot.evidence.map((e) => e.id);
    const matter = { id: 'existing', channel: 'C1', thread: TS, title: 'Release', detail: 'Checklist required', evidence, state: 'open' as const, owner: 'U1', deadline: null, explicit: true, nextCheck: NOW, valid: true, policy: 'base' };
    store.apply([snapshot], [], [matter], 'base');
    store.enqueueDelivery({ id: 'already-helped', channel: 'D_OWNER', thread: null, text: 'Checklist help', matters: [matter.id], evidence, policy: 'base', digest: false, state: 'sent', ts: 'sent', created: NOW - 86400000 });
    const reply = ((NOW + 1000) / 1000).toFixed(6);
    store.record({ channel: 'C1', thread: TS, ts: reply, version: reply, author: 'U2', text: 'Unrelated acknowledgement' }, NOW + 1000);
    expect(store.matter(matter.id)?.valid).toBe(false);
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW + 1000);
    const model: BackgroundModel = { complete: async (request) => (request.input as { threads?: unknown }).threads ? result(request) as never : { resolved: false, help: 'Same help', public: false, evidence } as never };
    expect((await replayDecision(store, input, 'base', '{}', model, false, new AbortController().signal)).interventions).toEqual([]);
  });

  it('preserves consumed notification slots from other threads without copying their content', async () => {
    for (let i = 0; i < 2; i++) store.run("INSERT INTO deliveries VALUES (?, 'D_OTHER',NULL,'Other-source text','[]','[]','base',0,'sent',NULL,?,'2026-10-20')", `other-${i}`, NOW);
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW);
    expect(input.usedSlots.extra).toBe(2);
    expect(JSON.stringify(input)).not.toContain('Other-source text');
    expect((await replayDecision(store, input, 'base', '{}', { complete: async (request) => result(request) as never }, false, new AbortController().signal)).interventions).toEqual([]);
  });

  it('restarts from the original clock and uses completed semantic batch steps once', async () => {
    const input = await captureDecision(store, slack, config, [store.snapshot('C1', TS)!], NOW);
    const gateway = new ModelGateway(store);
    const submit = vi.spyOn(gateway, 'submit').mockImplementation(async (request, context) => {
      const id = `batch-${submit.mock.calls.length}`;
      store.run('INSERT INTO batches VALUES (?,NULL,?,?,?,?,?,?)', id, id, '{}', JSON.stringify(context), 'complete',
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result(request)) }] }), NOW);
      return id;
    });
    const authorize = vi.fn(async () => true);
    const model = replayModel(store, gateway, 'frozen-cohort', 'episode', input.refs.map((r) => r.id), authorize);
    for (let i = 0; i < 2; i++) await expect(replayDecision(store, input, 'base', '{}', model, false, new AbortController().signal)).rejects.toBeInstanceOf(AdmissionDeferred);
    const replay = await replayDecision(store, input, 'base', '{}', model, false, new AbortController().signal);
    expect(replay.interventions).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.every(([request]) => (request.input as { now: number }).now === NOW)).toBe(true);
  });
});
