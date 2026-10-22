// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Observation } from '../types.js';
import { SqlOperations } from './sql.js';

export type RecordedCheck = { matter: string; signature: string; kind: string; checked: number };

export class ReplayRecords extends SqlOperations {
  observations(channel: string) {
    return this.rows<Omit<Observation, 'evidence'> & { evidence: string }>('SELECT o.* FROM observations o JOIN observation_search s ON s.id=o.id WHERE o.channel=? AND o.valid=1 ORDER BY s.rowid', channel)
      .map(row => ({ ...row, evidence: JSON.parse(row.evidence) as number[] }));
  }

  tombstones(channel: string, thread: string) {
    return this.rows<{ id: number }>('SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id WHERE r.channel=? AND r.thread=? AND r.deleted=1', channel, thread);
  }

  checks(matters: string[]): RecordedCheck[] {
    return this.rows<RecordedCheck>('SELECT * FROM matter_checks WHERE matter IN (SELECT value FROM json_each(?))', JSON.stringify(matters));
  }

  controls() {
    return this.rows<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key IN ('stop','pause','mute','watermark') OR key LIKE 'unfollow:%'");
  }

  digestSlots(day: string) {
    return this.row<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE slot_day=? AND digest=1 AND state IN ('sent','sending','uncertain')", day);
  }

  extraSlots(day: string) {
    return this.row<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE slot_day=? AND digest=0 AND state IN ('sent','sending','uncertain')", day);
  }

  dueJob(now: number) {
    return this.row<{ kind: string }>('SELECT kind FROM jobs WHERE due<=?', now);
  }

  matterIds() {
    return this.rows<{ id: string }>('SELECT id FROM matters');
  }

  semanticStep(cohort: string, signature: string) {
    return this.row<{ id: string; state: string }>("SELECT id,state FROM batches WHERE json_extract(context,'$.cohort')=? AND json_extract(context,'$.step')=? AND state!='not dispatched' ORDER BY created LIMIT 1", cohort, signature);
  }

}
