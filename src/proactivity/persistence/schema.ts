// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';

// Earlier versions belonged to the retired experimental schema.
export const SCHEMA_VERSION = 11;

export function initializeSchema(db: DatabaseSync, team: string, now: number, owner?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Unversioned initiative database is not empty; use a fresh database');
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE channels (id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, shared INTEGER NOT NULL, checkpoint TEXT NOT NULL, cursor TEXT, gap TEXT);
        CREATE TABLE threads (channel TEXT NOT NULL, thread TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL, gap TEXT, PRIMARY KEY(channel,thread));
        CREATE TABLE revisions (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, version TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, excerpt TEXT NOT NULL, deleted INTEGER NOT NULL, own INTEGER NOT NULL, captured INTEGER NOT NULL, hash TEXT NOT NULL, bot INTEGER NOT NULL, UNIQUE(channel,ts,version,hash));
        CREATE TABLE messages (channel TEXT NOT NULL, ts TEXT NOT NULL, revision INTEGER NOT NULL REFERENCES revisions(id), PRIMARY KEY(channel,ts));
        CREATE TABLE source_events (id TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, seen INTEGER NOT NULL);
        CREATE TABLE observations (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL, kind TEXT NOT NULL, valid INTEGER NOT NULL);
        CREATE VIRTUAL TABLE observation_search USING fts5(id UNINDEXED,text);
        CREATE TABLE matters (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, body TEXT NOT NULL, valid INTEGER NOT NULL, next_check INTEGER NOT NULL);
        CREATE TABLE jobs (kind TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, due INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0, token TEXT, attempts INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,target));
        CREATE TABLE deliveries (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT, text TEXT NOT NULL, matters TEXT NOT NULL, evidence TEXT NOT NULL, digest INTEGER NOT NULL, state TEXT NOT NULL, ts TEXT, created INTEGER NOT NULL, slot_day TEXT, proposal TEXT);
        CREATE TABLE charges (id TEXT PRIMARY KEY, maximum INTEGER NOT NULL CHECK(maximum>=0), admitted INTEGER NOT NULL, settled INTEGER, actual INTEGER);
        CREATE TABLE charge_scopes (charge TEXT PRIMARY KEY REFERENCES charges(id), scope TEXT NOT NULL);
        CREATE TABLE debits (charge TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(charge,day));
        CREATE TABLE requests (charge TEXT PRIMARY KEY, model TEXT NOT NULL, fingerprint TEXT NOT NULL, remote TEXT, usage TEXT, state TEXT NOT NULL);
        CREATE TABLE feedback (id INTEGER PRIMARY KEY, matter TEXT, action TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE proposals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE extractions (id TEXT PRIMARY KEY, created INTEGER NOT NULL, response TEXT NOT NULL);
        CREATE TABLE decisions (id INTEGER PRIMARY KEY, matter TEXT NOT NULL, at INTEGER NOT NULL, code TEXT NOT NULL, next_due INTEGER, evidence TEXT NOT NULL, delivery TEXT, requests TEXT NOT NULL);
        CREATE TABLE handoffs (proposal TEXT PRIMARY KEY, version TEXT NOT NULL, actor TEXT NOT NULL, approved INTEGER NOT NULL, task TEXT NOT NULL UNIQUE, state TEXT NOT NULL, budget TEXT NOT NULL CHECK(budget='task'), delivery TEXT NOT NULL, lease INTEGER NOT NULL DEFAULT 0, token TEXT, card_state TEXT, card_retry INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE coverage_gaps (channel TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(channel,code));
        CREATE TABLE matter_checks (matter TEXT PRIMARY KEY, signature TEXT NOT NULL, kind TEXT NOT NULL, checked INTEGER NOT NULL);
        CREATE INDEX revision_thread ON revisions(channel,thread);
        CREATE INDEX due_jobs ON jobs(due,lease);
        CREATE INDEX due_matters ON matters(valid,next_check);
        CREATE INDEX decisions_matter ON decisions(matter,id);
        CREATE INDEX pending_handoff_cards ON handoffs(card_retry,approved)
          WHERE card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END;
      `);
      const set = db.prepare('INSERT INTO settings VALUES (?,?)');
      for (const [key, value] of [['team', team], ['watermark', String(now / 1000)], ['delivery_enabled', 'false']]) set.run(key, value);
      db.exec('PRAGMA user_version=' + SCHEMA_VERSION);
    }
    validateSchema(db, team, owner);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function validateSchema(db: DatabaseSync, team: string, owner?: string): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > SCHEMA_VERSION) throw new Error('Observation database is newer than this binary');
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported initiative schema ${version}; this build requires a fresh database`);
  if (db.prepare("SELECT value FROM settings WHERE key='team'").get()?.value !== team) throw new Error('Observation workspace mismatch');
  const savedOwner = db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value;
  if (owner && savedOwner && owner !== savedOwner) throw new Error('Observation owner mismatch');
}
