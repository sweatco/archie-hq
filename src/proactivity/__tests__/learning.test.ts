// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitiativeStore } from '../store.js';
import { LearningService } from '../learning.js';
import { ModelGateway } from '../model.js';
import { fingerprint } from '../replay.js';
import type { ObservationSlack } from '../slack.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const DAY = 86_400_000;
const guidance = { ranking: 'Prefer explicit deadlines', context: 'Check the latest reply', reminders: 'Offer concrete help' };
let store: InitiativeStore;
let gateway: ModelGateway;
let learning: LearningService;
let authorize = vi.fn(async (_channels: string[]) => true);

function source(channel = 'C1', n = 1): number {
  store.channel(channel, true, false);
  const ts = (NOW / 1000 + n).toFixed(6);
  return store.record({ channel, thread: ts, ts, version: ts, author: 'U1', text: 'Release commitment' }, NOW)!;
}

function candidate(): void {
  const evidence = source();
  store['run']('INSERT INTO policies(id,body,base,evidence) VALUES (?,?,?,?)', 'policy1', JSON.stringify(guidance), 'base', JSON.stringify([evidence]));
  const training = episode(999, 'C1');
  store['run']('INSERT INTO policy_training VALUES (?,?,?,?,NULL)', 'policy1', training, 'C1', 'training-thread');
}

function episode(n: number, channel = 'C2', observed = NOW): string {
  const evidence = source(channel, n + 2);
  const snapshot = store.snapshot(channel, (NOW / 1000 + n + 2).toFixed(6))!;
  const matter = { id: `m${n}`, channel, thread: snapshot.thread, title: 'Release', detail: 'Needs a checklist', evidence: [evidence], state: 'open' as const,
    owner: 'U1', deadline: null, explicit: true, nextCheck: observed, valid: true, policy: 'base' };
  learning.record(snapshot, matter, { resolved: false, help: 'Checklist', public: false, evidence: [evidence] }, observed);
  return String(store['row']('SELECT id FROM episodes WHERE channel=? AND thread=?', channel, snapshot.thread)!.id);
}

function completeReflection(id: string, evidence: number[], malformed = false): void {
  const body = { stop_reason: malformed ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: JSON.stringify({ guidance, evidence,
    capabilities: [{ repository: 'owner/repo', outcome: 'Prepare release checklist', evidence }] }) }] };
  const training = evidence.map((e) => ({ episode: `training-${e}`, channel: store['row']('SELECT channel FROM revisions WHERE id=?', e)!.channel, thread: 'training-thread' }));
  store['run']('INSERT INTO batches VALUES (?,NULL,?,?,?,?,?,?)', id, 'charge', '{}', JSON.stringify({ kind: 'reflection', base: 'base', evidence, training, epoch: '0' }), 'complete', JSON.stringify(body), NOW);
}

async function cohort(spread = true) {
  candidate();
  const slack = { inspect: async () => ({ shared: false, ownerCanRead: true }), active: () => false } as unknown as ObservationSlack;
  for (let i = 0; i < 100; i++) {
    source('C2', i + 2);
    const snapshot = store.snapshot('C2', (NOW / 1000 + i + 2).toFixed(6))!;
    await learning.observe([snapshot], slack, { mode: 'shadow', owner: 'U1', extractionModel: 'claude-haiku-5-5', investigationModel: 'claude-sonnet-5-5' }, NOW + (spread ? Math.floor(i / 2) * DAY + i % 2 * 1000 : i * 1000));
  }
  const exported = learning.exportReview('policy1') as { replay: { groups: Array<{ episode: string; threads: Array<{ channel: string; thread: string }> }> } };
  const groups = exported.replay.groups.map((g, i) => ({ ...g, threads: g.threads.map((t) => ({ ...t, topics: ['releases'], urgent: i < 20, actionable: i < 80 })) }));
  const labels = { training: store['rows']("SELECT t.episode,e.payload FROM policy_training t JOIN episodes e ON e.id=t.episode WHERE t.policy='policy1'").map((r) => {
    const payload = JSON.parse(String(r.payload));
    const threads = [...new Map((payload.thread.evidence as Array<{ channel: string; thread: string }>).map(({ channel, thread }) => [`${channel}:${thread}`, { channel, thread, topics: ['other-work'] }])).values()];
    return { episode: r.episode, threads };
  }), groups };
  return { labels, groups };
}

