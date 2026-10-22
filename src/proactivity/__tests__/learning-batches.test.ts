// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
    expect(store['rows']("SELECT id FROM batches WHERE remote='batch1' AND state='pending'")).toHaveLength(2);
    batches.retrieve.mockResolvedValue({ id: 'batch1', processing_status: 'ended' });
    batches.results.mockImplementation(async function* () {
      yield { custom_id: ids[0], result: { type: 'succeeded', message: { ...result(), stop_reason: 'max_tokens' } } };
      yield { custom_id: ids[1], result: { type: 'errored', error: { type: 'server_error' } } };
    });
    await gateway.poll(new AbortController().signal);
    expect(gateway.completed(ids[0], schema)).toBeNull();
    expect(store['row']('SELECT state FROM batches WHERE id=?', ids[0])?.state).toBe('invalid');
    expect(store['row']('SELECT settled FROM charges WHERE id=(SELECT charge FROM batches WHERE id=?)', ids[0])?.settled).toBe(NOW);
    expect(store['row']('SELECT settled FROM charges WHERE id=(SELECT charge FROM batches WHERE id=?)', ids[1])?.settled).toBe(NOW);
    await gateway.poll(new AbortController().signal);
    expect(batches.results).toHaveBeenCalledTimes(1);
  });

  it('releases known terminal execution slots while retaining missing-result liability', async () => {
    const id = await gateway.submit(request, {}, new AbortController().signal);
    batches.retrieve.mockResolvedValue({ id: 'batch1', processing_status: 'ended', created_at: new Date(NOW).toISOString() });
    batches.results.mockRejectedValueOnce(new Error('results unavailable'));
    await expect(gateway.poll(new AbortController().signal)).rejects.toThrow('reconciliation incomplete');
    expect(gateway.batchCapacity()).toBe(3);
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
    expect(store['row']('SELECT state FROM batches')?.state).toBe('retrieving');
    vi.setSystemTime(NOW + 30 * 86_400_000);
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('retired');
    expect(store.budget(Date.now())).toBeGreaterThan(0);
    expect(gateway.completed(id, schema)).toBeNull();
    expect(batches.create).toHaveBeenCalledTimes(1);
    batches.results.mockImplementation(async function* () { yield { custom_id: id, result: { type: 'succeeded', message: result() } }; });
    await gateway.reconcileRemote('batch1', new AbortController().signal);
    expect(gateway.completed(id, schema)).toEqual({ answer: 'ok' });
    expect(store['row']('SELECT settled FROM charges')?.settled).toBe(Date.now());
    expect(batches.create).toHaveBeenCalledTimes(1);
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
    expect(store['row']('SELECT state,remote FROM batches')).toEqual(expect.objectContaining({ state: 'uncertain', remote: null }));
    expect(store.budget(NOW)).toBeGreaterThan(0);
    await gateway.poll(new AbortController().signal);
    expect(batches.create).toHaveBeenCalledTimes(1);
  });

  it('correlates a lost create response using provider result IDs and settles its actual usage', async () => {
    batches.create.mockRejectedValueOnce(new Error('lost response'));
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toThrow('lost response');
    const id = String(store['row']('SELECT id FROM batches')!.id);
    batches.list.mockResolvedValue({ data: [{ id: 'recovered', created_at: new Date(NOW).toISOString(), processing_status: 'ended' }], has_more: false });
    batches.results.mockImplementation(async function* () { yield { custom_id: id, result: { type: 'succeeded', message: result() } }; });
    await gateway.poll(new AbortController().signal);
    expect(gateway.completed(id, schema)).toEqual({ answer: 'ok' });
    expect(store['row']('SELECT actual FROM charges')?.actual).toBe(18);
    expect(gateway.batchCapacity()).toBe(3);
    expect(batches.create).toHaveBeenCalledTimes(1);
  });

  it('does not use age or an incomplete listing as proof that an unknown attempt ended', async () => {
    batches.create.mockRejectedValueOnce(new Error('lost response'));
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toThrow();
    const reserved = store.budget(NOW);
    vi.setSystemTime(NOW + 91 * 86_400_000);
    batches.list.mockResolvedValueOnce({ data: [], has_more: true, last_id: 'page1' });
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('uncertain');
    batches.list.mockResolvedValueOnce({ data: [{ id: 'possibly-running', created_at: new Date(NOW).toISOString(), processing_status: 'in_progress' }], has_more: false });
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('uncertain');
    expect(batches.list.mock.calls[1][0]).toMatchObject({ after_id: 'page1' });
    batches.list.mockResolvedValueOnce({ data: [], has_more: false });
    await gateway.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('retired');
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
    expect(store.budget(Date.now())).toBe(reserved);
    expect(gateway.batchCapacity()).toBe(3);
    expect(batches.create).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit provider binding after credentials change', async () => {
    batches.create.mockRejectedValueOnce(new Error('lost response'));
    await expect(gateway.submit(request, {}, new AbortController().signal)).rejects.toThrow();
    const id = String(store['row']('SELECT id FROM batches')!.id);
    const rotated = new ModelGateway(store, { messages: { create, batches } } as unknown as Anthropic, 'different-provider');
    vi.setSystemTime(NOW + 91 * 86_400_000);
    await rotated.poll(new AbortController().signal);
    expect(batches.list).not.toHaveBeenCalled();
    expect(store.setting(`batch-recovery:${id}`)).toContain('Confirm the original provider workspace');
    rotated.bindProvider(id);
    await rotated.poll(new AbortController().signal);
    expect(store['row']('SELECT state FROM batches')?.state).toBe('retired');
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
  });

  it('recovers a process exit during batch submission from durable request identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archie-batch-restart-'));
    const path = join(root, 'state.sqlite');
    const record = join(root, 'remote-request.json');
    try {
      const code = `import { writeFileSync } from 'node:fs';
        import { z } from 'zod';
        import { InitiativeStore } from ${JSON.stringify(resolve('src/proactivity/store.ts'))};
        import { ModelGateway } from ${JSON.stringify(resolve('src/proactivity/model.ts'))};
        Date.now = () => ${NOW};
        const store = new InitiativeStore(${JSON.stringify(path)}, 'T1', ${NOW});
        const client = { messages: { batches: { create: async body => { writeFileSync(${JSON.stringify(record)}, JSON.stringify(body)); process.exit(37); } } } };
        const gateway = new ModelGateway(store, client, 'provider-fixture');
        await gateway.submit({ model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema: z.object({ answer: z.string() }) }, {}, new AbortController().signal);`;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
      expect(child.status, child.stderr).toBe(37);
      const saved = JSON.parse(readFileSync(record, 'utf8'));
      const recoveredStore = new InitiativeStore(path, 'T1', NOW);
      try {
        const id = saved.requests[0].custom_id;
        expect(recoveredStore['row']('SELECT state FROM batches')?.state).toBe('submitting');
        const recovered = new ModelGateway(recoveredStore, { messages: { create, batches } } as unknown as Anthropic, 'provider-fixture');
        batches.list.mockResolvedValue({ data: [{ id: 'crashed-batch', created_at: new Date(NOW).toISOString(), processing_status: 'ended' }], has_more: false });
        batches.results.mockImplementation(async function* () { yield { custom_id: id, result: { type: 'succeeded', message: result() } }; });
        await recovered.poll(new AbortController().signal);
        expect(recovered.completed(id, schema)).toEqual({ answer: 'ok' });
        expect(recovered.batchCapacity()).toBe(3);
        expect(batches.create).not.toHaveBeenCalled();
      } finally { recoveredStore.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('discards stale source payloads and late output while still settling the batch usage', async () => {
    store.channel('C1', true, false);
    const ts = (NOW / 1000 + 1).toFixed(6);
    const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Source text' }, NOW)!;
    const id = await gateway.submit(request, { evidence: [evidence] }, new AbortController().signal);
    store.record({ channel: 'C1', thread: ts, ts, version: (NOW / 1000 + 2).toFixed(6), author: 'U1', text: '', deleted: true }, NOW);
    gateway.expire(NOW);
    expect(JSON.parse(String(store['row']('SELECT request FROM batches WHERE id=?', id)!.request))).toEqual({ model: request.model });
    batches.retrieve.mockResolvedValue({ id: 'batch1', processing_status: 'ended' });
    batches.results.mockImplementation(async function* () { yield { custom_id: id, result: { type: 'succeeded', message: result() } }; });
    await gateway.poll(new AbortController().signal);
    const row = store['row']('SELECT state,result,charge FROM batches WHERE id=?', id)!;
    expect(row.state).toBe('applied');
    expect(JSON.parse(String(row.result))).toEqual({ usage: result().usage });
    expect(store['row']('SELECT settled FROM charges WHERE id=?', row.charge)?.settled).toBe(NOW);
  });

  it('scrubs a recent request when its original raw source reaches thirty days', async () => {
    store.channel('C1', true, false);
    const captured = NOW - 31 * 86400000, ts = (captured / 1000).toFixed(6);
    const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Old source', context: true }, captured)!;
    const id = await gateway.submit({ ...request, input: 'Old source' }, { evidence: [evidence] }, new AbortController().signal);
    gateway.expire(NOW);
    const row = store['row']('SELECT request,context,state FROM batches WHERE id=?', id)!;
    expect(JSON.parse(String(row.request))).toEqual({ model: request.model });
    expect(JSON.parse(String(row.context)).discard).toBe(true);
    expect(row.state).toBe('pending');
    expect(store.budget(NOW)).toBeGreaterThan(0);
  });
});
