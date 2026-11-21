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
      revision: 1,
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

  expect(store.receive(delivery, [])).toEqual({ status: 'unavailable', reason: 'unknown' });
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
      revision: 1,
    },
    Date.now(),
  );

  expect(store.pauseInput('inp-1')?.state).toBe('paused');
  expect(store.markInputDeleted('inp-1')?.state).toBe('deleted');
  expect(store.resumeInput('inp-1')?.state).toBe('deleted');
  expect(store.pauseInput('inp-missing')).toBeNull();
  store.close();
});
