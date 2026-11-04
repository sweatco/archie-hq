// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { SessionInput, type Episode } from './types.js';
import { z } from 'zod';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function sessionEpisodes(value: unknown, maximum?: number): Episode[] {
  const capture = z.object({ schema: z.literal('archie-session-capture/v1'), seed: z.string(), sessions: z.array(z.object({
    id: z.string(), createdAt: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), originalWords: z.number(),
    catalog: SessionInput.shape.catalog, turns: SessionInput.shape.turns,
  })) }).parse(value);
  return [...capture.sessions].sort((a, b) => hash(capture.seed + a.id).localeCompare(hash(capture.seed + b.id))).slice(0, maximum ?? capture.sessions.length).map((session) => ({
    id: session.id, cohort: 'production', input: { kind: 'session', catalog: session.catalog, turns: session.turns },
    expected: { required: [], forbidden: [] }, provenance: { sourceHash: session.sourceHash, createdAt: session.createdAt, originalWords: session.originalWords },
  }));
}

export function productionEpisodes(value: unknown): Episode[] {
  const capture = z.object({ schema: z.literal('archie-capture/v1'), sanitizer: z.literal('identifiers-v1'), tasks: z.array(z.object({
    id: z.string(), prompt: z.string().max(6000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(), originalWords: z.number(),
  })) }).safeParse(value);
  if (!capture.success) throw new Error('Unsupported or invalid sanitized capture');
  return capture.data.tasks.filter((task) => {
    const text = task.prompt.replace(/\s*\[Reactions: [^\]\n]*\]\s*$/, '').trim();
    return /\b(rewrite|rephrase|translate|shorten|grammar|wording)\b/i.test(text) && /("[^"]{40,}"|```[\s\S]{40,}```)/.test(text)
      || /^(?:(?:archie|арчи)[,\s]+)?(?:are you (?:there|here)|ты (?:тут|здесь))[?!.,\s]*$/iu.test(text);
  }).map((task) => {
    return { id: task.id, cohort: 'production', input: { kind: 'task', messages: [task.prompt] },
      // Production coverage is execution/delivery only; no automatic factuality label or echo requirement.
      expected: { required: [], forbidden: [] },
      provenance: { sourceHash: task.sourceHash, createdAt: task.createdAt, originalWords: task.originalWords } };
  });
}

export function fixtures(): Episode[] {
  return [
    { id: 'response-facts', cohort: 'stress', input: { kind: 'task', messages: ['Rewrite concisely, preserving both facts: "The release is Friday. The owner is Morgan."'] },
      expected: { required: ['Friday', 'Morgan'], forbidden: [] } },
    ...(['none', 'duplicate', 'cancel', 'revoke'] as const).map((mutation): Episode => ({
      id: `attention-${mutation}`, cohort: 'stress', input: { kind: 'attention', mutation },
      expected: { required: mutation === 'none' || mutation === 'duplicate' ? ['checklist'] : [], forbidden: [], deliveries: mutation === 'none' || mutation === 'duplicate' ? 1 : 0, audience: 'D1' },
    })),
    ...(['none', 'stale', 'revoke'] as const).map((mutation): Episode => ({
      id: `memory-${mutation}`, cohort: 'stress', input: { kind: 'memory', mutation },
      expected: { required: mutation === 'revoke' ? [] : [mutation === 'stale' ? 'Monday' : 'Friday'], forbidden: mutation === 'stale' ? ['Friday'] : mutation === 'revoke' ? ['Friday'] : [], deliveries: 0 },
    })),
    ...(['none', 'stale', 'revoke'] as const).map((mutation): Episode => ({
      id: `task-memory-${mutation}`, cohort: 'stress', input: { kind: 'task-memory', mutation },
      expected: { required: mutation === 'revoke' ? [] : [mutation === 'stale' ? 'Monday' : 'Friday'], forbidden: mutation === 'stale' ? ['Friday'] : mutation === 'revoke' ? ['Friday'] : [], deliveries: 0 },
    })),
  ];
}
