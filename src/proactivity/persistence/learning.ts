// SPDX-License-Identifier: AGPL-3.0-or-later
import { proposalVersion } from '../proposals.js';
import type { CapabilityProposal } from '../types.js';
import type { Manifest } from '../cohort.js';
import type { DecisionResult } from '../replay.js';
import { SqlOperations, type RevisionRecord, type PolicyRecord, type EpisodeRecord, type CohortRecord, type PredictionRecord, type EvaluationRecord } from './sql.js';

export class LearningRecords extends SqlOperations {
  episodeExists(id: string) {
    return this.row<{ id: string }>('SELECT id FROM episodes WHERE id=?', id);
  }

  humanRevision(revision: number) {
    return this.row<RevisionRecord>('SELECT * FROM revisions WHERE id=? AND own=0 AND bot=0 AND deleted=0', revision);
  }

  recordEpisode(id: string, channel: string, thread: string, topic: string, observed: number, payload: string, baseline: string) {
    this.run('INSERT OR IGNORE INTO episodes VALUES (?,?,?,?,?,?,?)', id, channel, thread, topic, observed, payload, baseline);
  }

  latestEpisode(channel: string, thread: string) {
    return this.row<{ id: string }>("SELECT e.id FROM episodes e,json_each(e.payload,'$.decision.roots') r WHERE e.channel=? AND json_extract(r.value,'$.thread')=? ORDER BY e.observed DESC LIMIT 1", channel, thread);
  }

  updateActual(matter: string, assessment: string, episode: string) {
    this.run("UPDATE episodes SET payload=json_set(payload,'$.matter',json(?),'$.actual',json(?)) WHERE id=?", matter, assessment, episode);
  }

  currentHumanEvidence(revision: number, since: number) {
    return this.row<{ id: number }>(`SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id JOIN channels c ON c.id=r.channel
      WHERE r.id=? AND r.deleted=0 AND r.own=0 AND r.bot=0 AND c.allowed=1 AND r.captured>=? AND r.excerpt!=''`, revision, since);
  }

  revisionChannel(revision: number) {
    return this.row<{ channel: string }>('SELECT channel FROM revisions WHERE id=?', revision);
  }

  episode(id: string) {
    return this.row<{ payload: string }>('SELECT payload FROM episodes WHERE id=?', id);
  }

  retainedEvidence(revision: number, since: number) {
    return this.row<{ id: number }>(`SELECT r.id FROM revisions r JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
      JOIN revisions latest ON latest.id=m.revision JOIN channels c ON c.id=r.channel
      WHERE r.id=? AND r.excerpt!='' AND r.captured>=? AND latest.deleted=0 AND c.allowed=1`, revision, since);
  }

  evaluationChannels(evaluation: string, policy: string) {
    return this.rows<{ channel: string }>(`SELECT e.channel FROM evaluations v,json_each(v.episodes) j
      JOIN episodes e ON e.id=j.value WHERE v.id=? AND v.policy=?`, evaluation, policy);
  }

  trainingChannels(policy: string) {
    return this.rows<{ channel: string }>('SELECT DISTINCT channel FROM policy_training WHERE policy=?', policy);
  }

  recentEpisodes() {
    return this.rows<EpisodeRecord>('SELECT * FROM episodes ORDER BY observed DESC LIMIT 100');
  }

  pendingReflection(base: string) {
    return this.row<{ id: string }>("SELECT id FROM batches WHERE json_extract(context,'$.kind')='reflection' AND json_extract(context,'$.base')=? AND state IN ('submitting','pending','uncertain','retrieving')", base);
  }

  recentFeedback() {
    return this.rows<{ matter: string; action: string }>('SELECT matter,action FROM feedback ORDER BY created DESC LIMIT 20');
  }

  developmentFeedback() {
    return this.rows<{ id: string; status: string; issue: string | null; body: string }>("SELECT id,status,issue,body FROM proposals WHERE status!='pending filing' LIMIT 10");
  }

  proposedPolicy() {
    return this.rows<{ id: string }>("SELECT id FROM policies WHERE state='proposed' LIMIT 1");
  }

  completedReflections() {
    return this.rows<{ id: string; context: string }>("SELECT id,context FROM batches WHERE state='complete' AND json_extract(context,'$.kind')='reflection'");
  }

  proposeCapability(id: string, proposal: Pick<CapabilityProposal, 'repository' | 'outcome' | 'evidence'> & { budgetResponsibility?: string; dailyLimitMicrodollars?: number }) {
    const versioned = JSON.stringify({ ...proposal, origin: 'evolution', version: proposalVersion(proposal) });
    this.run(`INSERT INTO proposals(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE proposals.status='pending filing' AND NOT EXISTS (SELECT 1 FROM handoffs WHERE proposal=proposals.id)`, id, versioned);
  }

  applyReflection(batch: string) {
    this.run("UPDATE batches SET state='applied' WHERE id=? AND state='complete'", batch);
  }

  pendingCohorts() {
    return this.rows<{ policy: string }>("SELECT policy FROM cohorts WHERE state='pending'");
  }

  trainingReview(policy: string) {
    return this.rows<{ episode: string; channel: string; thread: string; topic: string | null; payload: string | null }>('SELECT t.episode,t.channel,t.thread,t.topic,e.payload FROM policy_training t LEFT JOIN episodes e ON e.id=t.episode WHERE t.policy=?', policy);
  }

  policy(id: string) {
    return this.row<PolicyRecord>('SELECT * FROM policies WHERE id=?', id);
  }

  passingEvaluation(id: string, policy: string, rubric: string) {
    return this.row<EvaluationRecord>('SELECT * FROM evaluations WHERE id=? AND policy=? AND passed=1 AND rubric=?', id, policy, rubric);
  }

