/**
 * memory:eval — prod-transcript question synthesis (functional tier).
 *
 * An LLM generates {question, gold, evidenceEntities} records from a pulled
 * snapshot's task summaries + the entity pages they touched; the store itself
 * supplies the distractors (every non-evidence page competes in selection).
 * The generator is NOT the trust anchor — the emitted human-validation
 * worklist is: label a sample, keep the labels, treat unvalidated questions
 * as smoke-signal only. Output stays OFF-REPO (embeds prod content).
 */

import type { EntityRecord, LlmCall, QuestionRecord, QuestionSet } from './types.js';

const SYNTH_SYSTEM =
  'You generate evaluation questions for an organizational memory system. Given entity pages (facts a memory store holds), produce questions a future task would plausibly need answered, whose answers are contained in the given pages. Output STRICT JSON only.';

function synthPrompt(pages: EntityRecord[]): string {
  const rendered = pages
    .map((p) => `SLUG: ${p.entity}\nSUMMARY: ${p.summary}\nFACTS:\n${p.observations.map((o) => `- ${o.text}`).join('\n')}`)
    .join('\n\n---\n\n');
  return [
    'Entity pages:',
    rendered,
    '',
    'Generate ONE question answerable from these pages. Respond with STRICT JSON:',
    '{"question": "...", "gold": "...", "evidenceEntities": ["slug", ...]}',
    'Rules: the question must be natural (what an engineer would ask), the gold answer short and factual, evidenceEntities must list ONLY the slugs above whose facts the answer needs.',
  ].join('\n');
}

/** Deterministic page grouping: consecutive windows over last-touched-sorted actives. */
export function pickEvidenceGroups(records: EntityRecord[], groups: number, groupSize = 2): EntityRecord[][] {
  const active = records.filter((r) => r.status !== 'archived' && r.observations.length > 0);
  const out: EntityRecord[][] = [];
  for (let i = 0; i + groupSize <= active.length && out.length < groups; i += groupSize) {
    out.push(active.slice(i, i + groupSize));
  }
  return out;
}

export interface SynthesisResult {
  set: QuestionSet;
  /** Human-validation worklist: sample to label before the set gates anything. */
  validationWorklist: string[];
  failures: number;
}

export async function synthesizeQuestions(
  records: EntityRecord[],
  llm: LlmCall,
  model: string,
  count: number,
  snapshotDate?: string,
): Promise<SynthesisResult> {
  const groups = pickEvidenceGroups(records, count);
  const questions: QuestionRecord[] = [];
  let failures = 0;
  const validSlugs = new Set(records.map((r) => r.entity));

  for (const [i, group] of groups.entries()) {
    try {
      const raw = await llm({ model, system: SYNTH_SYSTEM, prompt: synthPrompt(group), maxTokens: 600 });
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);
      const evidence = (Array.isArray(parsed.evidenceEntities) ? parsed.evidenceEntities : []).filter(
        (s: unknown): s is string => typeof s === 'string' && validSlugs.has(s),
      );
      if (typeof parsed.question !== 'string' || typeof parsed.gold !== 'string' || evidence.length === 0) {
        failures++;
        continue;
      }
      questions.push({
        v: 1,
        id: `prod-q${i + 1}`,
        question: parsed.question,
        gold: parsed.gold,
        evidenceEntities: evidence,
        sourceTranscriptRef: `synthesized:${group.map((g) => g.entity).join('+')}`,
      });
    } catch {
      failures++;
    }
  }

  return {
    set: {
      v: 1,
      name: 'prod-synthesized',
      created_at: new Date().toISOString(),
      snapshot_date: snapshotDate,
      questions,
    },
    validationWorklist: questions.map(
      (q) => `[ ] ${q.id}: verify question is natural, gold is correct, evidence ${q.evidenceEntities.join(',')} is right`,
    ),
    failures,
  };
}
