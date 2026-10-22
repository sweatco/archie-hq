// SPDX-License-Identifier: AGPL-3.0-or-later
import { SqlOperations, type BatchRecord } from './sql.js';

export class RequestRecords extends SqlOperations {
  localBatch(id: string) { return this.row<Pick<BatchRecord, 'id' | 'state' | 'remote'>>('SELECT id,state,remote FROM batches WHERE id=?', id); }

  unknownSubmissions() {
    return this.rows<BatchRecord>("SELECT * FROM batches WHERE remote IS NULL AND state IN ('submitting','uncertain') ORDER BY created LIMIT 3");
  }

  correlatedResult(id: string, remote: string) {
    this.run("UPDATE batches SET remote=?,state='retrieving' WHERE id=? AND remote IS NULL AND state IN ('submitting','uncertain','retired')", remote, id);
    return this.pendingResult(id, remote);
  }

  retireUnknown(id: string) {
    this.run("UPDATE batches SET state='retired' WHERE id=? AND remote IS NULL AND state IN ('submitting','uncertain')", id);
  }

  unresolved() {
    return this.rows<Pick<BatchRecord, 'id' | 'remote' | 'created' | 'state' | 'charge'> & { maximum: number }>("SELECT b.id,b.remote,b.created,b.state,b.charge,c.maximum FROM batches b JOIN charges c ON c.id=b.charge WHERE c.settled IS NULL AND b.state IN ('submitting','uncertain','retrieving','retired') LIMIT 20");
  }

  endedBatch(remote: string): void {
    this.run("UPDATE batches SET state='retrieving' WHERE remote=? AND state='pending'", remote);
  }

  retireRemote(remote: string): void {
    this.run("UPDATE batches SET state='retired' WHERE remote=? AND state='retrieving'", remote);
  }

  retryResults(remote: string): void {
    this.run("UPDATE batches SET state='retrieving' WHERE remote=? AND state='retired'", remote);
  }

  activeBatches() {
    return this.row<{ n: number }>("SELECT count(*) AS n FROM batches WHERE state IN ('submitting','pending','uncertain')");
  }

  dispatchDirect(charge: string, model: string, fingerprint: string) {
    this.run("INSERT INTO requests VALUES (?,?,?,NULL,NULL,'dispatching')", charge, model, fingerprint);
  }

  completeDirect(remote: string | null, usage: string, charge: string) {
    this.run("UPDATE requests SET state='complete',remote=?,usage=? WHERE charge=?", remote, usage, charge);
  }

  uncertainDirect(remote: string | null, charge: string) {
    this.run("UPDATE requests SET state=CASE WHEN usage IS NULL THEN 'uncertain' ELSE 'invalid' END,remote=COALESCE(remote,?) WHERE charge=?", remote, charge);
  }

  pendingRemotes() {
    return this.rows<{ remote: string }>("SELECT DISTINCT remote FROM batches WHERE state IN ('pending','retrieving') AND remote IS NOT NULL LIMIT 10");
  }

  private pendingResult(id: string, remote: string) {
    return this.row<BatchRecord>("SELECT * FROM batches WHERE id=? AND remote=? AND state IN ('pending','retrieving')", id, remote);
  }

  completeBatch(result: string, state: 'complete' | 'applied', id: string) {
    this.run('UPDATE batches SET result=?,state=? WHERE id=?', result, state, id);
  }

  failedBatch(result: string, id: string) {
    this.run("UPDATE batches SET result=?,state='failed' WHERE id=?", result, id);
  }

  allPendingRemotes() {
    return this.rows<{ remote: string }>("SELECT DISTINCT remote FROM batches WHERE state='pending' AND remote IS NOT NULL");
  }

  expire(now: number): void {
    this.run(`UPDATE batches SET request=json_object('model',json_extract(request,'$.model')),context='{"discard":true}',result=NULL,
      state=CASE WHEN state IN ('submitting','pending','uncertain','retrieving','retired') THEN state ELSE 'expired' END WHERE EXISTS
      (SELECT 1 FROM json_each(batches.context,'$.evidence') j LEFT JOIN revisions r ON r.id=j.value LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
      LEFT JOIN revisions latest ON latest.id=m.revision WHERE r.id IS NULL OR r.excerpt='' OR r.captured<? OR latest.deleted=1)`, now - 90 * 86_400_000);
    this.run(`UPDATE batches SET request=json_object('model',json_extract(request,'$.model')),context=json_object('discard',json('true'),'evidence',json_extract(context,'$.evidence')) WHERE created<? OR EXISTS
      (SELECT 1 FROM json_each(batches.context,'$.evidence') j JOIN revisions r ON r.id=j.value WHERE r.captured<?)`, now - 30 * 86_400_000, now - 30 * 86_400_000);
    this.run("UPDATE batches SET result=NULL,state=CASE WHEN state IN ('complete','applied','invalid','failed') THEN 'expired' ELSE state END WHERE created<?", now - 90 * 86_400_000);
  }
}
