// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { InitiativeStore } from './store.js';
import { lisbonDay } from './types.js';
import type { ModelGateway } from './model.js';
import { AdmissionDeferred } from './model.js';
import { decisionConfig } from './service.js';
import { PIPELINE, fingerprint, replayDecision, replayModel, validDecision, type DecisionCase } from './replay.js';

import { RUBRIC } from './rubric.js';
export { RUBRIC } from './rubric.js';
const TopicList = z.array(z.string().min(1).max(120)).min(1).max(64);
const ThreadTopics = z.object({ channel: z.string(), thread: z.string(), topics: TopicList });
const Truth = ThreadTopics.extend({ urgent: z.boolean(), actionable: z.boolean() });
const Training = z.object({ episode: z.string(), threads: z.array(ThreadTopics).min(1).max(1000) });
const Freeze = z.object({ training: z.array(Training).min(1).max(1000), groups: z.array(z.object({ episode: z.string(), threads: z.array(Truth).min(1).max(16) })).min(1).max(1000) });
type TrainingInput = { episode: string; input: string | null; approved: string | null };
export type Manifest = { pipeline: string; config: string; epoch: string; policy: string; body: string; base: string; baseBody: string; rubric: string; training: z.infer<typeof Training>[]; trainingInputs: TrainingInput[]; groups: Array<z.infer<typeof Freeze>['groups'][number] & { input: string }> };
const threadKey = (t: { channel: string; thread: string }) => `${t.channel}:${t.thread}`;

export class CohortRunner {
  constructor(private readonly store: InitiativeStore, private readonly gateway: ModelGateway, private readonly authorize: (channels: string[]) => Promise<boolean>) {}

  private selection(policy: string) {
    const channels = this.store.learning.trainingChannels(policy).map((r) => String(r.channel));
    const seen = new Set<string>();
    return this.store.learning.chronologicalEpisodes().filter((r) => {
      const input = JSON.parse(String(r.payload)).decision as DecisionCase | undefined;
      if (!input || channels.includes(String(r.channel)) || !validDecision(this.store, input) || input.roots.some((s) => seen.has(threadKey(s)))) return false;
      input.roots.forEach((s) => seen.add(threadKey(s)));
      return true;
    });
  }

  private sources(input: DecisionCase): unknown {
    return input.sources.map((s) => ({ ...s, evidence: s.evidence.map((id) => {
      const row = this.store.attention.revision(id);
      return row ? { id, ts: row.ts, version: row.version, author: row.author, own: row.own === 1, bot: row.bot === 1, text: row.text || row.excerpt } : { id, unavailable: true };
    }) }));
  }

  private trainingInput(episode: string): { hash: string; valid: boolean } | null {
    const row = this.store.learning.episode(episode);
    if (!row) return null;
    const payload = JSON.parse(String(row.payload));
    const valid = payload.decision ? validDecision(this.store, payload.decision) : (payload.thread.evidence.length > 0 && payload.thread.evidence.every((e: { id: number }) =>
      this.store.learning.currentEvidence(e.id)));
    return { hash: fingerprint(payload.decision ?? payload.thread), valid };
  }

  private approvedProof(policy: string, evaluation: string | null): boolean {
    const row = evaluation && this.store.learning.evaluationProof(evaluation, policy);
    const result = row ? JSON.parse(String(row.result)) : null;
    return result?.pipelineVerified === 1 && this.valid(policy, result.cohort, false);
  }

  export(policy: string): unknown {
    const row = this.store.learning.cohort(policy);
    if (!row) return { cohort: null, rubric: RUBRIC, groups: this.selection(policy).map((r) => {
      const { decision } = JSON.parse(String(r.payload));
      return { episode: r.id, threads: (decision as DecisionCase).roots, source: this.sources(decision) };
    }) };
    const manifest = row.manifest;
    return { cohort: row.id, state: row.state, manifest, groups: manifest.groups.map((g) => {
      const r = this.store.learning.prediction(row.id, g.episode)!;
      const candidate = r.candidate;
      const baseline = r.baseline;
      const input = JSON.parse(String(this.store.learning.episode(g.episode)?.payload ?? '{}')).decision;
      return { ...g, candidate, baseline, error: r.error, source: input ? this.sources(input) : 'Source expired',
        messages: [...(candidate?.interventions ?? []).map((draft: unknown) => ({ strategy: 'candidate', draft: fingerprint(draft), content: draft })),
          ...(baseline?.interventions ?? []).map((draft: unknown) => ({ strategy: 'baseline', draft: fingerprint(draft), content: draft }))] };
    }) };
  }