async function completedCohort(spread = true) {
  const { labels, groups } = await cohort(spread);
  const id = learning.freezeCohort('policy1', labels);
  const messages = groups.flatMap((g, i) => {
    const payload = JSON.parse(String(store['row']('SELECT payload FROM episodes WHERE id=?', g.episode)!.payload));
    const draft = { channel: 'D_REPLAY', thread: null, text: 'Checklist', evidence: payload.thread.evidence.map((e: { id: number }) => e.id), matters: ['release'] };
    const prediction = JSON.stringify({ interventions: [draft], matters: [] });
    store['run']('UPDATE cohort_predictions SET candidate=?,baseline=? WHERE cohort=? AND episode=?', prediction, prediction, id, g.episode);
    return (['candidate', 'baseline'] as const).map((strategy) => ({ episode: g.episode, strategy, draft: fingerprint(draft), useful: strategy === 'candidate' && i < 80,
      covers: strategy === 'candidate' && i < 80 ? [`${g.threads[0].channel}:${g.threads[0].thread}`] : [], violation: false }));
  });
  store['run']("UPDATE cohorts SET state='complete' WHERE id=?", id);
  return { id, groups, review: { cohort: id, messages } };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  store = new InitiativeStore(':memory:', 'T1', NOW);
  gateway = new ModelGateway(store);
  authorize = vi.fn(async (_channels: string[]) => true);
  learning = new LearningService(store, gateway, 'claude-haiku-5-5', ['owner/repo'], authorize);
});
afterEach(() => { store.close(); vi.useRealTimers(); });

