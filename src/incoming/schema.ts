// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './sqlite.js';

export const SCHEMA_VERSION = 1;

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  assert(row, 'SQLite did not return its schema version');
  return Number(row.user_version);
}

/** Creates the inbox in an empty database and refuses any database it does not recognise. */
export function initializeSchema(db: DatabaseSync): void {
  inTransaction(db, () => {
    const version = schemaVersion(db);
    if (version > SCHEMA_VERSION)
      throw new Error('Incoming events database is newer than this binary');
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
        throw new Error('Unversioned incoming events database is not empty; use a fresh database');
      db.exec(`
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
      `);
      db.exec('PRAGMA user_version=' + SCHEMA_VERSION);
    }
  });
}