  freeze(policy: string, labels: unknown): string {
    const review = Freeze.parse(labels);
    if (this.store.learning.cohort(policy)) throw new Error('This policy already has an immutable cohort');
    const candidate = this.store.learning.policy(policy);
    if (!candidate || candidate.state !== 'proposed' || candidate.base !== this.store.setting('policy')) throw new Error('Stale evaluation base');
    const training = this.store.learning.trainingReview(policy);
    if (!training.length || training.length !== review.training.length || new Set(review.training.map((t) => t.episode)).size !== training.length) throw new Error('Label every training example');
    for (const t of training) {
      const label = review.training.find((l) => l.episode === t.episode);
      if (!label || (t.topic && t.topic !== JSON.stringify(label.threads)) || (!t.topic && !t.payload)) throw new Error('Training topics are missing, changed or expired');
      if (!t.topic) {
        const payload = JSON.parse(String(t.payload));
        const required = new Set([...(payload.thread.evidence as Array<{ channel: string; thread: string }>), ...(payload.decision?.roots ?? [])].map(threadKey));
        if (required.size !== label.threads.length || new Set(label.threads.map(threadKey)).size !== required.size || label.threads.some((s) => !required.has(threadKey(s)))) throw new Error('Label all training threads and their complete topic sets');
      }
    }
    const selected = this.selection(policy).slice(0, review.groups.length);
    if (selected.length !== review.groups.length || selected.some((r, i) => r.id !== review.groups[i].episode)) throw new Error('Label the complete chronological cohort without skipping cases');
    const topics = new Set(review.training.flatMap((t) => t.threads.flatMap((s) => s.topics)));
    const groups = review.groups.map((g, i) => {
      const input = JSON.parse(String(selected[i].payload)).decision as DecisionCase;
      if (this.store.setting('decision_config') && decisionConfig(input.config) !== this.store.setting('decision_config')) throw new Error('Model configuration changed; collect current forward cases');
      if (g.threads.length !== input.roots.length || new Set(g.threads.map(threadKey)).size !== input.roots.length
        || g.threads.some((t) => !input.roots.some((s) => threadKey(s) === threadKey(t)) || t.topics.some((topic) => topics.has(topic)) || (t.urgent && !t.actionable))) throw new Error('Ground truth must cover every held-out thread with disjoint topics');
      return { ...g, input: fingerprint(input) };
    });
    const threads = groups.flatMap((g) => g.threads);
    if (threads.length < 100 || threads.filter((t) => t.urgent).length < 20 || threads.filter((t) => !t.actionable).length < 20) throw new Error('Cohort needs 100 threads, including 20 urgent and 20 non-actionable');
    const config = decisionConfig((JSON.parse(String(selected[0].payload)).decision as DecisionCase).config);
    const trainingInputs = review.training.map(({ episode }): TrainingInput => {
      const inherited = this.store.learning.inheritedInput(candidate.base, episode)
        && !this.store.learning.freshInput(policy, episode);
      const approved = inherited ? this.store.setting(`approved:${candidate.base}`) ?? null : null;
      if (approved && this.approvedProof(String(candidate.base), approved)) return { episode, input: null, approved };
      const input = this.trainingInput(episode);
      if (!input?.valid) throw new Error('Fresh training evidence expired, deleted or unavailable');
      return { episode, input: input.hash, approved: null };
    });
    const manifest: Manifest = { pipeline: PIPELINE, config, epoch: this.store.setting('analysis_epoch') ?? '0', policy, body: String(candidate.body), base: String(candidate.base), baseBody: String(this.store.learning.policy(candidate.base)?.body ?? '{}'), rubric: RUBRIC, training: review.training, trainingInputs, groups };
    const id = fingerprint(manifest).slice(0, 24);
    this.store.learning.freezeCohort(id, policy, manifest);
    return id;
  }

  valid(policy: string, cohort: string, sources = true): boolean {
    const row = this.store.learning.cohort(policy);
    if (!row || row.id !== cohort) return false;
    const manifest = row.manifest;
    return manifest.pipeline === PIPELINE && manifest.rubric === RUBRIC && manifest.body === this.store.learning.policy(policy)?.body
      && (!this.store.setting('decision_config') || manifest.config === this.store.setting('decision_config'))
      && (!sources || (manifest.epoch === (this.store.setting('analysis_epoch') ?? '0') && manifest.base === this.store.setting('policy') && manifest.trainingInputs.every((t) => {
        if (t.approved) return this.approvedProof(manifest.base, t.approved);
        const input = this.trainingInput(t.episode);
        return input?.valid && input.hash === t.input;
      }) && manifest.groups.every((g) => {
        const payload = this.store.learning.episode(g.episode)?.payload;
        const input = payload ? JSON.parse(String(payload)).decision as DecisionCase : null;
        return input && fingerprint(input) === g.input && validDecision(this.store, input);
      })));
  }

  expire(): void {
    for (const row of this.store.learning.allManifests()) {
      const manifest = row.manifest;
      if (manifest.trainingInputs.every((t) => t.approved || this.trainingInput(t.episode)?.valid) && manifest.groups.every((g) => {
        const payload = this.store.learning.episode(g.episode)?.payload;
        return payload && validDecision(this.store, JSON.parse(String(payload)).decision);
      })) continue;
      this.store.learning.invalidateCohort(String(row.id), true);
    }
  }

