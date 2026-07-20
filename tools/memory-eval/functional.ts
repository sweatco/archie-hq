/**
 * memory:eval — functional tier: the real implementation under test.
 *
 * For each question, the surfaced context comes from the PRODUCTION code path
 * (`buildMemoryContext` → `selectEntities` + injection render), with the
 * question standing in for the spawn's task title — the same signal push
 * selection scores at spawn. Two scored units:
 *
 * 1. surfaced-context recall/precision vs the question's evidence-entity
 *    labels (no model call);
 * 2. answer correctness by a FIXED reader over question + surfaced context,
 *    judged by the (governed) rubric judge — three arms per question:
 *    no-memory (floor), memory (ours), Oracle (evidence-only = reader ceiling).
 *
 * Oracle − memory separates retrieval failure from reader failure; the
 * over-injection sweep re-scores the memory arm at tighter context budgets —
 * if trimming doesn't move correctness, those tokens were waste.
 */

import { buildMemoryContext, renderEntityBlock, estimateTokens } from '../../src/memory/context.js';
import type {
  ArmAnswer,
  ArmName,
  EntityRecord,
  FunctionalCaseResult,
  LlmCall,
  QuestionRecord,
} from './types.js';
import { judgeAnswer } from './judge.js';

const READER_SYSTEM =
  'Answer the question using ONLY the provided organizational memory context. If the context does not contain the answer, say "I don\'t know". Be direct and short.';

function readerPrompt(question: string, context: string): string {
  const ctx = context.trim() ? `MEMORY CONTEXT:\n${context}\n\n` : 'MEMORY CONTEXT: (none)\n\n';
  return `${ctx}QUESTION: ${question}`;
}

/** Slugs of the full pages present in a surfaced context (its <entity> blocks). */
export function surfacedSlugs(context: string): string[] {
  return [...context.matchAll(/<entity slug="([^"]+)"/g)].map((m) => m[1]);
}

export function recallPrecision(evidence: string[], surfaced: string[]): { recall: number; precision: number } {
  const ev = new Set(evidence);
  // One intersection serves both metrics — recall and precision must count
  // the same hits or a one-sided edit desynchronizes them.
  const inter = surfaced.filter((x) => ev.has(x)).length;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    recall: evidence.length ? round3(inter / evidence.length) : 1,
    // Empty surfaced + empty evidence = correct abstention: precision 1, the
    // same convention recall uses one line up. Only a non-empty surfaced set
    // with no evidence hits (or missed evidence) scores 0.
    precision: surfaced.length ? round3(inter / surfaced.length) : evidence.length === 0 ? 1 : 0,
  };
}

/** Production surfaced context for a question (index + selected pages + …). */
export async function buildSurfacedContext(question: string): Promise<string> {
  // No users, no taskId: nothing is written (the sensor gates on taskId), and
  // the question plays the task-title role — the spawn signal selection scores.
  return buildMemoryContext([], { taskTitle: question });
}

/** Oracle arm: evidence pages only, rendered by the production renderer. */
export function buildOracleContext(evidence: string[], records: EntityRecord[]): string {
  const bySlug = new Map(records.map((r) => [r.entity, r]));
  const blocks = evidence.map((slug) => bySlug.get(slug)).filter((r): r is EntityRecord => !!r).map(renderEntityBlock);
  return blocks.join('\n\n');
}

export interface FunctionalRunOptions {
  llm: LlmCall;
  readerModel: string;
  judgeModel: string;
  /** Skip reader/judge calls — surfaced-context scoring only. */
  contextOnly?: boolean;
  /** Override the production context builder (tests). */
  contextBuilder?: (question: string) => Promise<string>;
  /** Extra context budgets (fractions of the memory context) for the over-injection sweep. */
  budgetFractions?: number[];
}

export interface FunctionalRunResult {
  cases: FunctionalCaseResult[];
  summary: {
    questions: number;
    meanContextRecall: number;
    meanContextPrecision: number;
    armCorrect: Partial<Record<ArmName, number>>;
    /** budget fraction → correct count, for the over-injection sweep. */
    budgetSweep: Array<{ fraction: number; correct: number }>;
  };
}

async function scoreArm(
  opts: FunctionalRunOptions,
  arm: ArmName,
  q: QuestionRecord,
  context: string,
): Promise<ArmAnswer> {
  const answer = await opts.llm({
    model: opts.readerModel,
    system: READER_SYSTEM,
    prompt: readerPrompt(q.question, context),
    maxTokens: 400,
  });
  const verdict = await judgeAnswer(opts.llm, opts.judgeModel, q.question, q.gold, answer);
  return { arm, answer: answer.trim(), correct: verdict.correct, judgeReason: verdict.reason };
}

export async function runFunctional(
  questions: QuestionRecord[],
  records: EntityRecord[],
  opts: FunctionalRunOptions,
): Promise<FunctionalRunResult> {
  const buildCtx = opts.contextBuilder ?? buildSurfacedContext;
  const budgetFractions = opts.budgetFractions ?? [0.5, 0.25];
  const cases: FunctionalCaseResult[] = [];
  const armCorrect: Partial<Record<ArmName, number>> = {};
  const budgetCorrect = new Map<number, number>(budgetFractions.map((f) => [f, 0]));
  let recallSum = 0;
  let precisionSum = 0;

  for (const q of questions) {
    const memoryContext = await buildCtx(q.question);
    const surfaced = surfacedSlugs(memoryContext);
    const { recall, precision } = recallPrecision(q.evidenceEntities, surfaced);
    recallSum += recall;
    precisionSum += precision;

    const result: FunctionalCaseResult = {
      id: q.id,
      question: q.question,
      surfaced,
      contextRecall: recall,
      contextPrecision: precision,
      contextTokensEst: estimateTokens(memoryContext),
      arms: [],
    };

    if (!opts.contextOnly) {
      const oracleContext = buildOracleContext(q.evidenceEntities, records);
      const arms: Array<[ArmName, string]> = [
        ['no-memory', ''],
        ['memory', memoryContext],
        ['oracle', oracleContext],
      ];
      for (const [arm, ctx] of arms) {
        const scored = await scoreArm(opts, arm, q, ctx);
        result.arms.push(scored);
        if (scored.correct) armCorrect[arm] = (armCorrect[arm] ?? 0) + 1;
      }
      // Over-injection sweep: same reader/judge, memory context truncated to a
      // fraction of its chars (tail dropped — the lowest-ranked blocks render last).
      for (const fraction of budgetFractions) {
        const truncated = memoryContext.slice(0, Math.floor(memoryContext.length * fraction));
        const scored = await scoreArm(opts, 'memory', q, truncated);
        if (scored.correct) budgetCorrect.set(fraction, (budgetCorrect.get(fraction) ?? 0) + 1);
      }
    }

    cases.push(result);
  }

  return {
    cases,
    summary: {
      questions: questions.length,
      meanContextRecall: questions.length ? Math.round((recallSum / questions.length) * 1000) / 1000 : 0,
      meanContextPrecision: questions.length ? Math.round((precisionSum / questions.length) * 1000) / 1000 : 0,
      armCorrect,
      budgetSweep: budgetFractions.map((fraction) => ({ fraction, correct: budgetCorrect.get(fraction) ?? 0 })),
    },
  };
}
