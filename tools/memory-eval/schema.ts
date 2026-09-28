import { createHash } from 'node:crypto';

export type Source = 'archie' | 'synthetic' | 'longmemeval';
export type Review = 'draft' | 'calibrated' | 'approved' | 'quarantined';
export type Span = { ref: string; start: number; end: number; quote: string };
export type Event = { at: string; role: 'user' | 'assistant' | 'system'; text: string; source: Span; taskId?: string; authorId?: string; authorName?: string; messageTs?: string;
  audience?: { kind: 'public' | 'private_channel' | 'user'; channelId: string } };
export type History = {
  id: string;
  family: string;
  source: Source;
  workload: string;
  scope: { kind: 'public' | 'private_channel' | 'user'; channelId: string; authorIds: string[] };
  events: Event[];
  completions: Array<{ at: string; taskId: string }>;
};
export type Case = {
  id: string;
  family: string;
  source: Source;
  workload: string;
  ability: string;
  split: 'dev' | 'holdout';
  historyId: string;
  queryAt: string;
  requester: string;
  audience: { kind: 'public' | 'private_channel' | 'user'; channelId: string };
  currentContext: string;
  question: string;
  required: string[];
  forbidden: string[];
  evidence: Span[];
  review: Review;
  reason?: string;
};
export type Corpus = { version: 1; histories: History[]; cases: Case[]; provenance: Record<string, unknown> };

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function splitForFamily(family: string): 'dev' | 'holdout' {
  return parseInt(digest(family).slice(0, 2), 16) < 192 ? 'dev' : 'holdout';
}

export function visibleAt(history: History, at: string): Event[] {
  return history.events.filter((event) => event.at <= at);
}

export function checkpointKey(history: History, cutoff: string, configHash: string, model: string, pricing: unknown): string {
  return digest(JSON.stringify({
    history: { ...history, events: visibleAt(history, cutoff), completions: history.completions.filter((c) => c.at <= cutoff) },
    cutoff, configHash, model, pricing,
  }));
}

export function permittedEvidence(c: Case, history: History): Event[] {
  const visible = visibleAt(history, c.queryAt);
  return c.evidence.map((span) => visible.find((e) => e.source.ref === span.ref && e.source.start === span.start && e.source.end === span.end))
    .filter((event): event is Event => {
      if (!event) return false;
      const sourceAudience = event.audience ?? history.scope;
      return sourceAudience.kind === 'public' || c.audience.kind !== 'public'
        && c.audience.kind === sourceAudience.kind && c.audience.channelId === sourceAudience.channelId;
    });
}

export function validateCorpus(corpus: Corpus): string[] {
  const errors: string[] = [];
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    if (ids.has(c.id)) errors.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    const h = histories.get(c.historyId);
    if (!h) { errors.push(`${c.id}: missing history`); continue; }
    if (h.family !== c.family || h.source !== c.source) errors.push(`${c.id}: family/source mismatch`);
    if (c.split !== splitForFamily(c.family)) errors.push(`${c.id}: split differs from family`);
    if (!Number.isFinite(Date.parse(c.queryAt))) errors.push(`${c.id}: invalid query time`);
    if (c.audience.kind !== 'public' && c.audience.channelId !== h.scope.channelId) {
      errors.push(`${c.id}: private audience differs from history scope`);
    }
    const evidenceFree = c.id.endsWith('_abs') || (c.ability === 'scope' && c.required.some((claim) => /insufficient/i.test(claim)));
    if (c.review === 'approved' && (c.required.length === 0 && c.forbidden.length === 0 || c.evidence.length === 0 && !evidenceFree)) {
      errors.push(`${c.id}: approved case has no claims/evidence`);
    }
    if (c.review !== 'quarantined') for (const span of c.evidence) {
      const e = h.events.find((x) => x.source.ref === span.ref && x.source.start === span.start && x.source.end === span.end);
      if (!e || e.at > c.queryAt || !e.text.includes(span.quote)) errors.push(`${c.id}: invalid/future evidence ${span.ref}`);
      if (c.source === 'archie' && e?.role === 'assistant' && c.review === 'approved') errors.push(`${c.id}: assistant assertion used as approved gold`);
    }
  }
  return errors;
}
