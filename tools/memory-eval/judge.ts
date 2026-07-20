/**
 * memory:eval — rubric judge + governance (functional tier).
 *
 * Governance (from the LLM-as-judge literature; see the change design D9):
 * - The judge gates nothing until validated: chance-corrected agreement
 *   (Cohen's κ — raw agreement overstates it by 30-40pp) against a
 *   human-labeled sample, and position bias below 0.10 (high test-retest
 *   stability does NOT imply low bias).
 * - The judge must be a DIFFERENT model family than the extraction side-agent
 *   (same-family writer/judge preference leakage is ~28.7% and undetectable
 *   by inspection). With only one provider configured, results still compute
 *   but are marked non-gating.
 * - The report header stamps reader model, judge model, and the validation.
 */

import type { JudgeStamp, JudgeValidation, LlmCall } from './types.js';

/** The extraction side-agent runs on Claude (extractor.ts, model: 'sonnet'). */
export const EXTRACTOR_FAMILY = 'claude';
export const POSITION_BIAS_MAX = 0.1;
/** κ floor for a gating judge — below "substantial agreement" the judge's verdicts can't gate changes. */
export const KAPPA_MIN = 0.6;

/** Model family from a model id: claude-*, gpt-*, gemini-*, qwen*, llama*, … */
export function modelFamily(modelId: string): string {
  const m = modelId.toLowerCase();
  for (const fam of ['claude', 'gpt', 'o1', 'o3', 'gemini', 'qwen', 'llama', 'mistral', 'deepseek', 'sonnet', 'opus', 'haiku']) {
    if (m.startsWith(fam) || m.includes(`/${fam}`)) {
      // Anthropic aliases (sonnet/opus/haiku) are all the claude family.
      return ['sonnet', 'opus', 'haiku'].includes(fam) ? 'claude' : fam;
    }
  }
  return m.split(/[-_/]/)[0] || 'unknown';
}

export function buildJudgeStamp(
  readerModel: string,
  judgeModel: string,
  validation: JudgeValidation | null,
): JudgeStamp {
  const judgeFamily = modelFamily(judgeModel);
  const nonGatingReasons: string[] = [];
  if (!validation) nonGatingReasons.push('judge not validated (no κ / position-bias stamp)');
  else {
    if (validation.positionBias >= POSITION_BIAS_MAX) {
      nonGatingReasons.push(`position bias ${validation.positionBias} >= ${POSITION_BIAS_MAX}`);
    }
    if (validation.kappa < KAPPA_MIN) {
      nonGatingReasons.push(`Cohen's κ ${validation.kappa} < ${KAPPA_MIN} (below substantial agreement)`);
    }
  }
  if (judgeFamily === EXTRACTOR_FAMILY) {
    nonGatingReasons.push(`judge family "${judgeFamily}" matches the extractor family (preference-leakage risk)`);
  }
  return {
    readerModel,
    judgeModel,
    judgeFamily,
    extractorFamily: EXTRACTOR_FAMILY,
    validation,
    gating: nonGatingReasons.length === 0,
    nonGatingReasons,
  };
}

const JUDGE_SYSTEM = 'You are grading answers against a gold answer. Judge ONLY factual agreement with the gold answer; ignore style, length, and confidence. Output exactly one line: CORRECT or INCORRECT, then a short reason.';

function judgePrompt(question: string, gold: string, answer: string, swap = false): string {
  const a = swap ? gold : answer;
  const b = swap ? answer : gold;
  const aLabel = swap ? 'GOLD ANSWER' : 'CANDIDATE ANSWER';
  const bLabel = swap ? 'CANDIDATE ANSWER' : 'GOLD ANSWER';
  return `QUESTION:\n${question}\n\n${aLabel}:\n${a}\n\n${bLabel}:\n${b}\n\nIs the candidate answer factually consistent with the gold answer for this question? One line: CORRECT or INCORRECT, then a reason.`;
}

export function parseVerdict(text: string): boolean {
  return /^\s*CORRECT\b/i.test(text.trim());
}

/** Judge one answer. Returns the verdict + the judge's stated reason. */
export async function judgeAnswer(
  llm: LlmCall,
  judgeModel: string,
  question: string,
  gold: string,
  answer: string,
): Promise<{ correct: boolean; reason: string }> {
  const text = await llm({ model: judgeModel, system: JUDGE_SYSTEM, prompt: judgePrompt(question, gold, answer), maxTokens: 200 });
  return { correct: parseVerdict(text), reason: text.trim().split('\n')[0] ?? '' };
}

/** One human-labeled validation sample row. */
export interface ValidationSample {
  question: string;
  gold: string;
  answer: string;
  /** Human ground truth for "is `answer` correct given `gold`". */
  humanCorrect: boolean;
}

/** Cohen's κ for two binary raters. */
export function cohensKappa(a: boolean[], b: boolean[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  let agree = 0;
  let aYes = 0;
  let bYes = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) aYes++;
    if (b[i]) bYes++;
  }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + ((n - aYes) / n) * ((n - bYes) / n);
  if (pe === 1) return 1;
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
}

/**
 * Validate the judge against a human-labeled sample: Cohen's κ vs the human
 * labels, plus a position-swap flip rate (presenting gold/candidate in swapped
 * order must not change the verdict) standing in for pairwise position bias.
 */
export async function validateJudge(
  llm: LlmCall,
  judgeModel: string,
  samples: ValidationSample[],
  now?: string,
): Promise<JudgeValidation> {
  const judgeVerdicts: boolean[] = [];
  const humanLabels: boolean[] = [];
  let flips = 0;
  for (const s of samples) {
    const v1 = parseVerdict(await llm({ model: judgeModel, system: JUDGE_SYSTEM, prompt: judgePrompt(s.question, s.gold, s.answer), maxTokens: 200 }));
    const v2 = parseVerdict(await llm({ model: judgeModel, system: JUDGE_SYSTEM, prompt: judgePrompt(s.question, s.gold, s.answer, true), maxTokens: 200 }));
    if (v1 !== v2) flips++;
    judgeVerdicts.push(v1);
    humanLabels.push(s.humanCorrect);
  }
  return {
    kappa: cohensKappa(judgeVerdicts, humanLabels),
    positionBias: samples.length ? Math.round((flips / samples.length) * 1000) / 1000 : 0,
    at: now ?? new Date().toISOString(),
    sampleSize: samples.length,
  };
}