  approvedPolicy(id: string) {
    return this.row<{ id: string }>("SELECT id FROM policies WHERE id=? AND state IN ('active','archived')", id);
  }

  evaluationProof(id: string, policy: string) {
    return this.row<{ result: string }>('SELECT result FROM evaluations WHERE id=? AND policy=? AND passed=1', id, policy);
  }

  chronologicalEpisodes() {
    return this.rows<Pick<EpisodeRecord, 'id' | 'channel' | 'payload'>>('SELECT id,channel,payload FROM episodes ORDER BY observed,id');
  }

  currentEvidence(revision: number) {
    return this.row<{ id: number }>(`SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id JOIN channels c ON c.id=r.channel WHERE r.id=? AND r.deleted=0 AND r.excerpt!='' AND c.allowed=1`, revision);
  }

  cohort(policy: string) {
    const row = this.row<CohortRecord>('SELECT * FROM cohorts WHERE policy=?', policy);
    return row ? { ...row, manifest: JSON.parse(row.manifest) as Manifest } : undefined;
  }

  prediction(cohort: string, episode: string) {
    const row = this.row<PredictionRecord>('SELECT * FROM cohort_predictions WHERE cohort=? AND episode=?', cohort, episode);
    return row ? { ...row, candidate: row.candidate ? JSON.parse(row.candidate) as DecisionResult : null, baseline: row.baseline ? JSON.parse(row.baseline) as DecisionResult : null } : undefined;
  }

  inheritedInput(policy: string, episode: string) {
    return this.row<{ episode: string }>('SELECT episode FROM policy_training WHERE policy=? AND episode=?', policy, episode);
  }

  freshInput(policy: string, episode: string) {
    return this.row<{ episode: string }>('SELECT episode FROM policy_inputs WHERE policy=? AND episode=?', policy, episode);
  }

  allManifests() {
    return this.rows<Pick<CohortRecord, 'id' | 'manifest'>>('SELECT id,manifest FROM cohorts').map(row => ({ id: row.id, manifest: JSON.parse(row.manifest) as Manifest }));
  }

  failPrediction(error: string, cohort: string, episode: string) {
    this.run('UPDATE cohort_predictions SET error=? WHERE cohort=? AND episode=?', error, cohort, episode);
  }

  incompletePrediction(cohort: string) {
    return this.row<{ episode: string }>('SELECT episode FROM cohort_predictions WHERE cohort=? AND (candidate IS NULL OR baseline IS NULL OR error IS NOT NULL)', cohort);
  }

  completeCohort(cohort: string) {
    this.run("UPDATE cohorts SET state='complete' WHERE id=?", cohort);
  }

  savePrediction(column: 'candidate' | 'baseline', result: DecisionResult, cohort: string, episode: string) {
    this.run(`UPDATE cohort_predictions SET ${column}=? WHERE cohort=? AND episode=?`, JSON.stringify(result), cohort, episode);
  }

  freezeCohort(id: string, policy: string, manifest: Manifest): void {
    this.atomic(() => {
      this.run("INSERT INTO cohorts VALUES (?,?,?,'pending')", id, policy, JSON.stringify(manifest));
      for (const group of manifest.groups) this.run('INSERT INTO cohort_predictions(cohort,episode) VALUES (?,?)', id, group.episode);
      for (const item of manifest.training) this.run('UPDATE policy_training SET topic=? WHERE policy=? AND episode=?', JSON.stringify(item.threads), policy, item.episode);
    });
  }

  activatePolicy(policy: string, deliveryApproved: boolean): void {
    this.atomic(() => {
      this.run("UPDATE policies SET state='archived' WHERE state='active'");
      this.run("UPDATE policies SET state='active' WHERE id=?", policy);
      this.run("INSERT INTO settings VALUES ('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", policy);
      this.run("INSERT INTO settings VALUES ('rollout_approved',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", deliveryApproved ? policy : '');
      this.run("UPDATE matters SET body=json_set(body,'$.policy',?)", policy);
      this.run("UPDATE deliveries SET state='cancelled' WHERE state='pending'");
    });
  }

  recordEvaluation(id: string, policy: string, rubric: string, episodes: string[], result: object, passed: boolean, created: number): void {
    this.atomic(() => {
      this.run('INSERT OR IGNORE INTO evaluations VALUES (?,?,?,?,?,?,?)', id, policy, rubric, JSON.stringify(episodes), JSON.stringify(result), Number(passed), created);
      this.run('UPDATE policies SET evaluation=? WHERE id=?', id, policy);
    });
  }

  invalidateCohort(cohort: string, scrub = false): void {
    this.atomic(() => {
      if (scrub) this.run("UPDATE cohort_predictions SET candidate=NULL,baseline=NULL,error='Source expired or unavailable' WHERE cohort=?", cohort);
      this.run("UPDATE cohorts SET state='invalid' WHERE id=?", cohort);
    });
  }

  proposePolicy(id: string, body: object, base: string, evidence: number[], training: Array<{ episode: string; channel: string; thread: string }>): void {
    this.atomic(() => {
      this.run('INSERT OR IGNORE INTO policies(id,body,base,evidence) VALUES (?,?,?,?)', id, JSON.stringify(body), base, JSON.stringify(evidence));
      this.run('INSERT OR IGNORE INTO policy_training SELECT ?,episode,channel,thread,topic FROM policy_training WHERE policy=?', id, base);
      for (const item of training) {
        this.run('INSERT OR IGNORE INTO policy_training VALUES (?,?,?,?,NULL)', id, item.episode, item.channel, item.thread);
        this.run('INSERT OR IGNORE INTO policy_inputs VALUES (?,?)', id, item.episode);
      }
    });
  }



}
