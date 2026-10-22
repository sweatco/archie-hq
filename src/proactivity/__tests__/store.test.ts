// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeStore } from '../store.js';
import { DatabaseSync } from 'node:sqlite';
import { lisbonDay, type Delivery, type Matter, type SourceMessage } from '../types.js';
import { SCHEMA_VERSION } from '../persistence/migrations.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
let root: string;
let store: InitiativeStore;

function message(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return { channel: 'C1', thread: '1792490401.000001', ts: '1792490401.000001', version: '1792490401.000001', author: 'U1', text: 'Release Friday', ...overrides };
}

function populate(): Matter {
  store.record(message(), NOW);
  const snapshot = store.snapshot('C1', message().thread)!;
  const matter: Matter = { id: 'C1:release', channel: 'C1', thread: message().thread, title: 'Release', detail: 'Release Friday',
    evidence: snapshot.evidence.map((e) => e.id), state: 'open', owner: 'U1', deadline: NOW + 86_400_000,
    explicit: true, nextCheck: NOW, valid: true, policy: 'base' };
  expect(store.apply([snapshot], [{ ...matter, kind: 'commitment', text: matter.detail }], [matter], 'base')).toBe(true);
  return matter;
}

function delivery(id: string, matter: Matter): Delivery {
  return { id, channel: 'D1', thread: null, text: matter.title, matters: [matter.id], evidence: matter.evidence,
    policy: 'base', digest: false, state: 'pending', ts: null, created: NOW };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-observations-'));
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
  store.channel('C1', true, false);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

describe('observation memory', () => {
  it('binds the workspace and keeps the initial watermark across restart', () => {
    const watermark = store.setting('watermark');
    expect(() => new InitiativeStore(join(root, 'state.sqlite'), 'T2', NOW)).toThrow('workspace mismatch');
    store.close();
    store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW + 86_400_000);
    expect(store.setting('watermark')).toBe(watermark);
  });

  it('does not backfill or accept unverified/private channels', () => {
    expect(store.record(message({ ts: '100.000001', version: '100.000001' }), NOW)).toBeNull();
    expect(store.record(message({ channel: 'G1' }), NOW)).toBeNull();
    store.channel('G1', false, false);
    expect(store.record(message({ channel: 'G1' }), NOW)).toBeNull();
  });

  it('observes a new edit to an older message without importing old history', () => {
    expect(store.record(message({ ts: '100.000001', version: '1792490402.000001', text: 'New correction' }), NOW)).not.toBeNull();
  });

  it('deduplicates overlap, rejects older edits, and does not resurrect deletion', () => {
    const first = store.record(message(), NOW);
    expect(first).not.toBeNull();
    expect(store.record(message(), NOW)).toBeNull();
    store.record(message({ version: '1792490402.000001', text: 'Release Monday' }), NOW);
    expect(store.record(message(), NOW)).toBeNull();
    store.record(message({ version: '1792490403.000001', text: '', deleted: true }), NOW);
    expect(store.record(message({ version: '1792490404.000001', text: 'Release Monday' }), NOW)).toBeNull();
    expect(store.snapshot('C1', message().thread)!.evidence).toEqual([]);
  });

  it('deduplicates envelope IDs and canonical revisions across overlapping handlers', () => {
    expect(store.record(message({ eventId: 'mention-event' }), NOW)).not.toBeNull();
    expect(store.record(message({ eventId: 'message-event' }), NOW)).toBeNull();
    expect(store.record(message({ eventId: 'message-event', text: 'Inconsistent retry' }), NOW)).toBeNull();
    expect(store['rows']('SELECT id FROM revisions')).toHaveLength(1);
    expect(store['rows']('SELECT id FROM source_events')).toHaveLength(2);
  });

  it('migrates old schema without treating unknown bot provenance as human evidence', () => {
    populate();
    const path = join(root, 'old.sqlite');
    store['run']('VACUUM INTO ?', path);
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP INDEX pending_handoff_cards; ALTER TABLE handoffs DROP COLUMN card_state; ALTER TABLE handoffs DROP COLUMN card_retry; ALTER TABLE threads DROP COLUMN gap; ALTER TABLE revisions DROP COLUMN bot; PRAGMA user_version=1');
    legacy.close();
    const migrated = new InitiativeStore(path, 'T1', NOW);
    try {
      expect(migrated['row']('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
      expect(migrated.snapshot('C1', message().thread)?.evidence[0].bot).toBe(true);
      expect(migrated.matters()).toEqual([]);
      expect(migrated.setting('watermark')).toBe(String(NOW / 1000));
    } finally { migrated.close(); }
  });

  it('requires changed human evidence and an explicit reopening decision', () => {
    const matter = populate();
    store.feedback(matter.id, 'handled', NOW);
    store.apply([store.snapshot('C1', matter.thread)!], [], [{ ...matter, reopen: true }], 'base');
    expect(store.matter(matter.id)?.state).toBe('resolved');
    store.record(message({ version: '1792490402.000001', text: 'Reinstated for Monday' }), NOW);
    let snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], [{ ...matter, evidence: snapshot.evidence.map((e) => e.id) }], 'base');
    expect(store.matter(matter.id)?.state).toBe('resolved');
    store.record(message({ version: '1792490403.000001', text: 'Please reopen the release for next Friday' }), NOW);
    snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], [{ ...matter, evidence: snapshot.evidence.map((e) => e.id), reopen: true }], 'base');
    expect(store.matter(matter.id)?.state).toBe('open');
  });

  it('invalidates stale matter state and pending reminders after edits or revoked access', () => {
    const matter = populate();
    store.enqueueDelivery(delivery('first', matter));
    store.record(message({ version: '1792490402.000001', text: 'Release cancelled' }), NOW);
    expect(store.matter(matter.id)?.valid).toBe(false);
    expect(store.deliveries('pending')).toEqual([]);
    expect(store.search('release', ['C1'])).toEqual([]);
    store.channel('C1', false, false);
    expect(store.snapshot('C1', matter.thread)).toBeNull();
  });

  it('rejects late extraction and citations from other source threads', () => {
    store.record(message(), NOW);
    const snapshot = store.snapshot('C1', message().thread)!;
    store.record(message({ version: '1792490402.000001', text: 'Release Monday' }), NOW);
    expect(store.apply([snapshot], [], [], 'base')).toBe(false);
    const current = store.snapshot('C1', message().thread)!;
    expect(() => store.apply([current], [{ id: 'bad', channel: 'C1', thread: message().thread, kind: 'decision', text: 'bad', evidence: [999] }], [], 'base')).toThrow('outside');
    expect(store.dirty()).toHaveLength(1);
  });

  it('scopes FTS recall and preserves a human dismissal through re-extraction', () => {
    const matter = populate();
    expect(store.search('Friday', ['C1'])).toHaveLength(1);
    expect(store.search('Friday', ['C2'])).toEqual([]);
    store.feedback(matter.id, 'not useful', NOW);
    const snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], [{ ...matter, state: 'open' }], 'base');
    expect(store.matter(matter.id)?.state).toBe('dismissed');
  });

  it('expires raw content after 30 days and evidence validity after 90', () => {
    const matter = populate();
    store.expire(NOW + 31 * 86_400_000);
    expect(store['row']('SELECT text,excerpt FROM revisions')?.text).toBe('');
    expect(store.snapshot('C1', matter.thread)?.evidence[0]?.text).toBe('Release Friday');
    store.expire(NOW + 91 * 86_400_000);
    expect(store.snapshot('C1', matter.thread)?.evidence).toEqual([]);
    expect(store.search('Friday', ['C1'])).toEqual([]);
    expect(store.matter(matter.id)?.valid).toBe(false);
  });
});

