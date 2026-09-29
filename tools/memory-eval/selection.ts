import type { Case, Corpus } from './schema.js';

export function routineCases(corpus: Corpus): Case[] {
  const dev = corpus.cases.filter((c) => c.split === 'dev' && c.review !== 'quarantined');
  const selected: Case[] = [];
  const histories = new Map(corpus.histories.map((h) => [h.id, h]));
  const size = (c: Case) => histories.get(c.historyId)!.completions.filter((step) => step.at <= c.queryAt).length;
  const realFamilies = new Map<string, Case[]>();
  for (const c of dev.filter((item) => item.source === 'archie' && item.taskKind === 'future_task' && item.required.length > 0)) {
    realFamilies.set(c.family, [...(realFamilies.get(c.family) ?? []), c]);
  }
  selected.push(...[...realFamilies.values()].map((group) => group.sort((a, b) => size(a) - size(b))[0]).slice(0, 6));
  const syntheticIds = ['synthetic-decision-correction-1-future', 'synthetic-attribution-1-future', 'synthetic-scope-1-future',
    'synthetic-scope-3-future', 'synthetic-uncertainty-1-future', 'synthetic-irrelevance-4-future'];
  for (const id of syntheticIds) {
    const c = dev.find((item) => item.id === id);
    if (!c) throw new Error(`routine missing synthetic future-task case ${id}`);
    selected.push(c);
  }
  const publicCases = dev.filter((c) => c.source === 'longmemeval');
  for (const abstention of [false, true]) {
    const c = publicCases.filter((item) => item.id.endsWith('_abs') === abstention)
      .sort((a, b) => size(a) - size(b) || a.id.localeCompare(b.id))[0];
    if (!c) throw new Error(`routine missing public ${abstention ? 'abstention' : 'factual'} case`);
    selected.push(c);
  }
  return selected;
}

export function selectedCases(corpus: Corpus, caseId?: string): Case[] {
  if (!caseId) return routineCases(corpus);
  const c = corpus.cases.find((item) => item.id === caseId);
  if (!c) throw new Error(`case not found: ${caseId}`);
  if (c.review === 'quarantined') throw new Error(`case is quarantined: ${caseId}`);
  return [c];
}
