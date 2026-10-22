// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InitiativeStore } from '../store.js';
import { AdmissionDeferred, ModelGateway } from '../model.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const schema = z.object({ answer: z.string().max(10) });
const request = { model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema };
const result = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"ok"}' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
let store: InitiativeStore;
let gateway: ModelGateway;
let create: ReturnType<typeof vi.fn>;
let batches: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; results: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  store = new InitiativeStore(':memory:', 'T1', NOW);
  create = vi.fn(async () => result());
  batches = { list: vi.fn(async () => ({ data: [], has_more: false, last_id: null })), create: vi.fn(async () => ({ id: 'batch1' })), retrieve: vi.fn(), results: vi.fn(), cancel: vi.fn() };
  gateway = new ModelGateway(store, { messages: { create, batches } } as unknown as Anthropic, 'provider-fixture');
});
afterEach(() => { store.close(); vi.useRealTimers(); });

describe('paid model admission and accounting', () => {
  it('uses the provider schema adapter, validates locally, and settles complete usage', async () => {
    expect(await gateway.complete(request, new AbortController().signal)).toEqual({ answer: 'ok' });
    const params = create.mock.calls[0][0] as { output_config: { format: { schema: { properties: { answer: { maxLength?: number } } } } } };
    expect(params.output_config.format.schema.properties.answer.maxLength).toBeUndefined();
    expect(store['row']('SELECT actual,settled FROM charges')).toMatchObject({ actual: 18, settled: NOW });
  });

  it('rechecks access before retries and never dispatches after revocation', async () => {
    create.mockRejectedValueOnce(new Anthropic.InternalServerError(500, undefined, 'server error', new Headers()));
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(gateway.complete({ ...request, authorize }, new AbortController().signal)).rejects.toThrow('Source access changed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(store['row']('SELECT count(*) AS n FROM charges')?.n).toBe(1);
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
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
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
    expect(store['row']('SELECT state FROM requests')?.state).toBe('complete');
  });
});