describe('durable admission', () => {
  it('leases work to one worker and refuses an expired worker completion', () => {
    store.schedule('extract', 'C1', NOW);
    const first = store.claim(NOW, 100)!;
    expect(store.claim(NOW)).toBeNull();
    const replacement = store.claim(NOW + 101)!;
    expect(store.finish(first)).toBe(false);
    expect(store.finish(replacement)).toBe(true);
  });

  it('atomically caps routine and priority spending across two connections', () => {
    const second = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
    try {
      expect(store.reserve(150_000_000, false, NOW)).toBeTruthy();
      expect(second.reserve(1, false, NOW)).toBeNull();
      expect(second.reserve(50_000_000, true, NOW)).toBeTruthy();
      expect(store.reserve(1, true, NOW)).toBeNull();
    } finally { second.close(); }
  });

  it('retains uncertain liabilities across midnight and replaces them with daily debits', () => {
    const before = Date.parse('2026-10-20T22:59:00Z');
    const after = Date.parse('2026-10-20T23:01:00Z');
    const id = store.reserve(150_000_000, false, before)!;
    expect(lisbonDay(before)).not.toBe(lisbonDay(after));
    expect(store.budget(after)).toBe(150_000_000);
    store.settle(id, 140_000_000, after);
    expect(store.budget(before)).toBe(140_000_000);
    expect(store.budget(after)).toBe(140_000_000);
    expect(store.reserve(10_000_000, false, after)).toBeTruthy();
    expect(store.reserve(1, false, after)).toBeNull();
    expect(store.budget(after + 86_400_000)).toBe(10_000_000);
  });

  it('accounts for known overruns and stops admitting unverified pricing', () => {
    const id = store.reserve(100, false, NOW)!;
    store.settle(id, 101, NOW);
    expect(store.budget(NOW)).toBe(101);
    expect(store.reserve(1, false, NOW)).toBeNull();
    expect(() => store.reserve(NaN, false, NOW)).toThrow();
    store.settle(id, 0, NOW);
    expect(store.budget(NOW)).toBe(101);
  });

  it('reserves at most two extra notification slots and reconciles interrupted sending', () => {
    store.set('delivery_enabled', 'true');
    const matter = populate();
    for (let i = 0; i < 3; i++) store.enqueueDelivery(delivery(String(i), matter));
    expect(store.admitDelivery('0', NOW)).toBe(true);
    expect(store.admitDelivery('1', NOW)).toBe(true);
    expect(store.admitDelivery('2', NOW)).toBe(false);
    store.close();
    store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW);
    store.acquireRunner('recovered', NOW);
    expect(store.deliveries('uncertain')).toHaveLength(2);
    expect(store.admitDelivery('2', NOW)).toBe(false);
  });

  it('preserves work rescheduled during a lease without overlapping it', () => {
    store.schedule('investigate', 'm1', NOW, 'old');
    const job = store.claim(NOW)!;
    store.schedule('investigate', 'm1', NOW + 1, 'new');
    expect(store.claim(NOW + 1)).toBeNull();
    expect(store.owns(job)).toBe(false);
    expect(store.finish(job)).toBe(false);
    expect(store.claim(NOW + 2)?.payload).toBe('new');
  });

  it('keeps the scheduler exclusive until its persisted lease expires', () => {
    expect(store.acquireRunner('first', NOW)).toBe(true);
    expect(store.acquireRunner('second', NOW + 1)).toBe(false);
    expect(store.acquireRunner('second', NOW + 600_001)).toBe(true);
  });
});

