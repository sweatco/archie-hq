// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Delivery, Observation, Matter } from '../types.js';
import { SqlOperations, type RevisionRecord, type ChannelRecord, type PolicyRecord } from './sql.js';

export class AttentionRecords extends SqlOperations {
  revision(id: number) { return this.row<RevisionRecord>('SELECT * FROM revisions WHERE id=?', id); }

  stopAnalysis(): void {
    this.atomic(() => {
      this.run("INSERT INTO settings VALUES ('analysis_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");
      this.run("UPDATE deliveries SET state='cancelled' WHERE state='pending'");
      this.run("DELETE FROM jobs WHERE kind IN ('extract','investigate','reflection','digest')");
    });
  }

  scheduledJob(kind: string, target: string) {
    return this.row<{ kind: string }>('SELECT kind FROM jobs WHERE kind=? AND target=?', kind, target);
  }

  allowedChannels() {
    return this.rows<{ id: string }>('SELECT id FROM channels WHERE allowed=1');
  }

  channelProgress(channel: string) {
    return this.row<ChannelRecord>('SELECT * FROM channels WHERE id=?', channel);
  }

  extractionPart(key: string) {
    const row = this.row<{ response: string }>('SELECT response FROM extractions WHERE id=?', key);
    return row ? JSON.parse(row.response) as unknown : undefined;
  }

  cacheExtraction(key: string, created: number, response: object) {
    this.run('INSERT OR REPLACE INTO extractions VALUES (?,?,?)', key, created, JSON.stringify(response));
  }

  discardExtraction(key: string) {
    this.run('DELETE FROM extractions WHERE id=?', key);
  }

  deferThread(changed: number, channel: string, thread: string) {
    this.run('UPDATE threads SET changed=? WHERE channel=? AND thread=?', changed, channel, thread);
  }

  currentMessage(channel: string, timestamp: string) {
    return this.row<RevisionRecord>('SELECT r.* FROM revisions r JOIN messages m ON m.revision=r.id WHERE m.channel=? AND m.ts=?', channel, timestamp);
  }

  coveredMessages(channel: string, thread: string, oldest: number, latest: number, latestVersion: number) {
    return this.rows<RevisionRecord>(`SELECT r.* FROM revisions r JOIN messages m ON m.revision=r.id
          WHERE r.channel=? AND r.thread=? AND r.deleted=0 AND CAST(r.ts AS REAL)>=? AND CAST(r.ts AS REAL)<=?
          AND CAST(r.version AS REAL)<=?`, channel, thread, oldest, latest, latestVersion);
  }

  setThreadGap(gap: string | null, channel: string, thread: string) {
    this.run('UPDATE threads SET gap=? WHERE channel=? AND thread=?', gap, channel, thread);
  }

  saveMatter(matter: Matter) {
    this.run('UPDATE matters SET body=? WHERE id=?', JSON.stringify(matter), matter.id);
  }

  setNextCheck(due: number, matter: string) {
    this.run('UPDATE matters SET next_check=? WHERE id=?', due, matter);
  }

  reconcileDelivery(timestamp: string, delivery: string) {
    this.run("UPDATE deliveries SET state='sent',ts=? WHERE id=?", timestamp, delivery);
  }

  evidenceSources(evidence: number[]) {
    return this.rows<{ channel: string; thread: string }>('SELECT DISTINCT r.channel,r.thread FROM revisions r JOIN json_each(?) j ON j.value=r.id', JSON.stringify(evidence));
  }

  cancelDelivery(delivery: string) {
    this.run("UPDATE deliveries SET state='cancelled' WHERE id=?", delivery);
  }

  finishDelivery(state: Extract<Delivery['state'], 'sent' | 'uncertain'>, timestamp: string | null, delivery: string) {
    this.run('UPDATE deliveries SET state=?,ts=? WHERE id=?', state, timestamp, delivery);
  }

  uncertainDelivery(delivery: string) {
    this.run("UPDATE deliveries SET state='uncertain' WHERE id=?", delivery);
  }

  observation(id: string) {
    const row = this.row<Omit<Observation, 'evidence'> & { evidence: string }>('SELECT * FROM observations WHERE id=? AND valid=1', id);
    return row ? { ...row, evidence: JSON.parse(row.evidence) as number[] } : undefined;
  }

  channelStatus() {
    return this.rows<Pick<ChannelRecord, 'id' | 'allowed' | 'gap' | 'checkpoint'>>('SELECT id,allowed,gap,checkpoint FROM channels');
  }

  proposedPolicies() {
    return this.rows<Pick<PolicyRecord, 'id' | 'evaluation'>>("SELECT id,evaluation FROM policies WHERE state='proposed' LIMIT 5");
  }

  messageKnown(channel: string, timestamp: string) {
    return this.row<{ revision: number }>('SELECT revision FROM messages WHERE channel=? AND ts=?', channel, timestamp);
  }

  deliveryMatters(delivery: string) {
    const row = this.row<{ matters: string }>('SELECT matters FROM deliveries WHERE id=?', delivery);
    return row ? JSON.parse(row.matters) as string[] : undefined;
  }

  deliveryOrigin(channel: string, thread: string, timestamp: string) {
    return this.row<{ id: string; matters: string }>("SELECT id,matters FROM deliveries WHERE channel=? AND (thread=? OR ts=?) AND state='sent' ORDER BY created DESC LIMIT 1", channel, thread, timestamp);
  }

  statistics() {
    return this.row<{ threads: number; sent: number; feedback: number; unsettled: number; proposals: number }>(`SELECT
      (SELECT count(*) FROM threads) AS threads,
      (SELECT count(*) FROM deliveries WHERE state='sent') AS sent,
      (SELECT count(*) FROM feedback) AS feedback,
      (SELECT count(*) FROM charges WHERE settled IS NULL) AS unsettled,
      (SELECT count(*) FROM proposals WHERE status='pending filing') AS proposals`)!;
  }
}
