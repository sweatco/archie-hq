import { createHash } from 'node:crypto';

export type Source = 'archie' | 'synthetic' | 'longmemeval';
export type Review = 'draft' | 'calibrated' | 'approved' | 'quarantined';
export type Span = { ref: string; start: number; end: number; quote: string };
export type Audience = { kind: 'public' | 'private_channel' | 'user' | 'none'; channelId: string; userId?: string;
  authorization?: 'verified' | 'unknown' | 'revoked' | 'external' };
export type Event = { at: string; role: 'user' | 'assistant' | 'system'; text: string; source: Span; taskId?: string; authorId?: string; authorName?: string; messageTs?: string;
  audience?: Audience };
export type History = {
  id: string;
  family: string;
  source: Source;
  workload: string;
  scope: Audience & { authorIds: string[] };
  events: Event[];
  completions: Array<{ at: string; taskId: string; audience?: Audience }>;
  retentionCheck?: { entitySlug: string; observationNeedle: string; canonicalNeedle: string; initialTaskId: string };
};
export type Case = {
  id: string;
  family: string;
  source: Source;
  workload: string;
  ability: string;
  scenarioGroup?: string;
  taskKind?: 'recall' | 'future_task';
  split: 'dev' | 'holdout';
  historyId: string;
  queryAt: string;
  requester: string;
  audience: Audience;
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

export function authorizedVisibleEvents(c: Case, history: History): Event[] {
  if (c.audience.kind === 'user' && c.audience.userId !== c.requester) return [];
  return visibleAt(history, c.queryAt).filter((event) => {
    const sourceAudience = event.audience ?? history.scope;
    if (sourceAudience.kind === 'none' || sourceAudience.authorization && sourceAudience.authorization !== 'verified'
      || c.audience.kind === 'none' || c.audience.authorization && c.audience.authorization !== 'verified') return false;
    if (sourceAudience.kind === 'public') return true;
    return c.audience.kind === sourceAudience.kind && c.audience.channelId === sourceAudience.channelId
      && (sourceAudience.kind !== 'user' || sourceAudience.userId === c.requester && c.audience.userId === c.requester);
  });
}

export function completionAudience(history: History, completion: History['completions'][number]): Audience | null {
  const first = history.events.find((event) => event.taskId === completion.taskId && event.at <= completion.at);
  return completion.audience ?? first?.audience ?? history.scope ?? null;
}

export function authorizedIngestionAudience(history: History, completion: History['completions'][number]): Audience | null {
  const audience = completionAudience(history, completion);
  if (!audience || audience.kind === 'none' || audience.authorization && audience.authorization !== 'verified') return null;
  if (history.source === 'archie' && audience.authorization !== 'verified') return null;
  if (audience.kind === 'user' && !audience.userId) return null;
  const events = history.events.filter((event) => event.taskId === completion.taskId && event.at <= completion.at);
  if (!events.length || events.some((event) => {
    const source = event.audience ?? history.scope;
    return source.kind !== audience.kind || source.channelId !== audience.channelId || source.userId !== audience.userId
      || source.authorization && source.authorization !== 'verified'
      || history.source === 'archie' && source.authorization !== 'verified';
  })) return null;
  return audience;
}

export function permittedEvidence(c: Case, history: History): Event[] {
  const authorized = authorizedVisibleEvents(c, history);
  return c.evidence.map((span) => authorized.find((event) => event.source.ref === span.ref && event.source.start === span.start && event.source.end === span.end))
    .filter((event): event is Event => !!event);
}

export function validateCorpus(corpus: Corpus): string[] {
  const errors: string[] = [];
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const ids = new Set<string>();
  const signatures = new Map<string, { historyId: string; group: string }>();
  for (const history of corpus.histories.filter((item) => item.source === 'synthetic')) {
    const signature = digest(JSON.stringify(history.events.map((event) => [event.role, event.text])));
    const group = corpus.cases.find((c) => c.historyId === history.id)?.scenarioGroup ?? history.family;
    const prior = signatures.get(signature);
    if (prior && prior.group !== group) errors.push(`${history.id}: duplicates ${prior.historyId} across scenario groups`);
    else signatures.set(signature, { historyId: history.id, group });
  }
  for (const c of corpus.cases) {
    if (ids.has(c.id)) errors.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    const h = histories.get(c.historyId);
    if (!h) { errors.push(`${c.id}: missing history`); continue; }
    if (h.family !== c.family || h.source !== c.source) errors.push(`${c.id}: family/source mismatch`);
    if (c.split !== splitForFamily(c.scenarioGroup ?? c.family)) errors.push(`${c.id}: split differs from scenario group`);
    if (!Number.isFinite(Date.parse(c.queryAt))) errors.push(`${c.id}: invalid query time`);
    if (c.source === 'archie' && c.review !== 'quarantined' && visibleAt(h, c.queryAt).some((event) => !event.audience || event.audience.authorization !== 'verified')) {
      errors.push(`${c.id}: real-history authorization is unverified`);
    }
    if (c.review !== 'quarantined') for (const completion of h.completions.filter((item) => item.at <= c.queryAt)) {
      if (!authorizedIngestionAudience(h, completion)) errors.push(`${c.id}: completion authorization is unverified or denied at ${completion.at}`);
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