describe('review regressions', () => {
  it('includes the newest cancellation and declares truncated context', () => {
    for (let i = 0; i <= 200; i++) store.record(message({ ts: `1792490401.${String(i).padStart(6, '0')}`, text: i === 200 ? 'CANCELLED' : `message ${i}` }), NOW);
    const snapshot = store.snapshot('C1', message().thread)!;
    expect(snapshot.evidence).toHaveLength(200);
    expect(snapshot.evidence.at(-1)?.text).toBe('CANCELLED');
    expect(snapshot.gap).toContain('omitted');
  });

  it('advances revision order even when a newer edit repeats the same text', () => {
    store.record(message({ version: '1792490402.000001' }), NOW);
    store.record(message({ version: '1792490404.000001' }), NOW);
    expect(store.record(message({ version: '1792490403.000001', text: 'Stale Monday' }), NOW)).toBeNull();
    expect(store.snapshot('C1', message().thread)?.evidence[0]?.text).toBe('Release Friday');
  });

  it('rejects a pre-expiry extraction and a pre-revocation extraction after restoration', () => {
    populate();
    const snapshot = store.snapshot('C1', message().thread)!;
    store.channel('C1', false, false);
    store.channel('C1', true, false);
    expect(store.apply([snapshot], [], [], 'base')).toBe(false);
    const restored = store.snapshot('C1', message().thread)!;
    store.expire(NOW + 91 * 86_400_000);
    expect(store.apply([restored], [], [], 'base')).toBe(false);
  });

  it('lets cancellation resolve a snoozed commitment', () => {
    const matter = populate();
    store.feedback(matter.id, 'later', NOW, NOW + 86_400_000);
    const snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], [{ ...matter, state: 'resolved' }], 'base');
    expect(store.matter(matter.id)?.state).toBe('resolved');
  });

  it('does not let resolved matters starve open matters', () => {
    const matter = populate();
    const snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], Array.from({ length: 101 }, (_, i) => ({ ...matter, id: `m${i}`, state: i < 100 ? 'resolved' as const : 'open' as const })), 'base');
    expect(store.matters()).toHaveLength(2);
    expect(store.matters().some((m) => m.id === 'm100')).toBe(true);
  });

  it('does not dirty the observation queue for Archie output', () => {
    store.record(message({ own: true }), NOW);
    expect(store.dirty()).toEqual([]);
  });

  it('invalidates edited Archie context already present in a human discussion', () => {
    const matter = populate();
    store.record(message({ ts: '1792490402.000001', version: '1792490402.000001', text: 'Proposed schedule', own: true }), NOW);
    const snapshot = store.snapshot('C1', matter.thread)!;
    store.apply([snapshot], [], [{ ...matter, evidence: snapshot.evidence.map((e) => e.id) }], 'base');
    store.enqueueDelivery(delivery('context-reminder', store.matter(matter.id)!));
    store.record(message({ ts: '1792490402.000001', version: '1792490403.000001', text: 'Schedule revised', own: true }), NOW);
    expect(store.matter(matter.id)?.valid).toBe(false);
    expect(store.deliveries('pending')).toEqual([]);
    expect(store.current([snapshot])).toBe(false);
  });
});
