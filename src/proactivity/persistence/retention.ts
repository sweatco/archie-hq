// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// Historical payloads retain the source retention boundary even while learning is deferred.
export function expireLegacyEvidence(db: DatabaseSync, now: number): void {
  const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
  const invalid = `SELECT e.id FROM episodes e,json_each(e.payload,'$.thread.evidence') j LEFT JOIN revisions r ON r.id=json_extract(j.value,'$.id')
      LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts LEFT JOIN revisions latest ON latest.id=m.revision
      WHERE r.id IS NULL OR r.excerpt='' OR r.captured<${now - 90 * 86_400_000} OR latest.id IS NULL OR latest.deleted=1`;
  run(`DELETE FROM replays WHERE episode IN (${invalid})`);
  run(`DELETE FROM episodes WHERE id IN (${invalid})`);
  run('DELETE FROM replays WHERE episode IN (SELECT id FROM episodes WHERE observed<?)', now - 90 * 86_400_000);
  run('DELETE FROM episodes WHERE observed<?', now - 90 * 86_400_000);
  run(`UPDATE proposals SET body=json_set(body,'$.outcome','Evidence expired','$.evidence',json('[]')) WHERE EXISTS
      (SELECT 1 FROM json_each(proposals.body,'$.evidence') j LEFT JOIN revisions r ON r.id=j.value LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
      LEFT JOIN revisions latest ON latest.id=m.revision WHERE r.id IS NULL OR r.excerpt='' OR latest.deleted=1)`);
  run(`UPDATE policies SET state='expired',body='{}' WHERE state='proposed' AND EXISTS
      (SELECT 1 FROM json_each(policies.evidence) j LEFT JOIN revisions r ON r.id=j.value LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
      LEFT JOIN revisions latest ON latest.id=m.revision WHERE r.id IS NULL OR r.excerpt='' OR r.captured<? OR latest.deleted=1)`, now - 90 * 86_400_000);
  run(`UPDATE cohort_predictions SET candidate=NULL,baseline=NULL,error='Source expired or unavailable' WHERE cohort IN
    (SELECT c.id FROM cohorts c,json_each(c.manifest,'$.groups') g LEFT JOIN episodes e ON e.id=json_extract(g.value,'$.episode') WHERE e.id IS NULL
      UNION SELECT c.id FROM cohorts c,json_each(c.manifest,'$.trainingInputs') t LEFT JOIN episodes e ON e.id=json_extract(t.value,'$.episode')
      WHERE json_extract(t.value,'$.approved') IS NULL AND e.id IS NULL)`);
  run("UPDATE cohorts SET state='invalid' WHERE id IN (SELECT cohort FROM cohort_predictions WHERE error='Source expired or unavailable')");
}