  async progress(policy: string, signal: AbortSignal): Promise<void> {
    const row = this.store.learning.cohort(policy);
    if (!row || row.state !== 'pending') return;
    if (!this.valid(policy, String(row.id))) { this.store.learning.invalidateCohort(row.id); return; }
    const manifest = row.manifest;
    for (const group of manifest.groups) {
      signal.throwIfAborted();
      const prediction = this.store.learning.prediction(row.id, group.episode)!;
      if (prediction.error || (prediction.candidate && prediction.baseline)) continue;
      const input = JSON.parse(String(this.store.learning.episode(group.episode)!.payload)).decision as DecisionCase;
      const authorize = () => this.authorize([...new Set(input.sources.map((s) => s.channel))]);
      if (!await authorize()) return;
      const model = replayModel(this.store, this.gateway, String(row.id), group.episode, input.refs.map((r) => r.id), authorize);
      try {
        for (const [column, version, body, baseline] of [['candidate', policy, manifest.body, false], ['baseline', manifest.base, manifest.baseBody, true]] as const) {
          if (prediction[column]) continue;
          const result = await replayDecision(this.store, input, version, body, model, baseline, signal);
          if (!this.valid(policy, String(row.id)) || this.store.setting('stop') === 'true') return;
          this.store.learning.savePrediction(column, result, row.id, group.episode);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof AdmissionDeferred)) this.store.learning.failPrediction(error instanceof Error ? error.message : 'Replay failed', row.id, group.episode);
      }
      if (!this.gateway.batchCapacity()) break;
    }
    if (!this.store.learning.incompletePrediction(row.id)) this.store.learning.completeCohort(row.id);
  }

  evaluate(policy: string, labels: unknown, now: number) {
    const review = z.object({ cohort: z.string(), messages: z.array(z.object({ episode: z.string(), strategy: z.enum(['candidate', 'baseline']), draft: z.string(), useful: z.boolean(), covers: z.array(z.string()).max(16), violation: z.boolean() })).max(10000) }).parse(labels);
    const row = this.store.learning.cohort(policy);
    if (!row || row.id !== review.cohort || row.state !== 'complete' || !this.valid(policy, review.cohort)) throw new Error('Incomplete, expired or changed full-pipeline cohort');
    const manifest = row.manifest;
    const threads = manifest.groups.flatMap((g) => g.threads);
    const covered = { candidate: new Set<string>(), baseline: new Set<string>() };
    const used = new Map<string, { candidate: number; baseline: number }>();
    const expected = new Set<string>();
    let candidateUseful = 0, baselineUseful = 0, violations = 0;
    for (const group of manifest.groups) {
      const prediction = this.store.learning.prediction(review.cohort, group.episode)!;
      if (prediction.error || !prediction.candidate || !prediction.baseline) throw new Error('Incomplete cohort coverage');
      const input = JSON.parse(String(this.store.learning.episode(group.episode)!.payload)).decision as DecisionCase;
      const day = lisbonDay(input.now), slots = used.get(day) ?? { candidate: 0, baseline: 0 };
      for (const strategy of ['candidate', 'baseline'] as const) {
        const output = prediction[strategy]!;
        for (const draft of output.interventions) {
          const key = `${group.episode}:${strategy}:${fingerprint(draft)}`;
          if (expected.has(key)) throw new Error('Duplicate replay draft identity');
          expected.add(key);
          const matching = review.messages.filter((l) => `${l.episode}:${l.strategy}:${l.draft}` === key);
          if (matching.length !== 1) throw new Error('Label every candidate and baseline message exactly once');
          const label = matching[0];
          if (new Set(label.covers).size !== label.covers.length || label.covers.some((id) => !group.threads.some((t) => threadKey(t) === id && t.actionable)) || (label.useful && !label.covers.length)) throw new Error('Inconsistent message coverage');
          violations += Number(label.violation);
          if (slots[strategy]++ >= 2) continue;
          label.covers.forEach((id) => covered[strategy].add(id));
          if (strategy === 'candidate') candidateUseful += Number(label.useful); else baselineUseful += Number(label.useful);
        }
      }
      used.set(day, slots);
    }
    if (expected.size !== review.messages.length) throw new Error('Unexpected labels outside the fixed cohort');
    const result = { pipelineVerified: 1, cohort: review.cohort, pipeline: PIPELINE, episodes: manifest.groups.length, threads: threads.length,
      urgent: threads.filter((t) => t.urgent).length, nonActionable: threads.filter((t) => !t.actionable).length, candidateUseful, baselineUseful, violations,
      candidateMiss: threads.filter((t) => t.urgent && !covered.candidate.has(threadKey(t))).length, baselineMiss: threads.filter((t) => t.urgent && !covered.baseline.has(threadKey(t))).length };
    const passed = candidateUseful > baselineUseful && result.candidateMiss <= result.baselineMiss && violations === 0;
    const id = fingerprint([review.cohort, RUBRIC, review, result]).slice(0, 24);
    this.store.learning.recordEvaluation(id, policy, RUBRIC, manifest.groups.map(g => g.episode), result, passed, now);
    return { id, passed, result };
  }
}
