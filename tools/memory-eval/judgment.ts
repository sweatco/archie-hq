import type { Case, History } from './schema.js';
import { permittedEvidence } from './schema.js';

export type ToolTrace = { name: string; input: unknown; output: string };
export type ReaderExecution = { accessMode: 'none' | 'candidate' | 'oracle'; visibleMemoryContext: string;
  memoryToolsAvailable: boolean; maxMemoryCalls: number; maxToolTurns: number; maxModelTurns: number;
  actualMemoryCalls: number; actualToolTurns: number; actualModelTurns: number; toolTrace: ToolTrace[] };
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

export function readerExecution(arm: 'no_memory' | 'candidate' | 'oracle', result: {
  injection?: string; memoryToolsAvailable?: boolean; toolCalls?: number; toolTrace?: ToolTrace[]; toolTurns?: number; modelTurns?: number;
}, oracleEvidence = ''): ReaderExecution {
  const memoryToolsAvailable = arm === 'candidate' && (result.memoryToolsAvailable ?? true);
  return { accessMode: arm === 'no_memory' ? 'none' : arm, visibleMemoryContext: arm === 'candidate' ? result.injection ?? ''
    : arm === 'oracle' ? result.injection ?? `Permitted source evidence:\n${oracleEvidence || '(none)'}` : '', memoryToolsAvailable,
  maxMemoryCalls: memoryToolsAvailable ? 3 : 0, maxToolTurns: memoryToolsAvailable ? 3 : 0,
  maxModelTurns: arm === 'candidate' ? 4 : 1, actualMemoryCalls: result.toolCalls ?? 0,
  actualToolTurns: result.toolTurns ?? 0, actualModelTurns: result.modelTurns ?? 0,
  toolTrace: result.toolTrace ?? [] };
}

export function executionClaimChecks(answer: string, execution: ReaderExecution) {
  const limitClaims = [...answer.matchAll(/\b(?:I|we)\s+(?:hit|reached)\s+(?:my|our|the)\s+(?:search|memory|tool)\s+(?:call\s+)?limit\b/gi)];
  return limitClaims.map((match) => ({ claim: match[0], limitReached: execution.memoryToolsAvailable
    && execution.maxMemoryCalls > 0 && execution.actualMemoryCalls >= execution.maxMemoryCalls }));
}

export function oracleFor(c: Case, history: History): string {
  return permittedEvidence(c, history).map((event) => JSON.stringify({
    at: event.at, role: event.role, taskId: event.taskId, authorId: event.authorId,
    authorName: event.authorName, messageTs: event.messageTs, source: event.source.ref,
    audience: event.audience ?? { kind: history.scope.kind, channelId: history.scope.channelId, userId: history.scope.userId },
    text: event.text,
  })).join('\n') || '(no supporting evidence)';
}

export function judgePayload(c: Case, answer: string, originalEvidence: string, execution: ReaderExecution) {
  return {
    currentTask: { context: c.currentContext, question: c.question, queryAt: c.queryAt,
      requester: c.requester, declaredAudience: c.audience },
    requiredClaims: c.required, forbiddenClaims: c.forbidden,
    evidenceCompleteness: 'all authorized original events before the question time', originalEvidence,
    readerExecution: execution, processClaimChecks: processClaimChecks(answer, execution.toolTrace),
    executionClaimChecks: executionClaimChecks(answer, execution), answer,
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
