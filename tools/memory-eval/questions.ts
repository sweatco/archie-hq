/**
 * memory:eval — question sets (functional tier).
 *
 * A question set is a versioned JSON file of {question, gold, evidenceEntities,
 * sourceTranscriptRef} records — from the benchmark adapter or synthesized from
 * prod transcripts. Prod-derived sets stay OFF-REPO (they embed task titles and
 * user references); the repo ships only this loader, the harvester, and the
 * runner. The trust anchor of a synthesized set is its human-validated label
 * sample, not the generating model.
 */

import { readFile } from 'fs/promises';
import type { QuestionRecord, QuestionSet } from './types.js';

export function validateQuestionSet(raw: unknown): { set: QuestionSet | null; errors: string[] } {
  const errors: string[] = [];
  const d = raw as any;
  if (!d || typeof d !== 'object') return { set: null, errors: ['not an object'] };
  if (d.v !== 1) errors.push(`unsupported version ${JSON.stringify(d.v)} (expected 1)`);
  if (typeof d.name !== 'string' || !d.name) errors.push('missing name');
  if (!Array.isArray(d.questions) || d.questions.length === 0) errors.push('missing/empty questions[]');

  const questions: QuestionRecord[] = [];
  for (const [i, q] of (Array.isArray(d.questions) ? d.questions : []).entries()) {
    const qe: string[] = [];
    if (typeof q?.id !== 'string' || !q.id) qe.push('id');
    if (typeof q?.question !== 'string' || !q.question.trim()) qe.push('question');
    if (typeof q?.gold !== 'string' || !q.gold.trim()) qe.push('gold');
    if (!Array.isArray(q?.evidenceEntities) || q.evidenceEntities.some((e: unknown) => typeof e !== 'string')) {
      qe.push('evidenceEntities');
    }
    if (qe.length) errors.push(`question[${i}]: invalid/missing ${qe.join(', ')}`);
    else questions.push({ v: 1, id: q.id, question: q.question, gold: q.gold, evidenceEntities: q.evidenceEntities, sourceTranscriptRef: q.sourceTranscriptRef });
  }

  if (errors.length) return { set: null, errors };
  return {
    set: { v: 1, name: d.name, created_at: d.created_at ?? '', snapshot_date: d.snapshot_date, questions },
    errors: [],
  };
}

export async function loadQuestionSet(path: string): Promise<QuestionSet> {
  const raw = JSON.parse(await readFile(path, 'utf-8'));
  const { set, errors } = validateQuestionSet(raw);
  if (!set) throw new Error(`invalid question set ${path}:\n  - ${errors.join('\n  - ')}`);
  return set;
}
