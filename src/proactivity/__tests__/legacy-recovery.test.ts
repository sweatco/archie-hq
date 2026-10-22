// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InitiativeStore } from '../store.js';
import { ModelGateway } from '../model.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const message = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"ok"}' }], usage };
let store: InitiativeStore;
let gateway: ModelGateway;
let batches: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; results: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  store = new InitiativeStore(':memory:', 'T1', NOW);
  batches = { create: vi.fn(), retrieve: vi.fn(), results: vi.fn(), list: vi.fn(async () => ({ data: [], has_more: false })) };
  gateway = new ModelGateway(store, { messages: { batches, create: vi.fn(async () => message) } } as unknown as Anthropic, 'original-provider');
});
afterEach(() => { store.close(); vi.useRealTimers(); });

function legacy(id: string, remote: string | null = 'remote', state = 'pending'): string {
  const charge = store.reserve(50_000, false, NOW)!;
  store['run']('INSERT INTO batches VALUES (?,?,?,?,?,?,NULL,?)', id, remote, charge, '{"model":"claude-haiku-5-5"}', '{"kind":"reflection","evidence":[]}', state, NOW);
  store.set(`batch-provider:${id}`, 'original-provider');
  return charge;
}

describe('deferred provider work retains its financial responsibility', () => {
  it('expires historical learning payloads with their evidence while retaining provider liability', () => {
    const old = NOW - 91 * 86_400_000, ts = (old / 1000).toFixed(6);
    store.channel('C1', true, false);
    const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Expired source', context: true }, old)!;
    store['run']('INSERT INTO episodes VALUES (?,?,?,?,?,?,?)', 'episode', 'C1', ts, 'topic', old, JSON.stringify({ thread: { evidence: [{ id: evidence }] } }), '{}');
    store['run']("INSERT INTO cohorts VALUES ('cohort','old-policy',?,'pending')", JSON.stringify({ groups: [{ episode: 'episode' }], trainingInputs: [] }));
    store['run']("INSERT INTO cohort_predictions VALUES ('cohort','episode','private candidate','private baseline',NULL)");
    store.proposeCapability('old-proposal', { repository: 'owner/repo', outcome: 'Expired task', evidence: [evidence] });
    legacy('unresolved');
    store.expire(NOW);
    expect(store['rows']('SELECT * FROM episodes')).toEqual([]);
    expect(store['row']('SELECT candidate,baseline FROM cohort_predictions')).toEqual({ candidate: null, baseline: null });
    expect(store.proposal('old-proposal')?.evidence).toEqual([]);
    expect(store.budget(NOW)).toBe(50_000);
    expect(store.requests.activeBatches()?.n).toBe(1);
  });

  it('recovers a known billable result without dispatching or applying learning', async () => {
    const charge = legacy('old-reflection');
    batches.retrieve.mockResolvedValue({ id: 'remote', processing_status: 'ended', created_at: new Date(NOW).toISOString() });
    batches.results.mockImplementation(async function* () { yield { custom_id: 'old-reflection', result: { type: 'succeeded', message } }; });
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT actual,settled FROM charges WHERE id=?', charge)).toMatchObject({ actual: 18, settled: NOW });
    expect(store['row']('SELECT state FROM batches')?.state).toBe('complete');
    expect(store['rows']('SELECT * FROM policies')).toEqual([]);
    expect(store['rows']('SELECT * FROM proposals')).toEqual([]);
    expect(batches.create).not.toHaveBeenCalled();
    expect('submit' in gateway).toBe(false);
    expect('learning' in store).toBe(false);
  });

  it('holds missing usage beyond provider retention and only settles an authoritative later result', async () => {
    const charge = legacy('missing');
    batches.retrieve.mockResolvedValue({ id: 'remote', processing_status: 'ended', created_at: new Date(NOW).toISOString() });
    batches.results.mockRejectedValueOnce(new Error('results unavailable'));
    await expect(gateway.poll(new AbortController().signal)).rejects.toThrow('reconciliation incomplete');
    expect(store.requests.activeBatches()?.n).toBe(0);
    expect(store['row']('SELECT settled FROM charges WHERE id=?', charge)?.settled).toBeNull();
    vi.setSystemTime(NOW + 30 * 86_400_000);
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('retired');
    expect(store.budget(Date.now())).toBe(50_000);
    batches.results.mockImplementation(async function* () { yield { custom_id: 'missing', result: { type: 'succeeded', message } }; });
    await gateway.reconcileRemote('remote', new AbortController().signal);
    expect(store['row']('SELECT actual FROM charges WHERE id=?', charge)?.actual).toBe(18);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('correlates unknown submission identity while requiring the original provider binding', async () => {
    const charge = legacy('unknown', null, 'submitting');
    store.set('batch-provider:unknown', 'other-provider');
    batches.list.mockResolvedValue({ data: [{ id: 'found', processing_status: 'ended', created_at: new Date(NOW).toISOString() }], has_more: false });
    batches.results.mockImplementation(async function* () { yield { custom_id: 'unknown', result: { type: 'succeeded', message } }; });
    await gateway.poll(new AbortController().signal);
    expect(batches.list).not.toHaveBeenCalled();
    gateway.bindProvider('unknown');
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT actual FROM charges WHERE id=?', charge)?.actual).toBe(18);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('counts legacy execution slots toward new direct admission', async () => {
    for (let i = 0; i < 3; i++) legacy(`pending-${i}`);
    const result = await gateway.complete({ model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema: z.object({ answer: z.string() }) }, new AbortController().signal);
    expect(result).toEqual({ answer: 'ok' });
    expect(store.requests.activeBatches()?.n).toBe(3);
    expect(batches.create).not.toHaveBeenCalled();
  });
});