describe('learning result lifecycle', () => {
  it('falls back to baseline guidance without revoking ordinary delivery enablement', () => {
    store.set('delivery_enabled', 'true');
    store.set('policy', 'unreviewed');
    learning.revalidateApproval();
    expect(store.setting('policy')).toBe('base');
    expect(store.setting('deferred_policy')).toBe('unreviewed');
    expect(store.setting('delivery_enabled')).toBe('true');
  });

  it('isolates malformed results and still processes the next reflection', async () => {
    const evidence = [source()];
    completeReflection('bad', evidence, true); completeReflection('good', evidence);
    await learning.process(NOW);
    expect(store['row']("SELECT state FROM batches WHERE id='bad'")?.state).toBe('invalid');
    expect(store['rows']('SELECT id FROM policies')).toHaveLength(1);
    expect(store['rows']('SELECT id FROM proposals')).toHaveLength(1);
    await learning.process(NOW);
    expect(store['rows']('SELECT id FROM proposals')).toHaveLength(1);
  });

  it('discards stopped work, including after the owner starts a new responsibility epoch', async () => {
    completeReflection('stopped', [source()]);
    store.set('analysis_epoch', '1');
    await learning.process(NOW);
    expect(store['rows']('SELECT id FROM policies')).toEqual([]);
    expect(store['rows']('SELECT id FROM proposals')).toEqual([]);
  });

  it('rechecks access before using completed retained evidence', async () => {
    completeReflection('revoked', [source()]);
    authorize.mockResolvedValue(false);
    await learning.process(NOW);
    expect(authorize).toHaveBeenCalledWith(['C1']);
    expect(store['rows']('SELECT id FROM policies')).toEqual([]);
  });

  it('does not dispatch candidate predictions before a cohort is frozen', async () => {
    candidate();
    episode(200, 'C2');
    const submit = vi.spyOn(gateway, 'submitMany');
    await learning.queueReplay('policy1', new AbortController().signal);
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not let a fresh rollback grant live approval', () => {
    learning.rollback('base');
    expect(store.setting('rollout_approved')).not.toBe('base');
  });

  it('keeps feature intent intact and rejects unevidenced completion from the external workflow', async () => {
    completeReflection('proposal', [source()]);
    await learning.process(NOW);
    const proposal = store.proposal(String(store['row']('SELECT id FROM proposals')!.id))!;
    store.acknowledgeDevelopment(proposal.id, 'https://github.com/owner/repo/issues/1', 'filed', 'Triaged for the next release');
    expect(store.proposal(proposal.id)?.outcome).toBe('Prepare release checklist');
    expect(store.proposal(proposal.id)?.acknowledgedOutcome).toBeUndefined();
    expect(() => store.acknowledgeDevelopment(proposal.id, 'https://github.com/owner/repo/issues/1', 'completed' as never, 'Done')).toThrow('owner acknowledgement');
    expect(store.proposal(proposal.id)?.status).toBe('filed');
  });

  it('waits for ended reflection results instead of paying for the same reflection again', async () => {
    episode(1, 'C1');
    store.requests.prepareBatch('existing', 'charge', '{}', JSON.stringify({ kind: 'reflection', base: 'base' }), 'retrieving', NOW);
    const submit = vi.spyOn(gateway, 'submit').mockResolvedValue('unexpected');
    await learning.reflect({} as never, NOW, new AbortController().signal);
    expect(authorize).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('holds out all training inputs, including uncited channels and inherited provenance', async () => {
    const first = source('C1');
    const second = source('C2');
    completeReflection('both', [first, second]);
    const body = JSON.parse(String(store['row']("SELECT result FROM batches WHERE id='both'")!.result));
    const reflected = JSON.parse(body.content[0].text);
    reflected.evidence = [first];
    body.content[0].text = JSON.stringify(reflected);
    store['run']("UPDATE batches SET result=? WHERE id='both'", JSON.stringify(body));
    await learning.process(NOW);
    const policy = String(store['row']('SELECT id FROM policies')!.id);
    expect(store['rows']('SELECT channel FROM policy_training WHERE policy=? ORDER BY channel', policy).map((r) => r.channel)).toEqual(['C1', 'C2']);
    episode(200, 'C2');
    const submit = vi.spyOn(gateway, 'submitMany');
    await learning.queueReplay(policy, new AbortController().signal);
    expect(submit).not.toHaveBeenCalled();
    store.set('policy', policy);
    completeReflection('child', [source('C3')]);
    store['run']("UPDATE batches SET context=json_set(context,'$.base',?) WHERE id='child'", policy);
    await learning.process(NOW);
    const child = String(store['row']('SELECT id FROM policies WHERE base=?', policy)!.id);
    expect(store['rows']('SELECT channel FROM policy_training WHERE policy=? ORDER BY channel', child).map((r) => r.channel)).toEqual(['C1', 'C2', 'C3']);
  });
});

describe('human-labelled activation gate', () => {
  it('rolls back a failed cohort freeze together with its prediction rows and training labels', async () => {
    const { labels } = await cohort(false);
    store['run'](`CREATE TRIGGER interrupt_freeze BEFORE INSERT ON cohort_predictions WHEN NEW.episode='${labels.groups[1].episode}' BEGIN SELECT RAISE(ABORT,'interrupted freeze'); END`);
    expect(() => learning.freezeCohort('policy1', labels)).toThrow('interrupted freeze');
    expect(store['rows']('SELECT id FROM cohorts')).toEqual([]);
    expect(store['rows']('SELECT episode FROM cohort_predictions')).toEqual([]);
    expect(store['row']('SELECT topic FROM policy_training')?.topic).toBeNull();
  });

  // Full-cohort production replay exceeds Vitest's 5s default on CI runners.
  it('completes every frozen case through resumable production replay before scoring', async () => {
    const { labels } = await cohort(false);
    const id = learning.freezeCohort('policy1', labels);
    const submit = vi.spyOn(gateway, 'submit').mockImplementation(async (request, context) => {
      const input = request.input as { threads?: Array<{ channel: string; thread: string; evidence: Array<{ id: number }> }>; matter?: { evidence: number[] } };
      const result = input.threads ? { threads: input.threads.map((s) => ({ channel: s.channel, thread: s.thread, observations: [], matters: [{ key: 'release', title: 'Release', detail: 'Checklist', evidence: s.evidence.map((e) => e.id), state: 'open', owner: 'U1', deadline: null, explicit: true, reopen: false }] })) }
        : { resolved: false, help: 'Checklist help', public: false, evidence: input.matter!.evidence };
      const batch = `step-${submit.mock.calls.length}`;
      store['run']('INSERT INTO batches VALUES (?,NULL,?,?,?,?,?,?)', batch, batch, '{}', JSON.stringify(context), 'complete', JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] }), NOW);
      return batch;
    });
    for (let i = 0; i < 4; i++) await learning.queueReplay('policy1', new AbortController().signal);
    expect(store['row']('SELECT state FROM cohorts WHERE id=?', id)?.state).toBe('complete');
    expect(store['rows']('SELECT * FROM cohort_predictions WHERE candidate IS NOT NULL AND baseline IS NOT NULL AND error IS NULL')).toHaveLength(100);
    expect(submit).toHaveBeenCalledTimes(300);
    const exported = learning.exportReview('policy1') as { replay: { groups: Array<{ episode: string; messages: Array<{ strategy: 'candidate' | 'baseline'; draft: string }> }> } };
    const messages = exported.replay.groups.flatMap((g, i) => g.messages.map((m) => ({ ...m, episode: g.episode, useful: m.strategy === 'candidate' && i < 80,
      covers: m.strategy === 'candidate' && i < 80 ? [`${labels.groups[i].threads[0].channel}:${labels.groups[i].threads[0].thread}`] : [], violation: false })));
    const report = learning.evaluate('policy1', { cohort: id, messages }, NOW);
    expect(report.passed).toBe(true);
    learning.approve('policy1', report.id, NOW);
    expect(store.setting('rollout_approved')).toBe('policy1');
  }, 30_000);

  it('binds approval to the complete pipeline cohort and restores approved rollback versions', async () => {
    const { review } = await completedCohort();
    const evaluation = learning.evaluate('policy1', review, NOW + 60 * DAY);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.result.pipelineVerified).toBe(1);
    expect(() => learning.approve('policy1', 'another-report', NOW + 60 * DAY)).toThrow('passing evaluation');
    learning.approve('policy1', evaluation.id, NOW + 60 * DAY);
    expect(store.setting('rollout_approved')).toBe('policy1');
    learning.rollback('base'); expect(store.setting('rollout_approved')).toBe('');
    learning.rollback('policy1'); expect(store.setting('rollout_approved')).toBe('policy1');
  });

  it('counts each message against the same daily cap and each uncovered urgent thread as a miss', async () => {
    const { review } = await completedCohort(false);
    const evaluation = learning.evaluate('policy1', review, NOW);
    expect(evaluation.result.candidateUseful).toBe(2);
    expect(evaluation.result.candidateMiss).toBe(18);
  });

  it('fails a candidate that extracts nothing from urgent threads the baseline covers', async () => {
    const { id, groups, review } = await completedCohort();
    const urgent = new Set(groups.slice(0, 20).map((g) => g.episode));
    for (const group of groups.slice(0, 20)) store['run']("UPDATE cohort_predictions SET candidate='{\"interventions\":[],\"matters\":[]}' WHERE cohort=? AND episode=?", id, group.episode);
    review.messages = review.messages.filter((m) => m.strategy !== 'candidate' || !urgent.has(m.episode));
    for (const message of review.messages) if (message.strategy === 'baseline' && urgent.has(message.episode)) {
      const root = groups.find((g) => g.episode === message.episode)!.threads[0];
      message.covers = [`${root.channel}:${root.thread}`];
    }
    const evaluation = learning.evaluate('policy1', review, NOW);
    expect(evaluation.result.candidateMiss).toBe(20);
    expect(evaluation.result.baselineMiss).toBeLessThan(20);
    expect(evaluation.passed).toBe(false);
  });

  it('clears persisted live approval when restarted with changed model settings', async () => {
    const { review } = await completedCohort();
    const evaluation = learning.evaluate('policy1', review, NOW);
    learning.approve('policy1', evaluation.id, NOW);
    store.set('decision_config', 'different-models');
    learning.revalidateApproval();
    expect(store.setting('rollout_approved')).toBe('');
  });

  it('rejects late replay work and pending approvals from an earlier stop epoch', async () => {
    const { id, review } = await completedCohort();
    store['run']("UPDATE cohorts SET state='pending' WHERE id=?", id);
    store.set('analysis_epoch', '1');
    const submit = vi.spyOn(gateway, 'submit');
    await learning.queueReplay('policy1', new AbortController().signal);
    expect(submit).not.toHaveBeenCalled();
    expect(store['row']('SELECT state FROM cohorts WHERE id=?', id)?.state).toBe('invalid');
    expect(() => learning.evaluate('policy1', review, NOW)).toThrow('Incomplete');
  });

  it('requires topics for every training thread, including related context', async () => {
    const { labels } = await cohort();
    const related = source('C1', 2000);
    const row = store['row']('SELECT * FROM revisions WHERE id=?', related)!;
    store['run']("UPDATE episodes SET payload=json_insert(payload,'$.thread.evidence[#]',json(?)) WHERE id=?", JSON.stringify({ id: related, channel: row.channel, thread: row.thread }), labels.training[0].episode);
    expect(() => learning.freezeCohort('policy1', labels)).toThrow('all training threads');
    labels.training[0].threads.push({ channel: 'C1', thread: String(row.thread), topics: ['releases'] });
    expect(() => learning.freezeCohort('policy1', labels)).toThrow('disjoint topics');
  });

  it('rejects omitted messages, altered predictions, and incomplete cases', async () => {
    const { id, groups, review } = await completedCohort();
    expect(() => learning.evaluate('policy1', { ...review, messages: review.messages.slice(1) }, NOW)).toThrow('every candidate');
    expect(() => learning.evaluate('policy1', { ...review, messages: [{ ...review.messages[0], draft: 'changed' }, ...review.messages.slice(1)] }, NOW)).toThrow('every candidate');
    store['run']('UPDATE cohort_predictions SET candidate=NULL WHERE cohort=? AND episode=?', id, groups[0].episode);
    expect(() => learning.evaluate('policy1', review, NOW)).toThrow('Incomplete cohort');
  });

  it('rejects rollout after any recorded source is deleted or expired', async () => {
    const { groups, review } = await completedCohort();
    const evaluation = learning.evaluate('policy1', review, NOW + 60 * DAY);
    const payload = JSON.parse(String(store['row']('SELECT payload FROM episodes WHERE id=?', groups[0].episode)!.payload));
    const evidence = payload.thread.evidence[0];
    store.record({ ...evidence, version: (NOW / 1000 + 60 * DAY / 1000).toFixed(6), text: '', deleted: true }, NOW + 60 * DAY);
    expect(() => learning.approve('policy1', evaluation.id, NOW + 60 * DAY)).toThrow('deleted or unavailable');
    store.expire(NOW + 60 * DAY); learning.expire(NOW + 60 * DAY);
    expect(() => learning.approve('policy1', evaluation.id, NOW + 60 * DAY)).toThrow('expired');
  });

  it('rejects deleted uncited training evidence before and after cleanup', async () => {
    const { id, review } = await completedCohort();
    const report = learning.evaluate('policy1', review, NOW);
    const training = store['row']("SELECT e.id,e.payload FROM policy_training t JOIN episodes e ON e.id=t.episode WHERE t.policy='policy1'")!;
    const evidence = JSON.parse(String(training.payload)).thread.evidence[0];
    store.record({ ...evidence, text: '', deleted: true, version: (NOW / 1000 + 2000).toFixed(6) }, NOW);
    expect(() => learning.approve('policy1', report.id, NOW)).toThrow('cohort');
    learning.expire(NOW);
    expect(store['row']('SELECT id FROM episodes WHERE id=?', training.id)).toBeUndefined();
    expect(store['row']('SELECT candidate FROM cohort_predictions WHERE cohort=? LIMIT 1', id)?.candidate).toBeNull();
    expect(() => learning.approve('policy1', report.id, NOW)).toThrow('cohort');
  });

  it('preserves approved inherited provenance without treating it as fresh training input', async () => {
    const { groups, review } = await completedCohort();
    const report = learning.evaluate('policy1', review, NOW);
    learning.approve('policy1', report.id, NOW);
    const inherited = store['row']("SELECT episode FROM policy_training WHERE policy='policy1'")!.episode;
    store['run']('DELETE FROM episodes WHERE id=?', inherited);
    learning.expire(NOW);
    const evidence = source('C3', 2000);
    store['run']('INSERT INTO policies(id,body,base,evidence) VALUES (?,?,?,?)', 'policy2', JSON.stringify(guidance), 'policy1', JSON.stringify([evidence]));
    store['run']("INSERT INTO policy_training SELECT 'policy2',episode,channel,thread,topic FROM policy_training WHERE policy='policy1'");
    const fresh = episode(3000, 'C3');
    store['run']('INSERT INTO policy_training VALUES (?,?,?,?,NULL)', 'policy2', fresh, 'C3', 'fresh');
    store['run']('INSERT INTO policy_inputs VALUES (?,?)', 'policy2', fresh);
    const training = store['rows']("SELECT t.episode,t.topic,e.payload FROM policy_training t LEFT JOIN episodes e ON e.id=t.episode WHERE t.policy='policy2'").map((r) => ({ episode: r.episode,
      threads: r.topic ? JSON.parse(String(r.topic)) : JSON.parse(String(r.payload)).thread.evidence.map(({ channel, thread }: { channel: string; thread: string }) => ({ channel, thread, topics: ['new-work'] })) }));
    learning.freezeCohort('policy2', { training, groups });
    vi.spyOn(gateway, 'batchCapacity').mockReturnValueOnce(1).mockReturnValue(0);
    const submit = vi.spyOn(gateway, 'submit').mockResolvedValue('pending');
    await learning.queueReplay('policy2', new AbortController().signal);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store['row']("SELECT state FROM cohorts WHERE policy='policy2'")?.state).toBe('pending');
  });

  it('freezes chronological membership, topic holdout and ground truth before predictions', async () => {
    const { labels } = await cohort();
    expect(() => learning.freezeCohort('policy1', { ...labels, groups: labels.groups.slice(1) })).toThrow('without skipping');
    expect(() => learning.freezeCohort('policy1', { ...labels, training: [{ ...labels.training[0], threads: labels.training[0].threads.map((t) => ({ ...t, topics: ['releases'] })) }] })).toThrow('disjoint topics');
    learning.freezeCohort('policy1', labels);
    expect(() => learning.freezeCohort('policy1', labels)).toThrow('immutable');
  });

  it('invalidates reports when the pipeline or full source snapshot changes', async () => {
    const { id, review } = await completedCohort();
    store['run']("UPDATE cohorts SET manifest=json_set(manifest,'$.pipeline','older-code') WHERE id=?", id);
    expect(() => learning.evaluate('policy1', review, NOW)).toThrow('changed full-pipeline');
  });

  it('does not admit bot-only episodes to the human forward cohort', async () => {
    const ts = (NOW / 1000 + 1).toFixed(6);
    store.channel('C1', true, false);
    store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U_APP', bot: true, text: 'Automated release alert' }, NOW);
    const slack = { inspect: async () => ({ shared: false, ownerCanRead: true }), active: () => false } as unknown as ObservationSlack;
    await learning.observe([store.snapshot('C1', ts)!], slack, { mode: 'shadow', owner: 'U1', extractionModel: 'claude-haiku-5-5', investigationModel: 'claude-sonnet-5-5' }, NOW);
    expect(store['rows']('SELECT id FROM episodes')).toEqual([]);
  });
});


