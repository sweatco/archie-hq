// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { Delivery, Evidence, Job, Matter, Observation, SourceMessage, ThreadSnapshot } from './observation-types.js';
import { lisbonDay } from './observation-types.js';

type Row = Record<string, string | number | null>;
const DAY = 86_400_000;

export class ObservationStore {
  private readonly db: DatabaseSync;

  constructor(path: string, team: string, now = Date.now()) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = Number(this.row('PRAGMA user_version')?.user_version);
      if (version > 4) throw new Error('Observation database is newer than this binary');
      this.transaction(() => {
        this.db.exec(`
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
          PRAGMA user_version=1;
        `);
        if (!this.rows('PRAGMA table_info(threads)').some((r) => r.name === 'gap')) this.db.exec('ALTER TABLE threads ADD COLUMN gap TEXT');
        if (!this.rows('PRAGMA table_info(revisions)').some((r) => r.name === 'bot')) {
          this.db.exec('ALTER TABLE revisions ADD COLUMN bot INTEGER NOT NULL DEFAULT 1');
          this.db.exec("UPDATE threads SET generation=generation+1; UPDATE observations SET valid=0; UPDATE matters SET valid=0; UPDATE deliveries SET state='cancelled' WHERE state='pending'");
        }
        this.db.exec('PRAGMA user_version=4');
        const storedTeam = this.setting('team');
        if (storedTeam && storedTeam !== team) throw new Error('Observation workspace mismatch');
        if (!storedTeam && this.row('SELECT id FROM revisions LIMIT 1')) throw new Error('Observation workspace identity missing');
        if (!storedTeam) {
          this.set('team', team);
          this.set('watermark', String(now / 1000));
          this.set('policy', 'base');
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }
  row(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  rows(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  setting(key: string): string | undefined { return this.row('SELECT value FROM settings WHERE key=?', key)?.value as string | undefined; }
  set(key: string, value: string): void { this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }

  acquireRunner(owner: string, now: number): boolean {
    return this.transaction(() => {
      const previous = JSON.parse(this.setting('runner') ?? 'null') as { owner: string; until: number } | null;
      if (previous && previous.owner !== owner && previous.until > now) return false;
      if (previous?.owner !== owner) {
        // A previous process may have sent a message before persisting Slack's response.
        this.run("UPDATE deliveries SET state='uncertain' WHERE state='sending'");
      }
      this.set('runner', JSON.stringify({ owner, until: now + 600_000 }));
      return true;
    });
  }

  releaseRunner(owner: string): void {
    this.transaction(() => {
      if ((JSON.parse(this.setting('runner') ?? 'null') as { owner: string } | null)?.owner === owner) this.run("DELETE FROM settings WHERE key='runner'");
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  channel(id: string, allowed: boolean, shared: boolean, gap?: string | null): void {
    this.transaction(() => {
      this.run(`INSERT INTO channels VALUES (?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET allowed=excluded.allowed,shared=excluded.shared,gap=CASE WHEN ? THEN excluded.gap ELSE channels.gap END`,
        id, Number(allowed), Number(shared), this.setting('watermark')!, gap ?? null, Number(gap !== undefined));
      if (!allowed) this.invalidate(id);
    });
  }

  private invalidate(channel: string, thread?: string): void {
    const clause = thread === undefined ? 'channel=?' : 'channel=? AND thread=?';
    const args = thread === undefined ? [channel] : [channel, thread];
    this.run(`UPDATE threads SET generation=generation+1 WHERE ${clause}`, ...args);
    this.run(`UPDATE observations SET valid=0 WHERE ${clause}`, ...args);
    this.run(`UPDATE matters SET valid=0 WHERE ${clause}`, ...args);
    this.run(`UPDATE deliveries SET state='cancelled' WHERE state='pending' AND EXISTS (
      SELECT 1 FROM json_each(deliveries.matters) j JOIN matters m ON m.id=j.value WHERE m.valid=0)`);
    this.run(`UPDATE deliveries SET state='cancelled' WHERE state='pending' AND EXISTS (
      SELECT 1 FROM json_each(deliveries.evidence) j JOIN revisions r ON r.id=j.value WHERE r.channel=?${thread === undefined ? '' : ' AND r.thread=?'})`, ...args);
  }

  record(message: SourceMessage, now = Date.now()): number | null {
    if (!/^\d+\.\d+$/.test(message.ts) || !/^\d+\.\d+$/.test(message.version)) return null;
    if (!this.row('SELECT id FROM channels WHERE id=? AND allowed=1', message.channel)) return null;
    if (!message.context && Math.max(Number(message.ts), Number(message.version)) < Number(this.setting('watermark'))) return null;
    return this.transaction(() => {
      if (message.eventId && !this.run('INSERT OR IGNORE INTO source_events VALUES (?,?,?,?)', message.eventId, message.channel, message.ts, now).changes) return null;
      const old = this.row('SELECT r.* FROM revisions r JOIN messages m ON m.revision=r.id WHERE m.channel=? AND m.ts=?', message.channel, message.ts);
      const hash = createHash('sha256').update(JSON.stringify([message.deleted === true, message.bot === true || message.own === true, message.text])).digest('hex');
      if (old && (old.deleted === 1 || Number(old.version) > Number(message.version) || (old.hash === hash && old.version === message.version))) return null;
      const result = this.run('INSERT INTO revisions(channel,thread,ts,version,author,text,excerpt,deleted,own,captured,hash,bot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        message.channel, message.thread, message.ts, message.version, message.author, message.text,
        message.text.slice(0, 2000), Number(message.deleted === true), Number(message.own === true), now, hash, Number(message.bot === true || message.own === true));
      const id = Number(result.lastInsertRowid);
      this.run('INSERT INTO messages VALUES (?,?,?) ON CONFLICT(channel,ts) DO UPDATE SET revision=excluded.revision', message.channel, message.ts, id);
      if (message.own) {
        if (old && this.row('SELECT generation FROM threads WHERE channel=? AND thread=?', message.channel, message.thread)) {
          this.invalidate(message.channel, message.thread);
          this.run('UPDATE threads SET changed=? WHERE channel=? AND thread=?', now, message.channel, message.thread);
        }
        return id;
      }
      this.run(`INSERT INTO threads(channel,thread,generation,changed) VALUES (?,?,1,?) ON CONFLICT(channel,thread) DO UPDATE SET generation=generation+1,changed=excluded.changed`,
        message.channel, message.thread, now);
      this.invalidate(message.channel, message.thread);
      return id;
    });
  }

  snapshot(channel: string, thread: string): ThreadSnapshot | null {
    const row = this.row('SELECT t.*,c.gap AS channel_gap FROM threads t JOIN channels c ON c.id=t.channel WHERE t.channel=? AND t.thread=? AND c.allowed=1', channel, thread);
    if (!row) return null;
    const rows = this.rows(`SELECT r.* FROM revisions r JOIN messages m ON m.revision=r.id WHERE r.channel=? AND r.thread=? AND r.deleted=0 ORDER BY CAST(r.ts AS REAL) DESC LIMIT 201`, channel, thread);
    const truncated = rows.length > 200;
    const evidence = rows.slice(0, 200).reverse()
      .filter((r) => r.text || r.excerpt)
      .map((r) => ({ id: Number(r.id), channel, thread, ts: String(r.ts), version: String(r.version), author: String(r.author),
        text: String(r.text || r.excerpt), own: r.own === 1, bot: r.bot === 1, captured: Number(r.captured) }));
    const gap = [row.channel_gap, row.gap, truncated ? 'Earlier thread context omitted; newest 200 messages retained' : null].filter(Boolean).join('; ') || null;
    const removed = this.rows('SELECT r.ts,r.version FROM revisions r JOIN messages m ON m.revision=r.id WHERE r.channel=? AND r.thread=? AND r.deleted=1 ORDER BY r.captured DESC LIMIT 20', channel, thread)
      .map((r) => ({ ts: String(r.ts), version: String(r.version) }));
    return { channel, thread, generation: Number(row.generation), evidence, gap, removed };
  }

  dirty(limit = 16): ThreadSnapshot[] {
    return this.rows('SELECT t.channel,t.thread FROM threads t JOIN channels c ON c.id=t.channel WHERE c.allowed=1 AND t.generation>t.processed ORDER BY t.changed LIMIT ?', limit)
      .map((r) => this.snapshot(String(r.channel), String(r.thread))!).filter(Boolean);
  }

  current(snapshots: ThreadSnapshot[]): boolean {
    return snapshots.every((s) => this.row('SELECT generation FROM threads t JOIN channels c ON c.id=t.channel WHERE t.channel=? AND t.thread=? AND c.allowed=1', s.channel, s.thread)?.generation === s.generation);
  }

  apply(snapshots: ThreadSnapshot[], observations: Observation[], matters: Matter[], policy: string, job?: Job): boolean {
    return this.transaction(() => {
      if ((job && !this.owns(job)) || this.setting('policy') !== policy || !this.current(snapshots)) return false;
      const allowed = new Set(snapshots.flatMap((s) => s.evidence.map((e) => e.id)));
      for (const item of [...observations, ...matters]) {
        const snapshot = snapshots.find((s) => s.channel === item.channel && s.thread === item.thread);
        if (!snapshot || !item.evidence.length || item.evidence.some((id) => !allowed.has(id) || !snapshot.evidence.some((e) => e.id === id))) {
          throw new Error('Result cites evidence outside its source thread');
        }
        if (item.evidence.every((id) => { const e = snapshot.evidence.find((e) => e.id === id)!; return e.own || e.bot; })) throw new Error('Own output or bot output cannot establish an observation');
        const previous = this.row('SELECT channel,thread FROM observations WHERE id=? UNION ALL SELECT channel,thread FROM matters WHERE id=?', item.id, item.id);
        if (previous && (previous.channel !== item.channel || previous.thread !== item.thread)) throw new Error('Observation identity collision');
      }
      for (const s of snapshots) {
        this.run('UPDATE observations SET valid=0 WHERE channel=? AND thread=?', s.channel, s.thread);
        this.run('UPDATE threads SET processed=? WHERE channel=? AND thread=?', s.generation, s.channel, s.thread);
      }
      for (const o of observations) {
        this.run('INSERT INTO observations VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET text=excluded.text,evidence=excluded.evidence,kind=excluded.kind,valid=1',
          o.id, o.channel, o.thread, o.text, JSON.stringify(o.evidence), o.kind);
        this.run('DELETE FROM observation_search WHERE id=?', o.id);
        this.run('INSERT INTO observation_search VALUES (?,?)', o.id, o.text);
      }
      for (let matter of matters) {
        const previous = this.matter(matter.id);
        // Human dismissals and snoozes survive extraction, including a message edit.
        if (previous && ['dismissed', 'snoozed'].includes(previous.state) && matter.state !== 'resolved') {
          matter = { ...matter, state: previous.state, nextCheck: previous.nextCheck };
        }
        if (previous?.state === 'resolved' && matter.state === 'open') {
          const oldHashes = new Set(previous.evidence.map((id) => this.row('SELECT hash FROM revisions WHERE id=?', id)?.hash));
          const changed = snapshots.flatMap((s) => s.evidence).some((e) => matter.evidence.includes(e.id) && !e.own && !e.bot && !oldHashes.has(this.row('SELECT hash FROM revisions WHERE id=?', e.id)?.hash));
          if (!matter.reopen || !changed) matter = { ...matter, state: 'resolved' };
        }
        this.run('INSERT INTO matters VALUES (?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,valid=1,next_check=excluded.next_check',
          matter.id, matter.channel, matter.thread, JSON.stringify(matter), matter.nextCheck);
      }
      return true;
    });
  }

  search(query: string, channels: string[], limit = 10): Observation[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12);
    if (!tokens?.length || !channels.length) return [];
    const match = tokens.map((t) => `"${t}"`).join(' OR ');
    return this.rows(`SELECT o.* FROM observation_search s JOIN observations o ON o.id=s.id JOIN channels c ON c.id=o.channel
      WHERE observation_search MATCH ? AND o.valid=1 AND c.allowed=1 AND o.channel IN (${channels.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`, match, ...channels, Math.min(20, limit))
      .map((r) => ({ id: String(r.id), channel: String(r.channel), thread: String(r.thread), text: String(r.text), evidence: JSON.parse(String(r.evidence)), kind: r.kind as Observation['kind'] }));
  }

  matter(id: string): Matter | null {
    const row = this.row('SELECT body,valid,next_check FROM matters WHERE id=?', id);
    return row ? { ...JSON.parse(String(row.body)), valid: row.valid === 1, nextCheck: Number(row.next_check) } : null;
  }

  matters(now = Number.MAX_SAFE_INTEGER): Matter[] {
    return this.rows("SELECT id FROM matters WHERE valid=1 AND next_check<=? AND json_extract(body,'$.state') IN ('open','snoozed') ORDER BY next_check LIMIT 100", now)
      .map((r) => this.matter(String(r.id))!);
  }

  threadMatters(channel: string, thread: string): Matter[] {
    return this.rows('SELECT id FROM matters WHERE channel=? AND thread=?', channel, thread).map((r) => this.matter(String(r.id))!);
  }

  feedback(id: string, action: string, now: number, later?: number): void {
    this.transaction(() => {
      this.run('INSERT INTO feedback(matter,action,created) VALUES (?,?,?)', id, action, now);
      const matter = this.matter(id);
      if (!matter) return;
      if (action === 'handled') matter.state = 'resolved';
      if (action === 'not useful' || action === 'stop following') matter.state = 'dismissed';
      if (action === 'later') { matter.state = 'snoozed'; matter.nextCheck = later!; }
      this.run('UPDATE matters SET body=?,next_check=? WHERE id=?', JSON.stringify(matter), matter.nextCheck, id);
      this.run("UPDATE deliveries SET state='cancelled' WHERE state='pending' AND EXISTS (SELECT 1 FROM json_each(matters) WHERE value=?)", id);
      if (action === 'later') this.schedule('investigate', id, later!);
      if (action === 'stop following') this.set(`unfollow:${matter.channel}:${matter.thread}`, 'true');
    });
  }

  schedule(kind: string, target: string, due: number, payload = '{}'): void {
    this.run('INSERT INTO jobs(kind,target,payload,due) VALUES (?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET due=MIN(jobs.due,excluded.due),payload=excluded.payload,generation=jobs.generation+1', kind, target, payload, due);
  }

  claim(now: number, leaseMs = 360_000): Job | null {
    return this.transaction(() => {
      const row = this.row('SELECT * FROM jobs WHERE due<=? AND lease<=? ORDER BY due LIMIT 1', now, now);
      if (!row) return null;
      const token = randomUUID();
      this.run('UPDATE jobs SET token=?,lease=?,attempts=attempts+1 WHERE kind=? AND target=?', token, now + leaseMs, row.kind, row.target);
      return { kind: String(row.kind), target: String(row.target), payload: String(row.payload), token, attempts: Number(row.attempts) + 1, generation: Number(row.generation) };
    });
  }

  finish(job: Job, next?: number): boolean {
    return this.transaction(() => {
      if (!this.owns(job)) {
        this.run('UPDATE jobs SET lease=0,token=NULL WHERE kind=? AND target=? AND token=?', job.kind, job.target, job.token);
        return false;
      }
      if (next === undefined) this.run('DELETE FROM jobs WHERE kind=? AND target=?', job.kind, job.target);
      else this.run('UPDATE jobs SET due=?,lease=0,token=NULL,attempts=0 WHERE kind=? AND target=?', next, job.kind, job.target);
      return true;
    });
  }

  owns(job: Job): boolean {
    return !!this.row('SELECT token FROM jobs WHERE kind=? AND target=? AND token=? AND generation=?', job.kind, job.target, job.token, job.generation);
  }

  reserve(maximum: number, priority: boolean, now: number, scope?: string, scopeLimit = 2_000_000): string | null {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Unbounded or invalid charge');
    return this.transaction(() => {
      const used = this.budget(now);
      if (this.setting('pricing_error')) return null;
      if (scope && Number(this.row('SELECT COALESCE(SUM(COALESCE(c.actual,c.maximum)),0) AS n FROM charges c JOIN charge_scopes s ON s.charge=c.id WHERE s.scope=?', scope)!.n) + maximum > scopeLimit) return null;
      if (used + maximum > (priority ? 200_000_000 : 150_000_000)) return null;
      const id = randomUUID();
      this.run('INSERT INTO charges VALUES (?,?,?,NULL,NULL)', id, maximum, now);
      if (scope) this.run('INSERT INTO charge_scopes VALUES (?,?)', id, scope);
      return id;
    });
  }

  budget(now: number): number {
    return Number(this.row('SELECT COALESCE(SUM(amount),0) AS n FROM debits WHERE day=?', lisbonDay(now))!.n)
      + Number(this.row('SELECT COALESCE(SUM(maximum),0) AS n FROM charges WHERE settled IS NULL AND admitted<=?', now)!.n);
  }

  settle(id: string, actual: number, now: number, executionDay?: string): void {
    if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('Invalid usage charge');
    this.transaction(() => {
      const charge = this.row('SELECT * FROM charges WHERE id=?', id);
      if (!charge || charge.settled !== null) return;
      if (actual > Number(charge.maximum)) this.set('pricing_error', 'Provider usage exceeded the reserved maximum; verify pricing before further paid admission');
      const start = Number(charge.admitted);
      if (now < start) throw new Error('Settlement precedes admission');
      const days = new Set([lisbonDay(start), lisbonDay(now)]);
      for (let cursor = start; cursor <= now; cursor += 3_600_000) days.add(lisbonDay(cursor));
      if (executionDay && !days.has(executionDay)) throw new Error('Unproven execution day');
      for (const day of executionDay ? [executionDay] : days) {
        this.run('INSERT INTO debits VALUES (?,?,?)', id, day, actual);
      }
      this.run('UPDATE charges SET settled=?,actual=? WHERE id=?', now, actual, id);
    });
  }

  enqueueDelivery(delivery: Delivery): boolean {
    if (delivery.policy !== this.setting('policy') || !delivery.matters.length) return false;
    if (delivery.matters.some((id) => !this.matter(id)?.valid)) return false;
    if (delivery.matters.some((id) => {
      const matter = this.matter(id)!;
      return this.setting(`unfollow:${matter.channel}:${matter.thread}`) === 'true';
    })) return false;
    return this.run('INSERT OR IGNORE INTO deliveries(id,channel,thread,text,matters,evidence,policy,digest,state,ts,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      delivery.id, delivery.channel, delivery.thread, delivery.text, JSON.stringify(delivery.matters), JSON.stringify(delivery.evidence), delivery.policy, Number(delivery.digest), delivery.state, null, delivery.created).changes > 0;
  }

  deliveries(state: Delivery['state'], matters?: string[]): Delivery[] {
    if (matters && !matters.length) return [];
    return this.rows(`SELECT * FROM deliveries WHERE state=? ${matters ? `AND EXISTS (SELECT 1 FROM json_each(deliveries.matters) j WHERE j.value IN (${matters.map(() => '?').join(',')}))` : ''}
      ORDER BY created ${matters ? '' : 'LIMIT 100'}`, state, ...(matters ?? [])).map((r) => ({
      id: String(r.id), channel: String(r.channel), thread: r.thread as string | null, text: String(r.text),
      matters: JSON.parse(String(r.matters)), evidence: JSON.parse(String(r.evidence)), policy: String(r.policy),
      digest: r.digest === 1, state, ts: r.ts as string | null, created: Number(r.created),
    }));
  }

  admitDelivery(id: string, now: number): boolean {
    return this.transaction(() => {
      const delivery = this.row("SELECT * FROM deliveries WHERE id=? AND state='pending'", id);
      if (!delivery) return false;
      if (this.setting('mute') === 'true' || this.setting('stop') === 'true' || delivery.policy !== this.setting('policy')) return false;
      const ineligible = this.row(`SELECT 1 FROM json_each(?) j LEFT JOIN matters m ON m.id=j.value LEFT JOIN channels c ON c.id=m.channel
        WHERE m.id IS NULL OR m.valid=0 OR c.allowed!=1 OR json_extract(m.body,'$.state')!='open' LIMIT 1`, delivery.matters);
      if (ineligible) return false;
      const count = Number(this.row("SELECT count(*) AS n FROM deliveries WHERE slot_day=? AND digest=? AND state IN ('sending','uncertain','sent')", lisbonDay(now), delivery.digest)!.n);
      if (count >= (delivery.digest === 1 ? 1 : 2)) return false;
      this.run("UPDATE deliveries SET state='sending',slot_day=? WHERE id=?", lisbonDay(now), id);
      return true;
    });
  }

  expire(now: number): void {
    this.transaction(() => {
      const affected = this.rows("SELECT DISTINCT channel,thread FROM revisions WHERE captured<? AND excerpt!=''", now - 90 * DAY);
      for (const r of affected) this.invalidate(String(r.channel), String(r.thread));
      this.run("UPDATE revisions SET text='' WHERE captured<?", now - 30 * DAY);
      this.run('DELETE FROM source_events WHERE seen<?', now - 30 * DAY);
      this.run("UPDATE revisions SET excerpt='' WHERE captured<?", now - 90 * DAY);
      this.run(`UPDATE observations SET text='',valid=0 WHERE EXISTS (SELECT 1 FROM json_each(observations.evidence) j LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt='')`);
      this.run(`UPDATE matters SET body=json_set(body,'$.detail','','$.title','Expired evidence'),valid=0 WHERE EXISTS (SELECT 1 FROM json_each(json_extract(matters.body,'$.evidence')) j LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt='')`);
      this.run(`UPDATE deliveries SET text='',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE created<? OR EXISTS
        (SELECT 1 FROM json_each(deliveries.evidence) j LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt='')`, now - 90 * DAY);
      this.run('DELETE FROM observation_search WHERE id IN (SELECT id FROM observations WHERE valid=0)');
      if (this.row("SELECT name FROM sqlite_master WHERE name='extractions'")) this.run(`DELETE FROM extractions WHERE created<? OR EXISTS
        (SELECT 1 FROM json_tree(extractions.response) j JOIN revisions r ON r.id=j.atom WHERE j.path LIKE '%.evidence' AND r.excerpt='')`, now - 90 * DAY);
    });
  }
}
