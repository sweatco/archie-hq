// SPDX-License-Identifier: AGPL-3.0-or-later
import { LearningService } from '../../learning.js';
import { ModelGateway } from '../../model.js';
import { fingerprint } from '../../replay.js';
import type { InitiativeConfig } from '../../service.js';
import type { InitiativeStore } from '../../store.js';
import type { ObservationSlack } from '../../slack.js';

// Exercises real cohort/evaluation/approval transitions with labelled, simulated predictions.
export async function approveFixturePolicy(store: InitiativeStore, config: InitiativeConfig, now: number): Promise<string> {
  const learning = new LearningService(store, new ModelGateway(store), config.investigationModel, config.repositories ?? [], async () => true);
  const source = (channel: string, at: number) => {
    store.channel(channel, true, false);
    const ts = (at / 1000).toFixed(6);
    const id = store.record({ channel, thread: ts, ts, version: ts, author: config.owner, text: 'Human release request' }, at)!;
    return { id, snapshot: store.snapshot(channel, ts)! };
  };
  const training = source('C_TRAIN', now + 1);
  learning.record(training.snapshot, { id: 'training', channel: 'C_TRAIN', thread: training.snapshot.thread, title: 'Release', detail: 'Checklist', evidence: [training.id], state: 'open', owner: config.owner, deadline: null, explicit: true, nextCheck: now, valid: true, policy: 'base' }, { resolved: false, help: null, public: false, evidence: [training.id] }, now + 1);
  const episode = String(store['row']("SELECT id FROM episodes WHERE channel='C_TRAIN'")!.id);
  const policy = 'approved-fixture';
  store['run']('INSERT INTO policies(id,body,base,evidence) VALUES (?,?,?,?)', policy, JSON.stringify({ ranking: 'Prefer explicit deadlines', context: 'Read current source', reminders: 'Offer useful help' }), 'base', JSON.stringify([training.id]));
  store['run']('INSERT INTO policy_training VALUES (?,?,?,?,NULL)', policy, episode, 'C_TRAIN', training.snapshot.thread);
  const slack = { inspect: async () => ({ shared: false, ownerCanRead: true }), active: () => false } as unknown as ObservationSlack;
  for (let i = 0; i < 100; i++) {
    const observed = now + 60_000 + i * 1000;
    const item = source('C_EVAL', observed - 1);
    await learning.observe([item.snapshot], slack, config, observed);
  }
  const exported = learning.exportReview(policy) as { replay: { groups: Array<{ episode: string; threads: Array<{ channel: string; thread: string }> }> } };
  const groups = exported.replay.groups.map((group, i) => ({ ...group, threads: group.threads.map(thread => ({ ...thread, topics: ['evaluation'], urgent: i < 20, actionable: i < 80 })) }));
  const cohort = learning.freezeCohort(policy, { training: [{ episode, threads: [{ channel: 'C_TRAIN', thread: training.snapshot.thread, topics: ['training'] }] }], groups });
  const messages = groups.flatMap((group, i) => {
    const payload = JSON.parse(String(store['row']('SELECT payload FROM episodes WHERE id=?', group.episode)!.payload));
    const draft = { channel: 'D_REPLAY', thread: null, text: 'Checklist help', evidence: payload.thread.evidence.map((e: { id: number }) => e.id), matters: ['release'] };
    const prediction = JSON.stringify({ interventions: [draft], matters: [] });
    store['run']('UPDATE cohort_predictions SET candidate=?,baseline=? WHERE cohort=? AND episode=?', prediction, prediction, cohort, group.episode);
    return (['candidate', 'baseline'] as const).map(strategy => ({ episode: group.episode, strategy, draft: fingerprint(draft), useful: strategy === 'candidate' && i < 80, covers: strategy === 'candidate' && i < 80 ? [`${group.threads[0].channel}:${group.threads[0].thread}`] : [], violation: false }));
  });
  store['run']("UPDATE cohorts SET state='complete' WHERE id=?", cohort);
  const report = learning.evaluate(policy, { cohort, messages }, now + 3_600_000);
  if (!report.passed) throw new Error('Fixture evaluation did not pass');
  learning.approve(policy, report.id, now + 3_600_000);
  return policy;
}
