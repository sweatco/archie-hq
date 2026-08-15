/**
 * memory:eval — benchmark adapter (portable regression anchor).
 *
 * Converts a LongMemEval-style file (questions with haystack sessions and
 * evidence-session labels) into (a) a throwaway Markdown store — each session
 * becomes an entity page via a DETERMINISTIC transform, no LLM — and (b) a
 * question set whose evidenceEntities are the transformed evidence sessions.
 *
 * This smoke-tests the harness wiring (selection → render → arms) before any
 * prod data exists, and anchors regressions on a stable public set. A small
 * vendored fixture ships in fixtures/; point --benchmark at a real
 * LongMemEval JSON for the full anchor.
 *
 * Expected input schema (LongMemEval): an array of
 *   { question_id, question, answer, haystack_session_ids, haystack_sessions:
 *     [ [ {role, content}, ... ] ], answer_session_ids }
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { QuestionSet } from './types.js';

interface BenchmarkQuestion {
  question_id: string;
  question: string;
  answer: string;
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  answer_session_ids: string[];
}

/**
 * Deterministic session-id → entity-slug transform (valid slug, stable).
 * Punctuation-variant ids ("s_1" vs "s-1") collapse to one slug — acceptable
 * for the adapter (evidence labels use the same transform), but don't feed it
 * benchmarks whose session ids differ only by punctuation.
 */
export function sessionSlug(sessionId: string): string {
  const cleaned = sessionId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);
  return `session-${cleaned || 'x'}`;
}

function singleLine(s: string, max = 400): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Render one session as an entity page (deterministic, sanitizer-shaped). */
export function sessionToEntityMarkdown(sessionId: string, turns: Array<{ role: string; content: string }>): string {
  const slug = sessionSlug(sessionId);
  const firstUser = turns.find((t) => t.role === 'user')?.content ?? turns[0]?.content ?? '';
  const facts = turns.slice(0, 30).map((t) => `- [fact] ${t.role}: ${singleLine(t.content)}`);
  return [
    '---',
    `entity: ${slug}`,
    'type: concept',
    `display_name: "${slug}"`,
    'aliases: []',
    'scope: org',
    'repos: []',
    'domain: engineering',
    'status: active',
    '---',
    `<!-- L0: ${singleLine(firstUser, 160)} -->`,
    '',
    '## Facts',
    ...facts,
    '',
    '## Relations',
    '',
  ].join('\n');
}

export interface BenchmarkIngestResult {
  storeDir: string;
  questionsPath: string;
  sessions: number;
  questions: number;
}

/**
 * Write the throwaway store (a full ARCHIE_WORKDIR shape: memory/entities/)
 * and the converted question set. Run the eval afterwards with
 * `ARCHIE_WORKDIR=<into> … --questions <into>/questions.json`.
 */
export async function ingestBenchmark(benchmarkPath: string, into: string): Promise<BenchmarkIngestResult> {
  const raw = JSON.parse(await readFile(benchmarkPath, 'utf-8')) as BenchmarkQuestion[];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`benchmark file ${benchmarkPath} is empty or not an array`);

  const entitiesDir = join(into, 'memory', 'entities');
  await mkdir(entitiesDir, { recursive: true });

  const written = new Set<string>();
  const questions: QuestionSet['questions'] = [];
  for (const q of raw) {
    const ids = q.haystack_session_ids ?? [];
    const sessions = q.haystack_sessions ?? [];
    for (let i = 0; i < ids.length; i++) {
      const slug = sessionSlug(ids[i]);
      if (written.has(slug)) continue;
      written.add(slug);
      await writeFile(join(entitiesDir, `${slug}.md`), sessionToEntityMarkdown(ids[i], sessions[i] ?? []), 'utf-8');
    }
    questions.push({
      v: 1,
      id: q.question_id,
      question: q.question,
      gold: q.answer,
      evidenceEntities: (q.answer_session_ids ?? []).map(sessionSlug),
      sourceTranscriptRef: `benchmark:${q.question_id}`,
    });
  }

  const set: QuestionSet = {
    v: 1,
    name: `benchmark:${benchmarkPath.split('/').pop()}`,
    created_at: new Date().toISOString(),
    questions,
  };
  const questionsPath = join(into, 'questions.json');
  await writeFile(questionsPath, JSON.stringify(set, null, 2), 'utf-8');
  return { storeDir: into, questionsPath, sessions: written.size, questions: questions.length };
}
