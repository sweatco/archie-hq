// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ObservationStore } from '../../memory/observation-store.js';
import { AdmissionDeferred, ModelGateway } from '../model.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const schema = z.object({ answer: z.string().max(10) });
const request = { model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema };
const result = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"ok"}' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
let store: ObservationStore;
let gateway: ModelGateway;
let create: ReturnType<typeof vi.fn>;
let batches: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; results: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  store = new ObservationStore(':memory:', 'T1', NOW);
  create = vi.fn(async () => result());
  batches = { create: vi.fn(async () => ({ id: 'batch1' })), retrieve: vi.fn(), results: vi.fn(), cancel: vi.fn() };
  gateway = new ModelGateway(store, { messages: { create, batches } } as unknown as Anthropic);
});
afterEach(() => { store.close(); vi.useRealTimers(); });

describe('paid model admission and accounting', () => {
  it('uses the provider schema adapter, validates locally, and settles complete usage', async () => {
    expect(await gateway.complete(request, new AbortController().signal)).toEqual({ answer: 'ok' });
    const params = create.mock.calls[0][0] as { output_config: { format: { schema: { properties: { answer: { maxLength?: number } } } } } };
    expect(params.output_config.format.schema.properties.answer.maxLength).toBeUndefined();
    expect(store.row('SELECT actual,settled FROM charges')).toMatchObject({ actual: 18, settled: NOW });
  });

  it('rechecks access before retries and never dispatches after revocation', async () => {
    create.mockRejectedValueOnce(new Anthropic.InternalServerError(500, undefined, 'server error', new Headers()));
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(gateway.complete({ ...request, authorize }, new AbortController().signal)).rejects.toThrow('Source access changed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.row('SELECT count(*) AS n FROM charges')?.n).toBe(1);
    expect(store.row('SELECT settled FROM charges')?.settled).toBeNull();
  });

  it('checks a stop applied during authorization before reserving money', async () => {
    await expect(gateway.complete({ ...request, authorize: async () => { store.set('stop', 'true'); return true; } }, new AbortController().signal)).rejects.toThrow('stopped');
    expect(create).not.toHaveBeenCalled();
    expect(store.budget(NOW)).toBe(0);
  });

  it('caps concurrent direct calls at four', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>((done) => { resolve = done; });
    create.mockReturnValue(pending);
    const calls = Array.from({ length: 4 }, () => gateway.complete(request, new AbortController().signal));
    await expect(gateway.complete(request, new AbortController().signal)).rejects.toBeInstanceOf(AdmissionDeferred);
    resolve(result()); await Promise.all(calls);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('bounds context and refuses unpriced models before dispatch', async () => {
    await expect(gateway.complete({ ...request, input: 'x'.repeat(40_000) }, new AbortController().signal)).rejects.toThrow('split it');
    await expect(gateway.complete({ ...request, model: 'unpriced' }, new AbortController().signal)).rejects.toThrow('Unpriced');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps liability when usage is incomplete and still records the response', async () => {
    create.mockResolvedValue({ ...result(), usage: { input_tokens: 10, output_tokens: 5 } });
    await gateway.complete(request, new AbortController().signal);
    expect(store.row('SELECT settled FROM charges')?.settled).toBeNull();
    expect(store.row('SELECT state FROM requests')?.state).toBe('complete');
  });
});

describe('durable batches', () => {
  it('counts outstanding batch items toward concurrency and leaves a direct-check slot', async () => {
    await gateway.submitMany(Array.from({ length: 3 }, () => ({ request, context: {} })), new AbortController().signal);
    expect(gateway.batchCapacity()).toBe(0);
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toBeInstanceOf(AdmissionDeferred);
    let finish!: (value: ReturnType<typeof result>) => void;
    create.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const direct = gateway.complete(request, new AbortController().signal);
    await expect(gateway.complete(request, new AbortController().signal)).rejects.toBeInstanceOf(AdmissionDeferred);
    finish(result()); await direct;
  });

  it('groups items, streams partial outcomes, and quarantines malformed successful output', async () => {
    const ids = await gateway.submitMany([{ request, context: { n: 1 } }, { request, context: { n: 2 } }], new AbortController().signal);
    expect(batches.create).toHaveBeenCalledTimes(1);
    expect(store.rows("SELECT id FROM batches WHERE remote='batch1' AND state='pending'")).toHaveLength(2);
    batches.retrieve.mockResolvedValue({ id: 'batch1', processing_status: 'ended' });
    batches.results.mockImplementation(async function* () {
      yield { custom_id: ids[0], result: { type: 'succeeded', message: { ...result(), stop_reason: 'max_tokens' } } };
      yield { custom_id: ids[1], result: { type: 'errored', error: { type: 'server_error' } } };
    });
    await gateway.poll(new AbortController().signal);
    expect(gateway.completed(ids[0], schema)).toBeNull();
    expect(store.row('SELECT state FROM batches WHERE id=?', ids[0])?.state).toBe('invalid');
    expect(store.row('SELECT settled FROM charges WHERE id=(SELECT charge FROM batches WHERE id=?)', ids[0])?.settled).toBe(NOW);
    expect(store.row('SELECT settled FROM charges WHERE id=(SELECT charge FROM batches WHERE id=?)', ids[1])?.settled).toBeNull();
    await gateway.poll(new AbortController().signal);
    expect(batches.results).toHaveBeenCalledTimes(1);
  });

  it('proves undispatched items cost zero if a later reservation fails', async () => {
    const reserve = vi.spyOn(store, 'reserve');
    reserve.mockReturnValueOnce(null);
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toBeInstanceOf(AdmissionDeferred);
    expect(batches.create).not.toHaveBeenCalled();
    expect(store.budget(NOW)).toBe(0);
  });

  it('retains uncertain submission liabilities without resubmitting them', async () => {
    batches.create.mockRejectedValue(new Error('lost response'));
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toThrow('lost response');
    expect(store.row('SELECT state,remote FROM batches')).toEqual(expect.objectContaining({ state: 'uncertain', remote: null }));
    expect(store.budget(NOW)).toBeGreaterThan(0);
    await gateway.poll(new AbortController().signal);
    expect(batches.create).toHaveBeenCalledTimes(1);
  });

  it('discards stale source payloads and late output while still settling the batch usage', async () => {
    store.channel('C1', true, false);
    const ts = (NOW / 1000 + 1).toFixed(6);
    const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Source text' }, NOW)!;
    const id = await gateway.submit(request, { evidence: [evidence] }, new AbortController().signal);
    store.record({ channel: 'C1', thread: ts, ts, version: (NOW / 1000 + 2).toFixed(6), author: 'U1', text: '', deleted: true }, NOW);
    gateway.expire(NOW);
    expect(JSON.parse(String(store.row('SELECT request FROM batches WHERE id=?', id)!.request))).toEqual({ model: request.model });
    batches.retrieve.mockResolvedValue({ id: 'batch1', processing_status: 'ended' });
    batches.results.mockImplementation(async function* () { yield { custom_id: id, result: { type: 'succeeded', message: result() } }; });
    await gateway.poll(new AbortController().signal);
    const row = store.row('SELECT state,result,charge FROM batches WHERE id=?', id)!;
    expect(row.state).toBe('applied');
    expect(JSON.parse(String(row.result))).toEqual({ usage: result().usage });
    expect(store.row('SELECT settled FROM charges WHERE id=?', row.charge)?.settled).toBe(NOW);
  });

  it('scrubs a recent request when its original raw source reaches thirty days', async () => {
    store.channel('C1', true, false);
    const captured = NOW - 31 * 86400000, ts = (captured / 1000).toFixed(6);
    const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Old source', context: true }, captured)!;
    const id = await gateway.submit({ ...request, input: 'Old source' }, { evidence: [evidence] }, new AbortController().signal);
    gateway.expire(NOW);
    const row = store.row('SELECT request,context,state FROM batches WHERE id=?', id)!;
    expect(JSON.parse(String(row.request))).toEqual({ model: request.model });
    expect(JSON.parse(String(row.context)).discard).toBe(true);
    expect(row.state).toBe('pending');
    expect(store.budget(NOW)).toBeGreaterThan(0);
  });
});
