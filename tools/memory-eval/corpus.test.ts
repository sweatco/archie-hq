import { describe, expect, it } from 'vitest';
import { parseKnowledgeLog, syntheticCorpus } from './corpus.js';
import { checkpointKey, permittedEvidence, validateCorpus, visibleAt } from './schema.js';

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

  it('rejects a private audience crossing channels', () => {
    const part = syntheticCorpus();
    const c = structuredClone(part.cases.find((x) => x.family === 'synthetic-scope')!);
    c.audience = { kind: 'private_channel', channelId: 'GOTHERCHAN01' };
    expect(validateCorpus({ version: 1, histories: part.histories, cases: [c], provenance: {} })).toContain(`${c.id}: private audience differs from history scope`);
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
