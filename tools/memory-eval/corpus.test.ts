import { describe, expect, it } from 'vitest';
import { parseKnowledgeLog, syntheticCorpus } from './corpus.js';
import { checkpointKey, permittedEvidence, validateCorpus, visibleAt } from './schema.js';
import { classificationForCase } from './auth.js';
import { selectedCases } from './selection.js';

describe('memory evaluation corpus', () => {
  it('keeps multiline records intact', () => {
    const log = '[2026-01-01T00:00:00.000Z] [user] first\nsecond\n[2026-01-02T00:00:00.000Z] [assistant] reply\n';
    const records = parseKnowledgeLog(log);
    expect(records).toHaveLength(2);
    expect(records[0].text).toBe('first\nsecond');
    expect(log.slice(records[0].start, records[0].end)).toContain('second');
  });

  it('holds paired variants in one split and excludes future events', () => {
    const part = syntheticCorpus();
    const corpus = { version: 1 as const, ...part, provenance: {} };
    expect(validateCorpus(corpus)).toEqual([]);
    const family = part.cases.filter((c) => c.family === 'synthetic-updates');
    expect(new Set(family.map((c) => c.split)).size).toBe(1);
    const history = part.histories.find((h) => h.id === 'synthetic-updates-v1')!;
    expect(visibleAt(history, history.events[0].at).map((e) => e.text)).toEqual([history.events[0].text]);
  });

  it('rejects equivalent synthetic histories under different split identities', () => {
    const part = syntheticCorpus();
    const original = part.histories.find((h) => h.id === 'synthetic-updates-v1')!;
    const copy = structuredClone(original);
    copy.id = 'copied-history'; copy.family = 'copied-family';
    const c = structuredClone(part.cases.find((item) => item.historyId === original.id)!);
    c.id = 'copied-case'; c.historyId = copy.id; c.family = copy.family; c.scenarioGroup = copy.family;
    c.split = 'dev'; c.evidence = [];
    expect(validateCorpus({ version: 1, histories: [...part.histories, copy], cases: [...part.cases, c], provenance: {} })
      .some((error) => error.includes('duplicates') && error.includes('across scenario groups'))).toBe(true);
  });

  it('does not select quarantined cases even by explicit ID', () => {
    const part = syntheticCorpus();
    const c = part.cases.find((item) => item.id === 'synthetic-decision-correction-1-future')!;
    c.review = 'quarantined';
    expect(() => selectedCases({ version: 1, ...part, provenance: {} }, c.id)).toThrow('quarantined');
  });

  it('checks only completions before the query and rejects unknown real ingestion authorization', () => {
    const part = syntheticCorpus();
    const history = structuredClone(part.histories.find((h) => h.id === 'synthetic-decision-correction-v1')!);
    history.source = 'archie';
    history.events.forEach((event) => { event.audience = { kind: 'public', channelId: 'CTESTCHAN01', authorization: 'verified' }; });
    history.completions.forEach((completion) => { completion.audience = { kind: 'public', channelId: 'CTESTCHAN01', authorization: 'verified' }; });
    const c = structuredClone(part.cases.find((item) => item.historyId === history.id)!);
    c.source = 'archie'; c.review = 'approved'; c.queryAt = history.completions[0].at;
    c.evidence = [history.events[0].source];
    history.completions[1].audience = { kind: 'public', channelId: 'CTESTCHAN01', authorization: 'unknown' };
    expect(validateCorpus({ version: 1, histories: [history], cases: [c], provenance: {} })).toEqual([]);
    c.queryAt = history.completions[1].at;
    expect(validateCorpus({ version: 1, histories: [history], cases: [c], provenance: {} })
      .some((error) => error.includes('completion authorization'))).toBe(true);
  });

  it('rejects a verified public completion containing a private source event', () => {
    const part = syntheticCorpus();
    const h = structuredClone(part.histories.find((item) => item.id === 'synthetic-decision-correction-v1')!);
    h.events[0].audience = { kind: 'private_channel', channelId: 'GTESTCHAN01', authorization: 'verified' };
    h.completions[0].audience = { kind: 'public', channelId: 'CTESTCHAN01', authorization: 'verified' };
    const c = structuredClone(part.cases.find((item) => item.historyId === h.id)!);
    c.queryAt = h.completions[0].at;
    c.evidence = [];
    expect(validateCorpus({ version: 1, histories: [h], cases: [c], provenance: {} })
      .some((error) => error.includes('completion authorization'))).toBe(true);
  });

  it('rejects future evidence and assistant-only approved Archie gold', () => {
    const part = syntheticCorpus();
    const history = part.histories[0];
    const c = structuredClone(part.cases[0]);
    c.queryAt = history.events[0].at;
    c.evidence = [history.events[1].source];
    expect(validateCorpus({ version: 1, histories: [history], cases: [c], provenance: {} })).toContain(`${c.id}: invalid/future evidence ${c.evidence[0].ref}`);
    const archie = structuredClone(history);
    archie.source = 'archie';
    c.source = 'archie'; c.review = 'approved'; c.queryAt = history.events.at(-1)!.at;
    c.evidence = [history.events[2].source]; c.required = ['something'];
    expect(validateCorpus({ version: 1, histories: [archie], cases: [c], provenance: {} })).toContain(`${c.id}: assistant assertion used as approved gold`);
  });

  it('allows a cross-private denial case without authorizing its source', () => {
    const part = syntheticCorpus();
    const c = structuredClone(part.cases.find((x) => x.family === 'synthetic-scope')!);
    c.audience = { kind: 'private_channel', channelId: 'GOTHERCHAN01' };
    const history = part.histories.find((h) => h.id === c.historyId)!;
    expect(validateCorpus({ version: 1, histories: part.histories, cases: [c], provenance: {} })).toEqual([]);
    expect(permittedEvidence(c, history).some((event) => event.text.includes('40 units'))).toBe(false);
    const dm = part.cases.find((item) => item.id === 'synthetic-scope-6')!;
    expect(permittedEvidence(dm, part.histories.find((h) => h.id === dm.historyId)!)).toEqual([]);
    for (const id of ['synthetic-scope-7', 'synthetic-scope-8', 'synthetic-scope-9']) {
      const denied = part.cases.find((item) => item.id === id)!;
      expect(permittedEvidence(denied, part.histories.find((h) => h.id === denied.historyId)!)).toEqual([]);
      expect(classificationForCase(denied)).toEqual({ kind: 'none' });
    }
    expect(classificationForCase(dm)).toEqual({ kind: 'none' });
    expect(classificationForCase(part.cases.find((item) => item.id === 'synthetic-scope-5')!)).toEqual({ kind: 'user', user_id: 'UTESTUSER01' });
  });

  it('invalidates a checkpoint when history, cutoff, or ingestion configuration changes', () => {
    const history = syntheticCorpus().histories[0];
    const cutoff = history.events.at(-1)!.at;
    const key = checkpointKey(history, cutoff, 'config-a', 'claude-sonnet-5', { input: 2 });
    expect(checkpointKey(history, cutoff, 'config-b', 'claude-sonnet-5', { input: 2 })).not.toBe(key);
    expect(checkpointKey(history, history.events[0].at, 'config-a', 'claude-sonnet-5', { input: 2 })).not.toBe(key);
    const changed = structuredClone(history); changed.events[0].text += ' correction';
    expect(checkpointKey(changed, cutoff, 'config-a', 'claude-sonnet-5', { input: 2 })).not.toBe(key);
  });

  it('selects oracle evidence only before query time and inside the declared audience', () => {
    const part = syntheticCorpus();
    const history = part.histories.find((h) => h.id === 'synthetic-scope-v1')!;
    const c = structuredClone(part.cases.find((x) => x.id === 'synthetic-scope-1')!);
    expect(permittedEvidence(c, history)).toHaveLength(2);
    expect(history.events[0].text).toContain(c.audience.channelId);
    c.queryAt = history.events[0].at;
    expect(permittedEvidence(c, history)).toHaveLength(1);
    c.queryAt = history.events.at(-1)!.at;
    c.audience = { kind: 'public', channelId: 'CTESTCHAN01' };
    expect(permittedEvidence(c, history).map((e) => e.text)).toEqual(['Public notes mention renewal timing but no ceiling.']);
  });
});
