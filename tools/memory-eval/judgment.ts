import type { Case, History } from './schema.js';
import { permittedEvidence } from './schema.js';

export type ToolTrace = { name: string; input: unknown; output: string };
export type Verdict = { status?: string; requiredMet?: boolean[]; forbiddenAsserted?: boolean[];
  unsupportedClaims?: string[]; contradictedClaims?: string[]; unverifiableClaims?: string[]; abstained?: boolean };

export function retryableJudgeError(error: unknown): boolean {
  return /invalid judge response|incomplete judge response/.test(String(error));
}

export function processClaimChecks(answer: string, toolTrace: ToolTrace[]) {
  const claims = [...answer.matchAll(/\b(?:a search for|searched for|searched)\s+["“]([^"”]+)["”]/gi)];
  return claims.map((match) => {
    const query = match[1].toLowerCase().trim();
    const matchingCall = toolTrace.find((trace) => trace.name === 'search_memory'
      && typeof trace.input === 'object' && trace.input !== null
      && String((trace.input as Record<string, unknown>).query ?? '').toLowerCase().trim() === query);
    return { claim: match[0], query, toolCallVerified: !!matchingCall, returnedText: matchingCall?.output ?? null };
  });
}

export function oracleFor(c: Case, history: History): string {
  return permittedEvidence(c, history).map((event) => JSON.stringify({
    at: event.at, role: event.role, taskId: event.taskId, authorId: event.authorId,
    authorName: event.authorName, messageTs: event.messageTs, source: event.source.ref,
    audience: event.audience ?? { kind: history.scope.kind, channelId: history.scope.channelId, userId: history.scope.userId },
    text: event.text,
  })).join('\n') || '(no supporting evidence)';
}

export function judgePayload(c: Case, answer: string, originalEvidence: string, toolTrace: ToolTrace[] = []) {
  return {
    currentTask: { context: c.currentContext, question: c.question, queryAt: c.queryAt,
      requester: c.requester, declaredAudience: c.audience },
    requiredClaims: c.required, forbiddenClaims: c.forbidden,
    evidenceCompleteness: 'all authorized original events before the question time', originalEvidence,
    executionEvidence: toolTrace.map(({ name, input, output }) => ({ name, input, output })),
    processClaimChecks: processClaimChecks(answer, toolTrace), answer,
  };
}

export function answerSuccess(c: Case, verdict?: Verdict): boolean | null {
  if (verdict?.status !== 'advisory' || !verdict.forbiddenAsserted || !verdict.unsupportedClaims
    || !verdict.contradictedClaims || !verdict.unverifiableClaims) return null;
  const explanationSupported = verdict.unsupportedClaims.length === 0 && verdict.contradictedClaims.length === 0
    && verdict.unverifiableClaims.length === 0;
  if (c.id.endsWith('_abs')) return verdict.abstained === true && !verdict.forbiddenAsserted.some(Boolean) && explanationSupported;
  if (!verdict.requiredMet?.length) return null;
  return verdict.requiredMet.every(Boolean) && !verdict.forbiddenAsserted.some(Boolean) && explanationSupported;
}
