// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const SessionInput = z.object({
  kind: z.literal('session'),
  catalog: z.array(z.object({ name: z.string().regex(/^mcp__[^_]+(?:-[^_]+)*__[\w-]+$/), keys: z.array(z.string().min(1).max(100)) })),
  turns: z.array(z.object({ at: z.string(), sender: z.string(), message: z.string().min(1), tools: z.array(z.object({
    name: z.string(), input: z.record(z.string(), z.unknown()), output: z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })), isError: z.boolean() }),
  })) })).min(1).max(50),
});

export const EpisodeSchema = z.object({
  id: z.string().min(1), cohort: z.enum(['production', 'stress']),
  input: z.union([SessionInput, z.object({ kind: z.literal('task'), messages: z.array(z.string().min(1).max(6000)).min(1).max(5) }),
    z.object({ kind: z.enum(['attention', 'memory', 'task-memory']), mutation: z.enum(['none', 'duplicate', 'cancel', 'revoke', 'stale']) })]),
  expected: z.object({ required: z.array(z.string()), forbidden: z.array(z.string()), deliveries: z.number().int().nonnegative().optional(), audience: z.string().optional() }),
  provenance: z.object({ sourceHash: z.string(), createdAt: z.string(), originalWords: z.number() }).optional(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export interface ReplayResult {
  id: string;
  mode: 'fresh-sdk' | 'recorded-component';
  posts: string[];
  deliveries: { audience: string; text: string }[];
  status: string;
  errors: string[];
  elapsedMs: number;
  firstPostMs: number | null;
  words: number;
  usage: { sdkUsd: number | null; backgroundUsd: number | null; coverage: string; tokens?: unknown };
  diagnostics?: Awaited<ReturnType<typeof import('./diagnostics.js').runtimeDiagnostics>>;
  recordings?: { expected: number; consumed: number; complete: boolean; errors: string[] };
  turns?: { posts: number; deliveries: number; words: number; elapsedMs: number }[];
}

export function checks(episode: Episode, result: ReplayResult): Record<string, boolean> {
  const text = result.posts.join('\n').toLowerCase();
  return {
    execution: result.id === episode.id && result.status === 'completed' && result.errors.length === 0,
    'required-facts': episode.expected.required.every((fact) => text.includes(fact.toLowerCase())),
    access: episode.expected.forbidden.every((fact) => !text.includes(fact.toLowerCase())),
    delivery: (episode.input.kind !== 'task' || (result.posts.some((post) => post.trim())
      && result.deliveries.some((delivery) => delivery.text.trim())))
      && (!['task', 'session'].includes(episode.input.kind) || result.deliveries.every((delivery) => delivery.audience === 'cli'))
      && (episode.expected.deliveries === undefined || result.deliveries.length === episode.expected.deliveries)
      && result.deliveries.every((delivery) => !episode.expected.audience || delivery.audience === episode.expected.audience)
      && (episode.input.kind !== 'session' || result.turns?.length === episode.input.turns.length),
    ...(episode.input.kind === 'session' ? { recordings: result.recordings?.complete === true } : {}),
  };
}