it.each(['configuration', 'body', 'cohort'] as const)('does not activate a rollback with invalid %s proof or disable baseline delivery', async change => {
  const { review } = await completedCohort();
  const evaluation = learning.evaluate('policy1', review, NOW);
  learning.approve('policy1', evaluation.id, NOW);
  expect(learning.rollback('base')).toBe(true);
  store.set('delivery_enabled', 'true');
  if (change === 'configuration') store.set('decision_config', 'different-models');
  if (change === 'body') store['run']("UPDATE policies SET body='{}' WHERE id='policy1'");
  if (change === 'cohort') store['run']("UPDATE cohorts SET state='invalid' WHERE policy='policy1'");
  const activation = vi.spyOn(store.learning, 'selectApprovedGuidance');
  expect(learning.rollback('policy1')).toBe(false);
  expect(activation).not.toHaveBeenCalled();
  expect(store.setting('policy')).toBe('base');
  expect(store.setting('delivery_enabled')).toBe('true');
});


it('propagates approval storage failure without mutating selected guidance or delivery enablement', async () => {
  const { review } = await completedCohort();
  const evaluation = learning.evaluate('policy1', review, NOW);
  learning.approve('policy1', evaluation.id, NOW);
  store.set('delivery_enabled', 'true');
  vi.spyOn(store.learning, 'passingEvaluation').mockImplementationOnce(() => { throw new Error('SQLITE_CORRUPT fixture'); });
  expect(() => learning.revalidateApproval()).toThrow('SQLITE_CORRUPT');
  expect(store.setting('policy')).toBe('policy1');
  expect(store.setting('delivery_enabled')).toBe('true');
});
