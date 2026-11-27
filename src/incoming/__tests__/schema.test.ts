// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../schema.js';
import { IncomingStore } from '../store.js';

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-schema-'));
  path = join(root, 'state.sqlite');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function prepare(sql: string): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}

function inspect() {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      tables: db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((table) => table.name),
    };
  } finally {
    db.close();
  }
}

it('creates the inbox in an empty database and reopens it with its inputs', () => {
  const first = new IncomingStore(path);
  first.insertInput(
    {
      id: 'inp-1',
      state: 'enabled',
      auth: 'bearer',
      secretRefs: ['sec-1'],
      filter: [],
      routines: [],
      revision: 1,
      owner: null,
      purpose: '',
    },
    Date.now(),
  );
  first.close();

  const reopened = new IncomingStore(path);
  expect(reopened.input('inp-1')).toMatchObject({ state: 'enabled', secretRefs: ['sec-1'] });
  reopened.close();
  expect(inspect()).toEqual({
    version: SCHEMA_VERSION,
    tables: ['handoffs', 'inputs', 'payloads', 'receipts'],
  });
});

/** The schema as the first release created it, with one input, receipt, body and handoff. */
const VERSION_1 = `
  CREATE TABLE inputs (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('enabled','paused','deleted')),
    auth TEXT NOT NULL CHECK(auth IN ('standard_webhooks','bearer')),
    secret_refs TEXT NOT NULL,
    filter TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    input_id TEXT NOT NULL REFERENCES inputs(id),
    input_revision INTEGER NOT NULL,
    binding TEXT NOT NULL,
    event_key TEXT,
    digest TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('open','closed','ignored')),
    ignored_reason TEXT CHECK(ignored_reason IN ('paused','filtered')),
    conflicts INTEGER NOT NULL DEFAULT 0,
    last_conflict_at INTEGER,
    received_at INTEGER NOT NULL,
    UNIQUE(input_id, binding, event_key)
  );
  CREATE TABLE payloads (
    receipt_id TEXT PRIMARY KEY REFERENCES receipts(id),
    body BLOB NOT NULL
  );
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    consumer_kind TEXT NOT NULL,
    consumer_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','accepted','skipped','cancelled','failed')),
    token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    reservation TEXT,
    UNIQUE(receipt_id, consumer_kind, consumer_id)
  );
  CREATE INDEX due_handoffs ON handoffs(due_at, lease_until) WHERE state='pending';
  CREATE INDEX receipts_by_age ON receipts(received_at);
  INSERT INTO inputs VALUES ('inp-1','enabled','bearer','["sec-1"]','[]',1,1000);
  INSERT INTO receipts(id,input_id,input_revision,binding,event_key,digest,outcome,received_at)
    VALUES ('rcp-1','inp-1',1,'generic','msg_a','d1','open',2000);
  INSERT INTO payloads VALUES ('rcp-1', x'7B7D');
  INSERT INTO handoffs(id,receipt_id,consumer_kind,consumer_id,snapshot,state,due_at)
    VALUES ('hnd-1','rcp-1','routine','trg-1','{}','pending',2000);
  PRAGMA user_version=1;
`;

it('opens a version 1 inbox as the current version with its rows intact', () => {
  prepare(VERSION_1);

  const store = new IncomingStore(path);

  expect(store.input('inp-1')).toEqual({
    id: 'inp-1',
    state: 'enabled',
    auth: 'bearer',
    secretRefs: ['sec-1'],
    filter: [],
    routines: [],
    revision: 1,
    owner: null,
    purpose: '',
  });
  expect(store.receipt('rcp-1')).toMatchObject({ eventKey: 'msg_a', outcome: 'open' });
  const claimed = store.claimHandoff(3000, 1000);
  expect(claimed?.handoff).toMatchObject({ id: 'hnd-1', consumerId: 'trg-1', attempts: 1 });
  expect(Buffer.from(claimed?.body ?? []).toString()).toBe('{}');
  store.close();
  expect(inspect().version).toBe(SCHEMA_VERSION);

  const db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare('SELECT reason FROM handoffs').all()).toEqual([{ reason: null }]);
  db.close();
});

it('refuses a database written by a newer binary and leaves it untouched', () => {
  prepare(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);

  expect(() => new IncomingStore(path)).toThrow(/newer than this binary/);
  expect(inspect()).toEqual({ version: SCHEMA_VERSION + 1, tables: [] });
});

it('refuses an unversioned database that already holds tables', () => {
  prepare('CREATE TABLE unrelated (id TEXT)');

  expect(() => new IncomingStore(path)).toThrow(/not empty/);
  expect(inspect()).toEqual({ version: 0, tables: ['unrelated'] });
});

it('refuses a delivery for an input that does not exist', () => {
  const store = new IncomingStore(path);
  const delivery = {
    inputId: 'inp-missing',
    binding: 'generic',
    eventKey: null,
    digest: 'unused',
    body: new Uint8Array(),
    receivedAt: Date.now(),
  };

  expect(store.receive(delivery, [])).toEqual({ status: 'deleted' });
  store.close();
});

it('keeps a deleted input deleted', () => {
  const store = new IncomingStore(path);
  store.insertInput(
    {
      id: 'inp-1',
      state: 'enabled',
      auth: 'bearer',
      secretRefs: ['sec-1'],
      filter: [],
      routines: [],
      revision: 1,
      owner: null,
      purpose: '',
    },
    Date.now(),
  );

  expect(store.pauseInput('inp-1')?.state).toBe('paused');
  expect(store.markInputDeleted('inp-1')?.state).toBe('deleted');
  expect(store.resumeInput('inp-1')?.state).toBe('deleted');
  expect(store.pauseInput('inp-missing')).toBeNull();
  store.close();
});
