// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'archie-schema-')); path = join(root, 'state.sqlite'); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('creates only the base schema and reopens without resetting evidence, owner enablement or liability', () => {
  const store = new InitiativeStore(path, 'T1', NOW);
  store.channel('C1', true, false);
  store.record({ channel: 'C1', thread: '1792490401.000001', ts: '1792490401.000001', version: '1792490401.000001', author: 'U1', text: 'Review the release.' }, NOW);
  store.set('owner', 'U1'); store.set('delivery_enabled', 'true');
  const charge = store.reserve(50_000, false, NOW)!;
  store.dispatchRequest(charge, 'claude-haiku-5-5', 'request-fingerprint');
  store.close();
  const reopened = new InitiativeStore(path, 'T1', NOW + 86_400_000, { owner: 'U1' });
  try {
    expect(reopened.setting('watermark')).toBe(String(NOW / 1000));
    expect(reopened.setting('delivery_enabled')).toBe('true');
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

it('keeps diagnostics read-only and rejects a different workspace or owner', () => {
  const store = new InitiativeStore(path, 'T1', NOW);
  store.set('owner', 'U1'); store.close();
  const before = readFileSync(path);
  for (const readOnly of [false, true]) {
    expect(() => new InitiativeStore(path, 'T_OTHER', NOW, { readOnly })).toThrow('workspace mismatch');
    expect(() => new InitiativeStore(path, 'T1', NOW, { readOnly, owner: 'U_OTHER' })).toThrow('owner mismatch');
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
