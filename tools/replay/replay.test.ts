// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtures, productionEpisodes, sessionEpisodes } from './corpus.js';
import { checks, type ReplayResult } from './types.js';
import { replay } from './adapter.js';
import { REPLAY_NATIVE_TOOLS, assertNoNativeTools } from './sdk-tools.js';

describe('replay invariants', () => {
  it('retains the whole session corpus unless a sample is explicit', () => {
    const capture = { schema: 'archie-session-capture/v1', seed: 'fixture', sessions: Array.from({ length: 101 }, (_, i) => ({
      id: `session-${i}`, createdAt: '2026-10-20T10:00:00Z', sourceHash: 'a'.repeat(64), originalWords: 1, catalog: [],
      turns: [{ at: '2026-10-20T10:00:00Z', sender: 'user', message: 'fixture', tools: [] }],
    })) };
    expect(sessionEpisodes(capture)).toHaveLength(101);
    expect(sessionEpisodes(capture, 5)).toHaveLength(5);
  });
  it('fails closed if the SDK reports native tools or omits its catalog', () => {
    expect(REPLAY_NATIVE_TOOLS).toEqual([]);
    expect(() => assertNoNativeTools(['mcp__probe__write_marker'])).not.toThrow();
    for (const catalog of [undefined, ['Bash'], ['Read', 'mcp__probe__write_marker']]) expect(() => assertNoNativeTools(catalog)).toThrow('no native tools');
  });
  it('rejects lost facts, forbidden evidence, wrong delivery and unknown execution independently', () => {
    const episode = fixtures()[0];
    const result: ReplayResult = { id: episode.id, mode: 'fresh-sdk', posts: ['Friday Morgan'], deliveries: [{ audience: 'cli', text: 'Friday Morgan' }], status: 'completed', errors: [], elapsedMs: 1, firstPostMs: 1, words: 2, usage: { sdkUsd: null, backgroundUsd: null, coverage: 'unknown' } };
    expect(Object.values(checks(episode, result)).every(Boolean)).toBe(true);
    expect(checks(episode, { ...result, posts: ['Friday'] })['required-facts']).toBe(false);
    expect(checks({ ...episode, expected: { required: [], forbidden: ['private'] } }, { ...result, posts: ['private'] }).access).toBe(false);
    expect(checks({ ...episode, expected: { required: [], forbidden: [], deliveries: 1, audience: 'D1' } }, { ...result, deliveries: [{ audience: 'C1', text: 'Friday' }] }).delivery).toBe(false);
    expect(checks(episode, { ...result, errors: ['missing recording'] }).execution).toBe(false);
  });

  it('requires a nonempty CLI response even when a transformation has no required identifiers', () => {
    const [episode] = productionEpisodes({ schema: 'archie-capture/v1', sanitizer: 'identifiers-v1', tasks: [{ id: 'plain-transformation', prompt: 'Rewrite: "This plain sentence is long enough to be a supported self-contained transformation."', sourceHash: 'a'.repeat(64), createdAt: '2026-10-20T10:00:00Z', originalWords: 4 }] });
    const result: ReplayResult = { id: episode.id, mode: 'fresh-sdk', posts: [], deliveries: [], status: 'completed', errors: [], elapsedMs: 1, firstPostMs: null, words: 0, usage: { sdkUsd: null, backgroundUsd: null, coverage: 'unknown' } };
    expect(checks(episode, result)).toEqual({ execution: true, 'required-facts': true, access: true, delivery: false });
    expect(checks(episode, { ...result, posts: [' '], deliveries: [{ audience: 'cli', text: ' ' }] }).delivery).toBe(false);
    expect(checks(episode, { ...result, posts: ['Rewritten.'], deliveries: [{ audience: 'C1', text: 'Rewritten.' }] }).delivery).toBe(false);
    expect(checks(episode, { ...result, posts: ['First.', 'Second.'], deliveries: [{ audience: 'cli', text: 'First.' }, { audience: 'cli', text: 'Second.' }] }).delivery).toBe(true);
  });

  it('separates captured requests from narrowly supported standalone replay inputs', () => {
    const task = { sourceHash: 'a'.repeat(64), createdAt: '2026-10-20T10:00:00Z', originalWords: 4 };
    const greeting = 'Арчи ты тут?\n  [Reactions: :eyes:]';
    const episodes = productionEpisodes({ schema: 'archie-capture/v1', sanitizer: 'identifiers-v1', tasks: [
      { ...task, id: 'presence', prompt: greeting }, { ...task, id: 'contextual', prompt: 'Have we stopped both trials? Ask ID_12345678.' },
    ] });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].input).toEqual({ kind: 'task', messages: [greeting] });
    expect(episodes[0].expected.required).toEqual([]);
  });

  it('requires the sanitized capture contract', () => {
    expect(() => productionEpisodes({ tasks: [] })).toThrow('Unsupported');
    expect(() => productionEpisodes({ schema: 'archie-capture/v1', sanitizer: 'identifiers-v1', tasks: [{ prompt: 'rewrite', sourceHash: 'missing' }] })).toThrow('invalid');
  });

  it('runs real component services serially in fresh processes and resets state', async () => {
    for (const episode of fixtures().filter((item) => item.input.kind !== 'task')) {
      const result = await replay(episode);
      expect(checks(episode, result), episode.id).toEqual({ execution: true, 'required-facts': true, access: true, delivery: true });
      expect(result.usage.sdkUsd).toBeNull();
    }
    const episode = fixtures().find((item) => item.id === 'attention-none')!;
    expect((await replay(episode)).deliveries).toHaveLength(1);
  }, 30_000);
});

it('permits unlabelled session silence but rejects missing turns and wrong delivery audience', () => {
  const input = { kind: 'session' as const, catalog: [], turns: ['first', 'later'].map((message) => ({ at: '2026-10-20T10:00:00Z', sender: 'user', message, tools: [] })) };
  const episode = { id: 'session', cohort: 'production' as const, input, expected: { required: [], forbidden: [] } };
  const result: ReplayResult = { id: 'session', mode: 'fresh-sdk', status: 'completed', errors: [], posts: ['reply'], deliveries: [{ audience: 'cli', text: 'reply' }], elapsedMs: 1, firstPostMs: 1, words: 1,
    usage: { sdkUsd: null, backgroundUsd: null, coverage: 'unknown' }, recordings: { expected: 0, consumed: 0, complete: true, errors: [] },
    turns: [{ posts: 1, deliveries: 1, words: 1, elapsedMs: 1 }, { posts: 0, deliveries: 0, words: 0, elapsedMs: 1 }] };
  expect(checks(episode, result)).toMatchObject({ execution: true, recordings: true, delivery: true });
  expect(checks(episode, { ...result, posts: [], deliveries: [] }).delivery).toBe(true);
  expect(checks(episode, { ...result, turns: result.turns!.slice(0, 1) }).delivery).toBe(false);
  expect(checks(episode, { ...result, deliveries: [{ audience: 'C1', text: 'reply' }] }).delivery).toBe(false);
});
