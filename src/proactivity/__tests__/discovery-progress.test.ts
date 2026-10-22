// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { ModelGateway } from '../model.js';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const DAY = 86_400_000;
const local = 'legacy-unknown';
const result = { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
const remote = (id: string) => ({ id, created_at: new Date(NOW - 2 * DAY).toISOString(), processing_status: 'ended' });
let root: string;
let store: InitiativeStore;
let gateway: ModelGateway;
let charge: string;
let batches: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; results: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> };
const freshGateway = () => new ModelGateway(store, { messages: { batches } } as unknown as Anthropic, 'provider');

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'initiative-discovery-'));
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW - 2 * DAY);
  charge = store.reserve(50_000, false, NOW - 2 * DAY)!;
  store['run']('INSERT INTO batches VALUES (?,?,?,?,?,?,NULL,?)', local, null, charge, '{"model":"claude-haiku-5-5"}', '{}', 'uncertain', NOW - 2 * DAY);
  store.set(`batch-provider:${local}`, 'provider');
  batches = { create: vi.fn(), list: vi.fn(), retrieve: vi.fn(), results: vi.fn(async function* () {}) };
  gateway = freshGateway();
});
afterEach(() => { store.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

async function poll(): Promise<void> {
  try { await gateway.poll(new AbortController().signal); }
  catch (error) { expect(error).toBeInstanceOf(AggregateError); }
  vi.advanceTimersByTime(60_000);
}

it('resumes an unfinished metadata page after restart without relisting or releasing liability', async () => {
  batches.list.mockResolvedValue({ data: [1, 2, 3, 4].map(n => remote(`remote-${n}`)), has_more: false, last_id: 'remote-4' });
  batches.results.mockImplementation(async function* (id: string) { if (id === 'remote-4') yield { custom_id: local, result }; });
  await poll();
  expect(batches.results.mock.calls.map(args => args[0])).toEqual(['remote-1', 'remote-2', 'remote-3']);
  expect(store['row']('SELECT state FROM batches')?.state).toBe('uncertain');
  expect(store.budget(Date.now())).toBe(50_000);
  store.close(); store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', Date.now()); gateway = freshGateway();
  await poll();
  expect(batches.list).toHaveBeenCalledTimes(1);
  expect(batches.results.mock.calls.map(args => args[0])).toEqual(['remote-1', 'remote-2', 'remote-3', 'remote-4']);
  expect(store['row']('SELECT actual FROM charges')?.actual).toBe(18);
  expect(batches.create).not.toHaveBeenCalled();
});

it.each(['failed', 'truncated'] as const)('reaches the next page despite a %s unrelated stream, preserving bounded retry-round state', async mode => {
  batches.list.mockImplementation(async args => args.after_id === 'remote-20'
    ? { data: [remote('matching')], has_more: false, last_id: 'matching' }
    : { data: Array.from({ length: 20 }, (_, i) => remote(`remote-${i + 1}`)), has_more: true, last_id: 'remote-20' });
  batches.results.mockImplementation(async function* (id: string) {
    if (id === 'remote-1') {
      if (mode === 'failed') throw new Error('result unavailable');
      for (let i = 0; i < 1001; i++) yield { custom_id: `unrelated-${i}`, result };
    }
    if (id === 'matching') yield { custom_id: local, result };
  });
  for (let i = 0; i < 10 && store['row']('SELECT settled FROM charges')?.settled === null; i++) {
    const before = batches.results.mock.calls.length;
    await poll();
    expect(batches.results.mock.calls.length - before).toBeLessThanOrEqual(3);
  }
  expect(batches.list.mock.calls.map(args => args[0].after_id)).toEqual([undefined, 'remote-20']);
  expect(store['row']('SELECT actual FROM charges')?.actual).toBe(18);
  expect(batches.create).not.toHaveBeenCalled();
});

it('retries unread candidates on a later scan round while keeping ambiguous usage reserved', async () => {
  batches.list.mockResolvedValue({ data: [remote('unavailable')], has_more: false, last_id: 'unavailable' });
  batches.results.mockRejectedValueOnce(new Error('temporary result outage'));
  await poll();
  const progress = JSON.parse(store.setting(`batch-discovery:${local}`)!);
  expect(progress.lastRound).toMatchObject({ unreadCount: 1, unreadSample: ['unavailable'] });
  expect(store.budget(Date.now())).toBe(50_000);
  batches.results.mockImplementation(async function* () { yield { custom_id: local, result }; });
  await poll();
  expect(batches.results).toHaveBeenCalledTimes(2);
  expect(store['row']('SELECT actual FROM charges')?.actual).toBe(18);
  expect(batches.create).not.toHaveBeenCalled();
});

it('restarts legacy cursor state and can recover a previously retired unknown attempt', async () => {
  store['run']("UPDATE batches SET state='retired'");
  store.set(`batch-discovery:${local}`, '{"cursor":"skipped-page","terminalScanAt":1}');
  batches.list.mockResolvedValue({ data: [remote('found')], has_more: false });
  batches.results.mockImplementation(async function* () { yield { custom_id: local, result }; });
  expect(store.requests.activeBatches()?.n).toBe(0);
  await poll();
  expect(batches.list.mock.calls[0][0].after_id).toBeUndefined();
  expect(store['row']('SELECT actual FROM charges')?.actual).toBe(18);
  expect(batches.create).not.toHaveBeenCalled();
});

it('rotates past unbound legacy attempts rather than starving a later bound request', async () => {
  store.set(`batch-provider:${local}`, 'other-provider');
  for (let i = 0; i < 2; i++) {
    const other = store.reserve(50_000, false, NOW - 2 * DAY)!;
    store['run']('INSERT INTO batches VALUES (?,?,?,?,?,?,NULL,?)', `unbound-${i}`, null, other, '{"model":"claude-haiku-5-5"}', '{}', 'uncertain', NOW - 2 * DAY);
  }
  const laterCharge = store.reserve(50_000, false, NOW)!;
  store['run']('INSERT INTO batches VALUES (?,?,?,?,?,?,NULL,?)', 'later', null, laterCharge, '{"model":"claude-haiku-5-5"}', '{}', 'uncertain', NOW);
  store.set('batch-provider:later', 'provider');
  batches.list.mockResolvedValue({ data: [remote('found')], has_more: false });
  batches.results.mockImplementation(async function* () { yield { custom_id: 'later', result }; });
  await poll(); expect(batches.list).not.toHaveBeenCalled();
  await poll();
  expect(store['row']('SELECT actual FROM charges WHERE id=?', laterCharge)?.actual).toBe(18);
  expect(store['row']('SELECT settled FROM charges WHERE id=?', charge)?.settled).toBeNull();
  expect(batches.create).not.toHaveBeenCalled();
});
