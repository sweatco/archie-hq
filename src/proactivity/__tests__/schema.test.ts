// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const DAY = 86_400_000;
let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'archie-schema-')); path = join(root, 'state.sqlite'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('reopens schema 12 without resetting evidence, historical settings or unresolved liability', () => {
  const store = new InitiativeStore(path, 'T1', NOW);
  store.channel('C1', true, false);
  store.record({ channel: 'C1', thread: '1792490401.000001', ts: '1792490401.000001', version: '1792490401.000001', author: 'U1', text: 'Review the release.' }, NOW);
  store.set('owner', 'U1'); store.set('delivery_enabled', 'true');
  for (const key of ['mute', 'pause', 'stop']) store.set(key, 'true');
  const charge = store.reserve(50_000, false, NOW)!;
  store.dispatchRequest(charge, 'claude-haiku-5-5', 'request-fingerprint');
  store.close();
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', 'U_OTHER');
  const reopened = new InitiativeStore(path, 'T1', NOW + 86_400_000);
  try {
    expect(reopened.setting('watermark')).toBe(String(NOW / 1000));
    expect(reopened.setting('delivery_enabled')).toBe('true');
    expect(reopened.setting('owner')).toBe('U1');
    for (const key of ['mute', 'pause', 'stop']) expect(reopened.setting(key)).toBe('true');
    expect(reopened.snapshot('C1', '1792490401.000001')?.evidence[0].text).toBe('Review the release.');
    expect(reopened.budget(NOW + 86_400_000)).toBe(50_000);
    expect(reopened['row']('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
    expect(reopened['rows']("SELECT name FROM sqlite_master WHERE name IN ('batches','policies','episodes','replays','evaluations','policy_training','policy_inputs','cohorts','cohort_predictions')")).toEqual([]);
    const plan = reopened['rows'](`EXPLAIN QUERY PLAN SELECT * FROM handoffs WHERE card_retry<=?
      AND card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END
      ORDER BY card_retry,approved LIMIT 10`, NOW);
    expect(JSON.stringify(plan)).toContain('pending_handoff_cards');
  } finally { reopened.close(); }
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, SCHEMA_VERSION + 1])('rejects unsupported schema %i without changing its data or journal mode', version => {
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE old_state (payload TEXT); INSERT INTO old_state VALUES ('Keep this evidence and unresolved charge'); PRAGMA user_version=${version}`);
  old.close();
  const before = readFileSync(path);
  for (const readOnly of [false, true]) {
    expect(() => new InitiativeStore(path, 'T1', NOW, { readOnly })).toThrow(version > SCHEMA_VERSION ? 'newer than this binary' : 'requires a fresh database');
    expect(readFileSync(path)).toEqual(before);
  }
});

it('does not overwrite an unversioned database that already contains data', () => {
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE old_state (payload TEXT); INSERT INTO old_state VALUES ('Keep this data')"); old.close();
  const before = readFileSync(path);
  expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow('not empty');
  expect(readFileSync(path)).toEqual(before);
});

it('keeps diagnostics read-only and rejects a different workspace', () => {
  const store = new InitiativeStore(path, 'T1', NOW);
  store.set('owner', 'U1'); store.close();
  const before = readFileSync(path);
  for (const readOnly of [false, true]) {
    expect(() => new InitiativeStore(path, 'T_OTHER', NOW, { readOnly })).toThrow('workspace mismatch');
    expect(readFileSync(path)).toEqual(before);
  }
  const reader = new InitiativeStore(path, 'T1', NOW, { readOnly: true });
  try {
    reader.search('release', ['C1']); reader.explain('unknown'); reader.listProposals();
    expect(reader['row']('SELECT total_changes() AS n')?.n).toBe(0);
    expect(() => reader.set('mutation', 'denied')).toThrow();
  } finally { reader.close(); }
});

it('rolls back interrupted initialization instead of leaving a partial schema', () => {
  const exec = DatabaseSync.prototype.exec;
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    return exec.call(this, sql.includes('CREATE TABLE requests') ? sql + '; SELECT missing_initialization_check' : sql);
  });
  expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow('missing_initialization_check');
  fault.mockRestore();
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
  } finally { db.close(); }
  new InitiativeStore(path, 'T1', NOW).close();
});

function legacyDatabase() {
  const store = new InitiativeStore(path, 'T1', NOW);
  store.set('owner', 'U_ADMIN'); store.set('delivery_enabled', 'true');
  const charge = store.reserve(50_000, false, NOW)!;
  store.dispatchRequest(charge, 'claude-haiku-5-5', 'unsettled-request');
  for (const state of ['pending', 'sending', 'uncertain', 'sent']) {
    store['run']('INSERT INTO deliveries(id,channel,text,matters,evidence,digest,state,created,slot_day) VALUES (?,?,?,?,?,?,?,?,?)',
      state, 'D_ADMIN', 'Retain this card', '[]', '[]', 0, state, NOW, state === 'pending' ? null : '2026-10-20');
  }
  store.approveHandoff({ proposal: 'proposal', version: 'version', actor: 'U_ADMIN', approved: NOW, task: 'task', state: 'approved', budget: 'task', delivery: 'sent' });
  store.close();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE deliveries DROP COLUMN recipient; PRAGMA user_version=11'); db.close();
}

it('migrates supported schema 11 transactionally without reassigning deliveries, approvals or unresolved charges', () => {
  legacyDatabase();
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', 'U_OTHER');
  const store = new InitiativeStore(path, 'T1', NOW + DAY);
  try {
    for (const state of ['pending', 'sending', 'uncertain', 'sent']) {
      expect(store.delivery(state)).toMatchObject({ state, channel: 'D_ADMIN', recipient: 'U_ADMIN', text: 'Retain this card' });
    }
    expect(store.setting('delivery_enabled')).toBe('true');
    expect(store.handoff('proposal')).toMatchObject({ actor: 'U_ADMIN', state: 'approved', delivery: 'sent' });
    expect(store.budget(NOW + DAY)).toBe(50_000);
    expect(store['row']('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
  } finally { store.close(); }
});

it('leaves schema 11 unchanged for read-only inspection, mismatched workspace or an interrupted migration', () => {
  legacyDatabase();
  const before = readFileSync(path);
  expect(() => new InitiativeStore(path, 'T1', NOW, { readOnly: true })).toThrow('requires a fresh database');
  expect(() => new InitiativeStore(path, 'T_OTHER', NOW)).toThrow('workspace mismatch');
  expect(readFileSync(path)).toEqual(before);
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    return exec.call(this, sql.includes('ADD COLUMN recipient') ? sql + '; SELECT interrupted_migration' : sql);
  });
  expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow('interrupted_migration');
  expect(readFileSync(path)).toEqual(before);
});

it.each([false, true])('migrates schema 11 public-only history with null recipients, historical owner=%s', savedOwner => {
  legacyDatabase();
  const db = new DatabaseSync(path);
  db.exec("UPDATE deliveries SET channel='C1',thread='1792490401.000001'");
  if (!savedOwner) db.exec("DELETE FROM settings WHERE key='owner'");
  db.close();
  const store = new InitiativeStore(path, 'T1', NOW + DAY);
  try {
    expect(store['rows']('SELECT recipient FROM deliveries')).toEqual(Array(4).fill({ recipient: null }));
    expect(store.handoff('proposal')).toMatchObject({ actor: 'U_ADMIN', state: 'approved' });
    expect(store.budget(NOW + DAY)).toBe(50_000);
  } finally { store.close(); }
});

it('rejects schema 11 private history without saved identity transactionally, even with an obsolete environment owner', () => {
  legacyDatabase();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM settings WHERE key='owner'"); db.close();
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', 'U_ADMIN');
  const before = readFileSync(path);
  expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow('Legacy private delivery recipient unavailable');
  expect(readFileSync(path)).toEqual(before);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(11);
    expect(unchanged.prepare('SELECT count(*) AS n FROM deliveries').get()?.n).toBe(4);
    expect(unchanged.prepare('SELECT state FROM handoffs').get()?.state).toBe('approved');
    expect(unchanged.prepare('SELECT settled FROM charges').get()?.settled).toBeNull();
    expect(unchanged.prepare('PRAGMA table_info(deliveries)').all().map(column => column.name)).not.toContain('recipient');
  } finally { unchanged.close(); }
});

it('preserves schema 12 deliveries, approvals and financial records exactly when reopening without an administrator', () => {
  legacyDatabase();
  const migrated = new InitiativeStore(path, 'T1', NOW);
  migrated.set('pause', 'true'); migrated.set('stop', 'true'); migrated.set('mute', 'true');
  const tables = ['settings', 'deliveries', 'handoffs', 'charges', 'charge_scopes', 'requests', 'debits'];
  const before = tables.map(table => migrated['rows'](`SELECT * FROM ${table} ORDER BY rowid`));
  migrated.close();
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', 'invalid');
  const reopened = new InitiativeStore(path, 'T1', NOW + DAY);
  try {
    expect(tables.map(table => reopened['rows'](`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    expect(reopened['row']('PRAGMA user_version')?.user_version).toBe(12);
    expect(reopened.budget(NOW + DAY)).toBe(50_000);
  } finally { reopened.close(); }
});
