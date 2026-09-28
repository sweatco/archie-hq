import { describe, expect, it } from 'vitest';
import { syntheticCorpus } from './corpus.js';
import { answerSuccess, executionClaimChecks, judgePayload, oracleFor, processClaimChecks, readerExecution, retryableJudgeError } from './judgment.js';

const corpus = syntheticCorpus();
const find = (id: string) => {
  const c = corpus.cases.find((item) => item.id === id)!;
  const history = corpus.histories.find((item) => item.id === c.historyId)!;
  return { c, history };
};

describe('memory evaluation judgment evidence', () => {
  it('treats the release-note task as current evidence and scores the supported date', () => {
    const { c } = find('synthetic-decision-correction-1-future');
    const payload = judgePayload(c, 'The release note should say October 19.', 'The approved launch date is October 19.', readerExecution('no_memory', {}));
    expect(payload.currentTask.context).toContain('release note');
    expect(payload.currentTask.queryAt).toBe(c.queryAt);
    expect(answerSuccess(c, { status: 'advisory', requiredMet: [true], forbiddenAsserted: [false],
      unsupportedClaims: [], contradictedClaims: [], unverifiableClaims: [] })).toBe(true);
  });

  it('retains exact attribution in oracle evidence without unrelated author lists', () => {
    const { c, history } = find('synthetic-attribution-1-future');
    const rows = oracleFor(c, history).split('\n').map((row) => JSON.parse(row));
    expect(rows[0]).toMatchObject({ role: 'user', authorId: 'UMIRAUSER01', authorName: 'Mira', messageTs: history.events[0].messageTs });
    expect(rows[1]).toMatchObject({ role: 'user', authorId: 'UTESTUSER02', authorName: 'Colleague' });
    expect(rows[0].audience).not.toHaveProperty('authorIds');
  });

  it('exposes actual tool calls as process evidence without promoting results to source truth', () => {
    const { c } = find('synthetic-scope-3-future');
    const trace = [{ name: 'search_memory', input: { query: 'renewal quote ceiling' }, output: 'No authorized result' }];
    const answer = 'A search for "renewal quote ceiling" found one result.';
    const payload = judgePayload(c, answer, '(no authorized original evidence)', readerExecution('candidate', { toolTrace: trace, toolCalls: 1 }));
    expect(payload.readerExecution.toolTrace).toEqual(trace);
    expect(payload.originalEvidence).toBe('(no authorized original evidence)');
    expect(payload.processClaimChecks).toMatchObject([{ toolCallVerified: true, returnedText: 'No authorized result' }]);
    expect(processClaimChecks(answer, [])).toMatchObject([{ toolCallVerified: false, returnedText: null }]);
    expect(judgePayload(c, answer, '(no evidence)', readerExecution('no_memory', {})).readerExecution.toolTrace).toEqual([]);
  });

  it('distinguishes a reached call cap from a fabricated limit', () => {
    const answer = 'I hit my search limit.';
    expect(executionClaimChecks(answer, readerExecution('candidate', { toolCalls: 3 }))).toMatchObject([{ limitReached: true }]);
    expect(executionClaimChecks(answer, readerExecution('candidate', { toolCalls: 1 }))).toMatchObject([{ limitReached: false }]);
    expect(executionClaimChecks(answer, readerExecution('no_memory', {}))).toMatchObject([{ limitReached: false }]);
  });

  it('keeps reader-visible context separate from objective original evidence', () => {
    const { c } = find('synthetic-scope-3-future');
    const payload = judgePayload(c, 'I was not given that information.', 'The renewal ceiling is 12%.', readerExecution('no_memory', {}));
    expect(payload.originalEvidence).toContain('12%');
    expect(payload.readerExecution.visibleMemoryContext).toBe('');
  });

  it('retries only schema or truncated judge results', () => {
    expect(retryableJudgeError(new Error('worker failed: invalid judge response'))).toBe(true);
    expect(retryableJudgeError(new Error('incomplete judge response: max_tokens'))).toBe(true);
    expect(retryableJudgeError(new Error('budget stop: no capacity'))).toBe(false);
  });
});
