// SPDX-License-Identifier: AGPL-3.0-or-later
import { proposalVersion, suggestionId } from './proposals.js';
import type { CapabilityProposal, TaskHandoffRecord } from './types.js';
import { reasonText, type DecisionReason } from './decisions.js';
import { AttentionRecords } from './persistence/attention.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { initializeSchema, validateSchema } from './persistence/schema.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Delivery, Job, Matter, Observation, SourceMessage, ThreadSnapshot } from './types.js';
import { lisbonDay } from './types.js';

type Row = Record<string, string | number | null>;
const DAY = 86_400_000;

export class InitiativeStore {
  private readonly db: DatabaseSync;
  readonly attention: AttentionRecords;

  constructor(path: string, team: string, now = Date.now(), options: { readOnly?: boolean; owner?: string } = {}) {
    this.db = new DatabaseSync(path, { readOnly: options.readOnly === true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      if (options.readOnly) {
        this.db.exec('PRAGMA query_only=ON');
        validateSchema(this.db, team, options.owner);
      } else {
        initializeSchema(this.db, team, now, options.owner);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      }
      this.attention = new AttentionRecords(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }
  private row(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  setting(key: string): string | undefined { return this.row('SELECT value FROM settings WHERE key=?', key)?.value as string | undefined; }
  set(key: string, value: string): void { this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }

  dispatchRequest(charge: string, model: string, fingerprint: string): void {
    this.run("INSERT INTO requests VALUES (?,?,?,NULL,NULL,'dispatching')", charge, model, fingerprint);
  }

  completeRequest(remote: string | null, usage: string, charge: string): void {
    this.run("UPDATE requests SET state='complete',remote=?,usage=? WHERE charge=?", remote, usage, charge);
  }

  uncertainRequest(remote: string | null, charge: string): void {
    this.run("UPDATE requests SET state=CASE WHEN usage IS NULL THEN 'uncertain' ELSE 'invalid' END,remote=COALESCE(remote,?) WHERE charge=?", remote, charge);
  }

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
    const previous = this.row('SELECT allowed,shared FROM channels WHERE id=?', id);
    if (gap === undefined && previous?.allowed === Number(allowed) && previous.shared === Number(shared)) return;
    this.transaction(() => {
      this.run(`INSERT INTO channels VALUES (?,?,?,?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET
          allowed=excluded.allowed,
          shared=excluded.shared,
          gap=CASE WHEN ? THEN excluded.gap ELSE channels.gap END`,
        id, Number(allowed), Number(shared), this.setting('watermark')!, gap ?? null, Number(gap !== undefined));
      if (gap !== undefined) this.writeCoverageGap(id, gap?.includes('lookup failed') ? 'access' : gap === 'Collection pagination pending' ? 'pagination' : 'unknown', gap ?? null);
      if (!allowed) this.invalidate(id);
    });
  }

  workloadState(now: number) {
    return {
      queue: Number(this.row('SELECT count(*) AS n FROM jobs')!.n),
      due: Number(this.row('SELECT count(*) AS n FROM jobs WHERE due<=?', now)!.n),
      deferred: Number(this.row('SELECT count(*) AS n FROM jobs WHERE attempts>0')!.n),
      revisions: Number(this.row('SELECT count(*) AS n FROM revisions')!.n),
      observations: Number(this.row('SELECT count(*) AS n FROM observations WHERE valid=1')!.n),
      rawBytes: Number(this.row('SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) AS n FROM revisions')!.n),
      unsettled: Number(this.row('SELECT COALESCE(SUM(maximum),0) AS n FROM charges WHERE settled IS NULL')!.n),
      settled: Number(this.row('SELECT COALESCE(SUM(actual),0) AS n FROM charges WHERE settled IS NOT NULL')!.n),
      budget: this.budget(now),
      threads: this.rows('SELECT channel,thread,generation,processed FROM threads ORDER BY channel,thread LIMIT 1000'),
    };
  }

  priorCheck(id: string, signature: string): { kind: string; checked: number } | null {
    return this.row('SELECT kind,checked FROM matter_checks WHERE matter=? AND signature=?', id, signature) as { kind: string; checked: number } ?? null;
  }

  rememberCheck(id: string, signature: string, kind: 'no_help' | 'notified', now: number): void {
    this.run(`INSERT INTO matter_checks VALUES (?,?,?,?)
      ON CONFLICT(matter) DO UPDATE SET
        signature=excluded.signature,kind=excluded.kind,checked=excluded.checked`, id, signature, kind, now);
  }

  recordDecision(matter: Matter, code: DecisionReason, at: number, details: { nextDue?: number; delivery?: string; scope?: string } = {}): void {
    const requests = details.scope ? this.rows(`SELECT c.id,c.maximum,c.actual,c.settled,r.remote,r.state FROM charges c
      JOIN charge_scopes s ON s.charge=c.id LEFT JOIN requests r ON r.charge=c.id WHERE s.scope=? LIMIT 4`, details.scope) : [];
    const evidence = matter.evidence.slice(0, 40).map(id => ({ id, hash: this.row('SELECT hash FROM revisions WHERE id=?', id)?.hash ?? null }));
    const previous = this.row('SELECT code,next_due,evidence,delivery,requests FROM decisions WHERE matter=? ORDER BY id DESC LIMIT 1', matter.id);
    if (previous?.code === code && previous.next_due === (details.nextDue ?? null)
      && previous.delivery === (details.delivery ?? null) && previous.evidence === JSON.stringify(evidence) && previous.requests === JSON.stringify(requests)) return;
    this.transaction(() => {
      this.run('INSERT INTO decisions(matter,at,code,next_due,evidence,delivery,requests) VALUES (?,?,?,?,?,?,?)', matter.id, at, code,
        details.nextDue ?? null, JSON.stringify(evidence), details.delivery ?? null, JSON.stringify(requests));
      this.run('DELETE FROM decisions WHERE matter=? AND id NOT IN (SELECT id FROM decisions WHERE matter=? ORDER BY id DESC LIMIT 20)', matter.id, matter.id);
    });
  }

  explain(id: string) {
    const decisions = this.rows('SELECT * FROM decisions WHERE matter=? ORDER BY id DESC LIMIT 20', id).map(row => ({
      at: row.at, code: row.code, explanation: reasonText[row.code as DecisionReason], nextDue: row.next_due,
      evidence: JSON.parse(String(row.evidence)), delivery: row.delivery, requests: JSON.parse(String(row.requests)),
    }));
    const deliveries = this.rows(`SELECT id,state,created,ts,proposal FROM deliveries
      WHERE EXISTS (SELECT 1 FROM json_each(matters) WHERE value=?)
      ORDER BY created DESC LIMIT 10`, id);
    const nextJob = this.row("SELECT due,lease,attempts FROM jobs WHERE kind='investigate' AND target=?", id);
    const handoffs = this.rows(`SELECT h.proposal,h.version,h.actor,h.approved,h.task,h.state,h.budget
      FROM handoffs h JOIN proposals p ON p.id=h.proposal
      WHERE EXISTS (
        SELECT 1 FROM json_each(p.body,'$.evidence') e
        JOIN matters m ON m.id=?
        JOIN json_each(m.body,'$.evidence') linked ON linked.value=e.value
      ) LIMIT 10`, id);
    const feedback = this.rows('SELECT action,created FROM feedback WHERE matter=? ORDER BY created DESC LIMIT 10', id);
    return { decisions, deliveries, nextJob, handoffs, feedback };
  }

  private proposalId(repository: string, matter: Matter): string {
    // Use all known human work-thread context, independently of model citation selection.
    const context = this.rows(`SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id
      WHERE r.channel=? AND r.thread=? AND r.own=0 AND r.bot=0 AND r.deleted=0`, matter.channel, matter.thread).map(row => Number(row.id));
    return suggestionId({ repository, matter: matter.id, evidence: context });
  }

  proposeCapability(proposal: Pick<CapabilityProposal, 'repository' | 'outcome' | 'evidence' | 'matter'>): string {
    const matter = this.matter(proposal.matter);
    if (!matter?.valid || matter.state !== 'open') throw new Error('Task suggestion requires a current open matter');
    const id = this.proposalId(proposal.repository, matter);
    const versioned = JSON.stringify({ ...proposal, version: proposalVersion({ ...proposal, id }) });
    // Keep the first scope immutable while its evidence context is unchanged.
    this.run('INSERT INTO proposals(id,body) VALUES (?,?) ON CONFLICT(id) DO NOTHING', id, versioned);
    return id;
  }

  proposal(id: string): CapabilityProposal | null {
    const row = this.row('SELECT * FROM proposals WHERE id=?', id);
    if (!row) return null;
    const body = JSON.parse(String(row.body));
    if (typeof body.repository !== 'string' || typeof body.outcome !== 'string' || typeof body.matter !== 'string' || !Array.isArray(body.evidence)) return null;
    return { ...body, id };
  }

  proposalCurrent(proposal: CapabilityProposal, now: number, checkAccess = true): boolean {
    const matter = this.matter(proposal.matter);
    if (!matter?.valid || matter.state !== 'open' || this.setting(`unfollow:${matter.channel}:${matter.thread}`) === 'true'
      || proposal.id !== this.proposalId(proposal.repository, matter)) return false;
    return proposal.evidence.length > 0 && proposal.evidence.length <= 20 && proposal.evidence.every(id =>
      Number.isSafeInteger(id) && this.row(`SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id JOIN channels c ON c.id=r.channel
        WHERE r.id=? AND r.deleted=0 AND r.bot=0 AND r.own=0 AND r.excerpt!='' AND r.captured>=? AND (?=0 OR c.allowed=1)`, id, now - 90 * DAY, Number(checkAccess)));
  }

  pendingProposalCount(now: number): number {
    return this.rows('SELECT p.id FROM proposals p WHERE NOT EXISTS (SELECT 1 FROM handoffs WHERE proposal=p.id)')
      .filter(row => {
        const proposal = this.proposal(String(row.id));
        return proposal && this.proposalCurrent(proposal, now);
      }).length;
  }

  proposalSources(id: string): Array<{ channel: string; thread: string }> {
    const proposal = this.proposal(id);
    return proposal ? this.rows(`SELECT DISTINCT channel,thread FROM revisions
      JOIN json_each(?) j ON j.value=revisions.id
      UNION SELECT channel,thread FROM matters WHERE id=?`, JSON.stringify(proposal.evidence), proposal.matter)
      .map(row => ({ channel: String(row.channel), thread: String(row.thread) })) : [];
  }

  delivery(id: string): Delivery | null {
    const row = this.row('SELECT * FROM deliveries WHERE id=?', id);
    if (!row) return null;
    return {
      id, channel: String(row.channel), thread: row.thread as string | null,
      text: String(row.text), matters: JSON.parse(String(row.matters)), evidence: JSON.parse(String(row.evidence)),
      digest: row.digest === 1, state: row.state as Delivery['state'], ts: row.ts as string | null,
      created: Number(row.created), proposal: row.proposal ? JSON.parse(String(row.proposal)) : undefined,
    };
  }

  pendingProposalIds(after = ''): string[] {
    return this.rows(`SELECT p.id FROM proposals p
      WHERE p.id>?
        AND NOT EXISTS (SELECT 1 FROM handoffs WHERE proposal=p.id)
        AND NOT EXISTS (
          SELECT 1 FROM deliveries d
          WHERE json_extract(d.proposal,'$.id')=p.id
            AND json_extract(d.proposal,'$.version')=json_extract(p.body,'$.version')
            AND d.state IN ('pending','sending','uncertain','sent')
        )
      ORDER BY p.id LIMIT 20`, after).map(row => String(row.id));
  }

  prepareHandoff(id: string, token: string): boolean {
    return this.run("UPDATE handoffs SET state='prepared' WHERE proposal=? AND token=?", id, token).changes > 0;
  }


  handoff(id: string): TaskHandoffRecord | null {
    return this.row('SELECT * FROM handoffs WHERE proposal=?', id) as unknown as TaskHandoffRecord ?? null;
  }

  approveHandoff(record: TaskHandoffRecord): TaskHandoffRecord {
    return this.transaction(() => {
      const previous = this.handoff(record.proposal);
      if (previous) {
        if (previous.version !== record.version || previous.actor !== record.actor) throw new Error('Proposal approval has changed');
        return previous;
      }
      this.run('INSERT INTO handoffs(proposal,version,actor,approved,task,state,budget,delivery) VALUES (?,?,?,?,?,?,?,?)', record.proposal, record.version, record.actor,
        record.approved, record.task, 'approved', 'task', record.delivery);
      return record;
    });
  }

  claimHandoff(id: string, now: number): string | null {
    return this.transaction(() => {
      const token = randomUUID();
      const claimed = this.run("UPDATE handoffs SET lease=?,token=? WHERE proposal=? AND state IN ('approved','prepared') AND lease<=?", now + 300_000, token, id, now).changes;
      return claimed ? token : null;
    });
  }

  finishHandoff(id: string, token: string, state?: TaskHandoffRecord['state']): void {
    this.run('UPDATE handoffs SET state=COALESCE(?,state),lease=0,token=NULL WHERE proposal=? AND token=?', state ?? null, id, token);
  }

  pendingHandoffs(): TaskHandoffRecord[] {
    return this.rows("SELECT * FROM handoffs WHERE state IN ('approved','prepared') ORDER BY approved LIMIT 10") as unknown as TaskHandoffRecord[];
  }

  pendingHandoffCards(now: number): TaskHandoffRecord[] {
    return this.rows(`SELECT * FROM handoffs WHERE card_retry<=?
      AND card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END
      ORDER BY card_retry,approved LIMIT 10`, now) as unknown as TaskHandoffRecord[];
  }

  claimHandoffCard(id: string, now: number): number | null {
    const lease = now + 60_000;
    return this.run(`UPDATE handoffs SET card_retry=? WHERE proposal=? AND card_retry<=?
      AND card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END`, lease, id, now).changes ? lease : null;
  }

  finishHandoffCard(id: string, state: NonNullable<TaskHandoffRecord['card_state']>, lease: number, retryAt = 0): void {
    this.run('UPDATE handoffs SET card_state=CASE WHEN ?=0 THEN ? ELSE card_state END,card_retry=? WHERE proposal=? AND card_retry=?', retryAt, state, retryAt, id, lease);
  }

  listProposals() {
    return (this.rows('SELECT * FROM proposals ORDER BY id') as Array<{ id: string; body: string }>)
      .map(row => ({ ...row, body: JSON.parse(row.body) as Omit<CapabilityProposal, 'id'> }));
  }

  private writeCoverageGap(channel: string, code: string, detail: string | null): void {
    if (detail === null) this.run('DELETE FROM coverage_gaps WHERE channel=? AND code=?', channel, code);
    else this.run('INSERT INTO coverage_gaps VALUES (?,?,?) ON CONFLICT(channel,code) DO UPDATE SET detail=excluded.detail', channel, code, detail);
    const gap = this.rows('SELECT detail FROM coverage_gaps WHERE channel=? ORDER BY code', channel).map(r => r.detail).join('; ') || null;
    this.run('UPDATE channels SET gap=? WHERE id=?', gap, channel);
  }

  coverageGap(channel: string, code: 'access' | 'pagination' | 'unknown', detail: string | null): void {
    this.transaction(() => this.writeCoverageGap(channel, code, detail));
  }

  advanceCollection(channel: string, checkpoint: string, cursor?: string): void {
    this.transaction(() => {
      this.run('UPDATE channels SET cursor=?,checkpoint=? WHERE id=?', cursor ?? null, checkpoint, channel);
      this.writeCoverageGap(channel, 'pagination', cursor ? 'Collection pagination pending' : null);
      if (!cursor) {
        this.run('DELETE FROM settings WHERE key=?', `scan:${channel}`);
        this.writeCoverageGap(channel, 'access', null);
      }
    });
  }

  completeThreadRefresh(channel: string, thread: string, gap: string | null): void {
    this.transaction(() => {
      this.run('DELETE FROM settings WHERE key=?', `thread-scan:${channel}:${thread}`);
      this.run('UPDATE threads SET gap=? WHERE channel=? AND thread=?', gap, channel, thread);
      this.writeCoverageGap(channel, 'access', null);
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
    const row = this.row(`SELECT t.*,c.gap AS channel_gap FROM threads t
      JOIN channels c ON c.id=t.channel
      WHERE t.channel=? AND t.thread=? AND c.allowed=1`, channel, thread);
    if (!row) return null;
    const rows = this.rows(`SELECT r.* FROM revisions r
      JOIN messages m ON m.revision=r.id
      WHERE r.channel=? AND r.thread=? AND r.deleted=0
      ORDER BY CAST(r.ts AS REAL) DESC LIMIT 201`, channel, thread);
    const truncated = rows.length > 200;
    const evidence = rows.slice(0, 200).reverse()
      .filter((r) => r.text || r.excerpt)
      .map((r) => ({
        id: Number(r.id), channel, thread, ts: String(r.ts), version: String(r.version), author: String(r.author),
        text: String(r.text || r.excerpt), own: r.own === 1, bot: r.bot === 1, captured: Number(r.captured),
      }));
    const gap = [row.channel_gap, row.gap, truncated ? 'Earlier thread context omitted; newest 200 messages retained' : null].filter(Boolean).join('; ') || null;
    const removed = this.rows(`SELECT r.ts,r.version FROM revisions r
      JOIN messages m ON m.revision=r.id
      WHERE r.channel=? AND r.thread=? AND r.deleted=1
      ORDER BY r.captured DESC LIMIT 20`, channel, thread)
      .map((r) => ({ ts: String(r.ts), version: String(r.version) }));
    return { channel, thread, generation: Number(row.generation), evidence, gap, removed };
  }

  dirty(limit = 16): ThreadSnapshot[] {
    return this.rows(`WITH pending AS (
        SELECT t.channel,t.thread,t.changed FROM threads t
        JOIN channels c ON c.id=t.channel
        WHERE c.allowed=1 AND t.generation>t.processed
      ), source_groups AS (
        SELECT channel,MIN(changed) AS oldest FROM pending GROUP BY channel
      )
      SELECT p.channel,p.thread FROM pending p
      JOIN source_groups g ON g.channel=p.channel
      ORDER BY g.oldest,p.channel,p.changed LIMIT ?`, limit)
      .map((r) => this.snapshot(String(r.channel), String(r.thread))!).filter(Boolean);
  }

  current(snapshots: ThreadSnapshot[]): boolean {
    return snapshots.every((s) => this.row(`SELECT generation FROM threads t
      JOIN channels c ON c.id=t.channel
      WHERE t.channel=? AND t.thread=? AND c.allowed=1`, s.channel, s.thread)?.generation === s.generation);
  }

  apply(snapshots: ThreadSnapshot[], observations: Observation[], matters: Matter[], job?: Job): boolean {
    return this.transaction(() => {
      if ((job && !this.owns(job)) || !this.current(snapshots)) return false;
      const allowed = new Set(snapshots.flatMap((s) => s.evidence.map((e) => e.id)));
      for (const item of [...observations, ...matters]) {
        const snapshot = snapshots.find((s) => s.channel === item.channel && s.thread === item.thread);
        if (!snapshot || !item.evidence.length || item.evidence.some((id) => !allowed.has(id) || !snapshot.evidence.some((e) => e.id === id))) {
          throw new Error('Result cites evidence outside its source thread');
        }
        if (item.evidence.every((id) => {
          const evidence = snapshot.evidence.find((e) => e.id === id)!;
          return evidence.own || evidence.bot;
        })) throw new Error('Own output or bot output cannot establish an observation');
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
          const changed = snapshots.flatMap((s) => s.evidence).some((e) =>
            matter.evidence.includes(e.id) && !e.own && !e.bot
            && !oldHashes.has(this.row('SELECT hash FROM revisions WHERE id=?', e.id)?.hash));
          if (!matter.reopen || !changed) matter = { ...matter, state: 'resolved' };
        }
        this.run('INSERT INTO matters VALUES (?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,valid=1,next_check=excluded.next_check',
          matter.id, matter.channel, matter.thread, JSON.stringify(matter), matter.nextCheck);
      }
      return true;
    });
  }

  search(query: string, channels: string[] | null, limit = 10): Observation[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12);
    if (!tokens?.length || (channels !== null && !channels.length)) return [];
    const match = tokens.map((t) => `"${t}"`).join(' OR ');
    return this.rows(`SELECT o.* FROM observation_search s
      JOIN observations o ON o.id=s.id JOIN channels c ON c.id=o.channel
      WHERE observation_search MATCH ? AND o.valid=1 AND c.allowed=1
        ${channels === null ? '' : `AND o.channel IN (${channels.map(() => '?').join(',')})`}
      ORDER BY rank LIMIT ?`, match, ...(channels ?? []), Math.min(20, limit))
      .map((r) => ({
        id: String(r.id), channel: String(r.channel), thread: String(r.thread), text: String(r.text),
        evidence: JSON.parse(String(r.evidence)), kind: r.kind as Observation['kind'],
      }));
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

  latestReminder(id: string): number | null {
    const row = this.row("SELECT MAX(created) AS at FROM feedback WHERE matter=? AND action='later'", id);
    return row?.at === null ? null : Number(row?.at ?? 0);
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
    this.run(`INSERT INTO jobs(kind,target,payload,due) VALUES (?,?,?,?)
      ON CONFLICT(kind,target) DO UPDATE SET
        due=MIN(jobs.due,excluded.due),payload=excluded.payload,generation=jobs.generation+1`, kind, target, payload, due);
  }

  claim(now: number, leaseMs = 360_000): Job | null {
    return this.transaction(() => {
      const row = this.row("SELECT * FROM jobs WHERE due<=? AND lease<=? ORDER BY due LIMIT 1", now, now);
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
      if (scope && Number(this.row(`SELECT COALESCE(SUM(COALESCE(c.actual,c.maximum)),0) AS n
        FROM charges c JOIN charge_scopes s ON s.charge=c.id
        WHERE s.scope=?`, scope)!.n) + maximum > scopeLimit) return null;
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

  private evidenceCurrent(ids: number[]): boolean {
    if (!ids.length) return false;
    return !this.row(`SELECT 1 FROM json_each(?) j LEFT JOIN revisions r ON r.id=j.value
      LEFT JOIN messages m ON m.revision=r.id LEFT JOIN channels c ON c.id=r.channel
      WHERE r.id IS NULL OR m.revision IS NULL OR r.deleted=1 OR r.excerpt='' OR c.allowed!=1 LIMIT 1`, JSON.stringify(ids));
  }

  enqueueDelivery(delivery: Delivery): boolean {
    return this.transaction(() => {
      if (delivery.state === 'pending' && !this.evidenceCurrent(delivery.evidence)) return false;
      if (!delivery.matters.length && !delivery.proposal) return false;
      if (delivery.proposal) {
        const proposal = this.proposal(delivery.proposal.id);
        if (!proposal || !this.proposalCurrent(proposal, delivery.created) || proposalVersion(proposal) !== delivery.proposal.version || this.handoff(proposal.id)) return false;
      }
      if (delivery.matters.some((id) => !this.matter(id)?.valid)) return false;
      if (delivery.matters.some((id) => {
        const matter = this.matter(id)!;
        return this.setting(`unfollow:${matter.channel}:${matter.thread}`) === 'true';
      })) return false;
      // A cancelled card is retryable only when it never reserved a send slot or received a timestamp.
      return this.run(`INSERT INTO deliveries(id,channel,thread,text,matters,evidence,digest,state,ts,created,proposal)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET channel=excluded.channel,thread=excluded.thread,text=excluded.text,
          matters=excluded.matters,evidence=excluded.evidence,created=excluded.created,state='pending'
        WHERE deliveries.state='cancelled' AND excluded.state='pending'
          AND deliveries.ts IS NULL AND deliveries.slot_day IS NULL
          AND excluded.proposal IS NOT NULL AND deliveries.proposal=excluded.proposal`,
        delivery.id, delivery.channel, delivery.thread, delivery.text,
        JSON.stringify(delivery.matters), JSON.stringify(delivery.evidence), Number(delivery.digest),
        delivery.state, null, delivery.created, delivery.proposal ? JSON.stringify(delivery.proposal) : null).changes > 0;
    });
  }

  deliveries(state: Delivery['state'], matters?: string[]): Delivery[] {
    if (matters && !matters.length) return [];
    return this.rows(`SELECT * FROM deliveries WHERE state=?
      ${matters ? `AND EXISTS (
        SELECT 1 FROM json_each(deliveries.matters) j WHERE j.value IN (${matters.map(() => '?').join(',')})
      )` : ''}
      ORDER BY created ${matters ? '' : 'LIMIT 100'}`, state, ...(matters ?? [])).map((r) => ({
      id: String(r.id), channel: String(r.channel), thread: r.thread as string | null, text: String(r.text),
      matters: JSON.parse(String(r.matters)), evidence: JSON.parse(String(r.evidence)),
      digest: r.digest === 1, state, ts: r.ts as string | null, created: Number(r.created), proposal: r.proposal ? JSON.parse(String(r.proposal)) : undefined,
    }));
  }

  admitDelivery(id: string, now: number): boolean {
    return this.transaction(() => {
      const delivery = this.row("SELECT * FROM deliveries WHERE id=? AND state='pending'", id);
      if (!delivery || !this.evidenceCurrent(JSON.parse(String(delivery.evidence)))) return false;
      if (delivery.proposal) {
        const ref = JSON.parse(String(delivery.proposal));
        const proposal = this.proposal(ref.id);
        if (!proposal || !this.proposalCurrent(proposal, now) || proposalVersion(proposal) !== ref.version || this.handoff(proposal.id)) return false;
      }
      if (this.setting('delivery_enabled') !== 'true' || ['mute', 'pause', 'stop'].some(key => this.setting(key) === 'true')) return false;
      const ineligible = this.row(`SELECT 1 FROM json_each(?) j LEFT JOIN matters m ON m.id=j.value LEFT JOIN channels c ON c.id=m.channel
        WHERE m.id IS NULL OR m.valid=0 OR c.allowed!=1 OR json_extract(m.body,'$.state')!='open' LIMIT 1`, delivery.matters);
      if (ineligible) return false;
      const count = Number(this.row(`SELECT count(*) AS n FROM deliveries
        WHERE slot_day=? AND digest=? AND state IN ('sending','uncertain','sent')`, lisbonDay(now), delivery.digest)!.n);
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
      this.run('DELETE FROM matter_checks WHERE checked<?', now - 90 * DAY);
      this.run("UPDATE revisions SET excerpt='' WHERE captured<?", now - 90 * DAY);
      this.run(`UPDATE observations SET text='',valid=0 WHERE EXISTS (
        SELECT 1 FROM json_each(observations.evidence) j
        LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt=''
      )`);
      this.run(`UPDATE matters SET body=json_set(body,'$.detail','','$.title','Expired evidence'),valid=0 WHERE EXISTS (
        SELECT 1 FROM json_each(json_extract(matters.body,'$.evidence')) j
        LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt=''
      )`);
      this.run(`UPDATE deliveries SET text='',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE created<? OR EXISTS
        (SELECT 1 FROM json_each(deliveries.evidence) j LEFT JOIN revisions r ON r.id=j.value WHERE r.excerpt IS NULL OR r.excerpt='')`, now - 90 * DAY);
      this.run('DELETE FROM observation_search WHERE id IN (SELECT id FROM observations WHERE valid=0)');
      this.run(`UPDATE proposals SET body=json_set(body,'$.outcome','Evidence expired','$.evidence',json('[]')) WHERE EXISTS
        (SELECT 1 FROM json_each(proposals.body,'$.evidence') j LEFT JOIN revisions r ON r.id=j.value LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
        LEFT JOIN revisions latest ON latest.id=m.revision WHERE r.id IS NULL OR r.excerpt='' OR latest.deleted=1)`);
      this.run(`DELETE FROM extractions WHERE created<? OR EXISTS
        (SELECT 1 FROM json_tree(extractions.response) j JOIN revisions r ON r.id=j.atom WHERE j.path LIKE '%.evidence' AND r.excerpt='')`, now - 90 * DAY);
    });
  }
}
