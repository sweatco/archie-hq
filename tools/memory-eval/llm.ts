/**
 * memory:eval — production LLM caller (Anthropic Messages API).
 *
 * The reader/judge models are pinned per run and stamped in the report header.
 * Defaults: reader = Haiku (cheap, fixed); judge = configurable — note that a
 * Claude judge shares the extractor's model family, so its answer-correctness
 * numbers are marked NON-GATING until a cross-family judge is configured
 * (ARCHIE_MEMORY_EVAL_JUDGE_MODEL + an OpenAI-compatible endpoint, or a later
 * provider hookup). See judge.ts governance.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmCall } from './types.js';

export const DEFAULT_READER_MODEL = process.env.ARCHIE_MEMORY_EVAL_READER_MODEL || 'claude-haiku-4-5-20251001';
export const DEFAULT_JUDGE_MODEL = process.env.ARCHIE_MEMORY_EVAL_JUDGE_MODEL || 'claude-sonnet-5';

export function createAnthropicLlm(): LlmCall {
  const client = new Anthropic();
  // No temperature param: the Claude 5 family rejects it outright, the API
  // offers no seed so temp 0 never guaranteed determinism anyway, and the
  // eval gates arm-relatively (same reader both arms) with judge noise
  // separately governed by the κ/position-bias validation. Sampling defaults
  // are fine; the alternative was per-model error-sniffing.
  return async ({ model, system, prompt, maxTokens }) => {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens ?? 512,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  };
}
