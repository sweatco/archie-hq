// SPDX-License-Identifier: AGPL-3.0-or-later
import { proposalVersion } from '../proposals.js';
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 9;

export function migrate(db: DatabaseSync, team: string, now: number, owner?: string): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > SCHEMA_VERSION) throw new Error('Observation database is newer than this binary');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version < 4) {
      db.exec(`
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, shared INTEGER NOT NULL, checkpoint TEXT NOT NULL, cursor TEXT, gap TEXT);
          CREATE TABLE IF NOT EXISTS threads (channel TEXT NOT NULL, thread TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL, PRIMARY KEY(channel,thread));
          CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, version TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, excerpt TEXT NOT NULL, deleted INTEGER NOT NULL, own INTEGER NOT NULL, captured INTEGER NOT NULL, hash TEXT NOT NULL, UNIQUE(channel,ts,version,hash));
          CREATE TABLE IF NOT EXISTS messages (channel TEXT NOT NULL, ts TEXT NOT NULL, revision INTEGER NOT NULL REFERENCES revisions(id), PRIMARY KEY(channel,ts));
          CREATE TABLE IF NOT EXISTS source_events (id TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, seen INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL, kind TEXT NOT NULL, valid INTEGER NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS observation_search USING fts5(id UNINDEXED,text);
          CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, body TEXT NOT NULL, valid INTEGER NOT NULL, next_check INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (kind TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, due INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0, token TEXT, attempts INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,target));
          CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT, text TEXT NOT NULL, matters TEXT NOT NULL, evidence TEXT NOT NULL, policy TEXT NOT NULL, digest INTEGER NOT NULL, state TEXT NOT NULL, ts TEXT, created INTEGER NOT NULL, slot_day TEXT);
          CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY, maximum INTEGER NOT NULL CHECK(maximum>=0), admitted INTEGER NOT NULL, settled INTEGER, actual INTEGER);
          CREATE TABLE IF NOT EXISTS charge_scopes (charge TEXT PRIMARY KEY REFERENCES charges(id), scope TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS debits (charge TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(charge,day));
          CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, matter TEXT, action TEXT NOT NULL, created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, body TEXT NOT NULL, base TEXT NOT NULL, evidence TEXT NOT NULL, evaluation TEXT, state TEXT NOT NULL DEFAULT 'proposed');
          CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending filing', issue TEXT);
          CREATE INDEX IF NOT EXISTS revision_thread ON revisions(channel,thread);
          CREATE INDEX IF NOT EXISTS due_jobs ON jobs(due,lease);
          CREATE INDEX IF NOT EXISTS due_matters ON matters(valid,next_check);

        `);
      if (!db.prepare('PRAGMA table_info(threads)').all().some(r => r.name === 'gap')) db.exec('ALTER TABLE threads ADD COLUMN gap TEXT');
      if (!db.prepare('PRAGMA table_info(revisions)').all().some(r => r.name === 'bot')) {
        db.exec('ALTER TABLE revisions ADD COLUMN bot INTEGER NOT NULL DEFAULT 1');
        db.exec("UPDATE threads SET generation=generation+1; UPDATE observations SET valid=0; UPDATE matters SET valid=0; UPDATE deliveries SET state='cancelled' WHERE state='pending'");
      }
    }
    const identity = db.prepare("SELECT value FROM settings WHERE key='team'").get()?.value;
    const savedOwner = db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value;
    if (owner && savedOwner && savedOwner !== owner) throw new Error('Observation owner mismatch');
    if (identity && identity !== team) throw new Error('Observation workspace mismatch');
    if (!identity && db.prepare('SELECT id FROM revisions LIMIT 1').get()) throw new Error('Observation workspace identity missing');
    if (!identity) {
      const set = db.prepare('INSERT INTO settings VALUES (?,?)');
      set.run('team', team); set.run('watermark', String(now / 1000)); set.run('policy', 'base');
    }
    if (version < 5) db.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, remote TEXT, charge TEXT NOT NULL, request TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests (charge TEXT PRIMARY KEY, model TEXT NOT NULL, fingerprint TEXT NOT NULL, remote TEXT, usage TEXT, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, topic TEXT NOT NULL, observed INTEGER NOT NULL, payload TEXT NOT NULL, baseline TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replays (policy TEXT NOT NULL, episode TEXT NOT NULL, batch TEXT NOT NULL, prediction TEXT, label TEXT, PRIMARY KEY(policy,episode));
CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, policy TEXT NOT NULL, rubric TEXT NOT NULL, episodes TEXT NOT NULL, result TEXT NOT NULL, passed INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS policy_training (policy TEXT NOT NULL, episode TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL, topic TEXT, PRIMARY KEY(policy,episode));
CREATE TABLE IF NOT EXISTS policy_inputs (policy TEXT NOT NULL, episode TEXT NOT NULL, PRIMARY KEY(policy,episode));
CREATE TABLE IF NOT EXISTS cohorts (id TEXT PRIMARY KEY, policy TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cohort_predictions (cohort TEXT NOT NULL, episode TEXT NOT NULL, candidate TEXT, baseline TEXT, error TEXT, PRIMARY KEY(cohort,episode));
CREATE TABLE IF NOT EXISTS extractions (id TEXT PRIMARY KEY, created INTEGER NOT NULL, response TEXT NOT NULL);`);
    if (version < 6) db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, matter TEXT NOT NULL, at INTEGER NOT NULL, code TEXT NOT NULL, policy TEXT NOT NULL, next_due INTEGER, evidence TEXT NOT NULL, delivery TEXT, requests TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_matter ON decisions(matter,id);
      CREATE TABLE IF NOT EXISTS handoffs (proposal TEXT PRIMARY KEY, version TEXT NOT NULL, actor TEXT NOT NULL, approved INTEGER NOT NULL, task TEXT NOT NULL UNIQUE, state TEXT NOT NULL, budget TEXT NOT NULL CHECK(budget='task'), delivery TEXT NOT NULL, lease INTEGER NOT NULL DEFAULT 0, token TEXT);
      CREATE TABLE IF NOT EXISTS coverage_gaps (channel TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(channel,code));
      INSERT OR IGNORE INTO coverage_gaps SELECT id, CASE WHEN gap LIKE '%lookup failed%' THEN 'access' WHEN gap='Collection pagination pending' THEN 'pagination' ELSE 'unknown' END,gap FROM channels WHERE gap IS NOT NULL;

    `);
    if (version < 6 && !db.prepare('PRAGMA table_info(deliveries)').all().some(row => row.name === 'proposal')) db.exec('ALTER TABLE deliveries ADD COLUMN proposal TEXT');
    if (version < 6) {
      for (const row of db.prepare('SELECT id,body FROM proposals').all()) {
        const proposal = JSON.parse(String(row.body));
        db.prepare('UPDATE proposals SET body=? WHERE id=?').run(JSON.stringify({ ...proposal, version: proposalVersion(proposal) }), row.id);
      }
    }
    if (version < 7) db.exec('CREATE TABLE IF NOT EXISTS matter_checks (matter TEXT PRIMARY KEY, signature TEXT NOT NULL, kind TEXT NOT NULL, checked INTEGER NOT NULL)');
    if (version < 8) db.exec(`ALTER TABLE handoffs ADD COLUMN card_state TEXT;
      ALTER TABLE handoffs ADD COLUMN card_retry INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX pending_handoff_cards ON handoffs(card_retry,approved)
        WHERE card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END;`);
    if (version < 9) {
      // Learning state stays recoverable; neither old evaluation nor mode=live enables delivery.
      db.exec("INSERT OR REPLACE INTO settings VALUES ('delivery_enabled','false')");
      selectBaseline(db, now);
    }
    db.exec('PRAGMA user_version=' + SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function validateCurrentSchema(db: DatabaseSync, team: string, owner?: string): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > SCHEMA_VERSION) throw new Error('Observation database is newer than this binary');
  if (version !== SCHEMA_VERSION) throw new Error('Initiative database requires an explicit startup or migrate command before read-only access');
  if (db.prepare("SELECT value FROM settings WHERE key='team'").get()?.value !== team) throw new Error('Observation workspace mismatch');
  const savedOwner = db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value;
  if (owner && savedOwner && owner !== savedOwner) throw new Error('Observation owner mismatch');
}

export function selectBaseline(db: DatabaseSync, now: number): void {
  const policy = db.prepare("SELECT value FROM settings WHERE key='policy'").get()?.value;
  if (policy && policy !== 'base') {
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('deferred_policy',?)").run(policy);
    db.exec("UPDATE settings SET value='base' WHERE key='policy'; UPDATE threads SET generation=generation+1");
    db.prepare("INSERT INTO jobs(kind,target,payload,due) VALUES ('extract','global','{}',?) ON CONFLICT(kind,target) DO UPDATE SET due=MIN(due,excluded.due),generation=generation+1").run(now);
  }
}
