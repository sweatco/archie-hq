// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { Cassette } from './cassette.js';
const recorded = { name: 'mcp__fixture__update', input: { page: 'fixture', data: { a: 1, b: 2 } }, output: { content: [{ type: 'text' as const, text: 'RECORDED_ONLY' }], isError: true } };
const turn = { at: '2026-10-20T10:00:00Z', sender: 'user', message: 'first', tools: [recorded] };
it('releases only current-turn results, preserves errors and requires complete consumption', () => {
  const cassette = new Cassette([turn, { ...turn, message: 'future', tools: [{ ...recorded, output: { content: [{ type: 'text', text: 'FUTURE_FACT' }], isError: false } }] }]);
  expect(cassette.next()).toEqual({ at: turn.at, sender: 'user', message: 'first' });
  expect(cassette.call(recorded.name, { data: { b: 2, a: 1 }, page: 'fixture' })).toEqual(recorded.output);
  expect(JSON.stringify(cassette.call(recorded.name, recorded.input))).not.toContain('FUTURE_FACT');
  expect(cassette.next()).toBeNull();
  expect(cassette.summary()).toMatchObject({ consumed: 1, complete: false, errors: ['missing-recording'] });
  const complete = new Cassette([turn]); complete.next(); complete.call(recorded.name, recorded.input); expect(complete.next()).toBeNull();
  expect(complete.summary()).toEqual({ expected: 1, consumed: 1, complete: true, errors: [] });
  const missing = new Cassette([turn]); missing.next(); expect(missing.next()).toBeNull(); expect(missing.summary().errors).toEqual(['unconsumed-recordings']);
});
it('rejects order/argument divergence with no unrelated output or fallback', () => {
  for (const [name, args, error] of [[recorded.name, {}, 'tool-arguments-divergence'], ['mcp__other__update', recorded.input, 'tool-order-divergence']] as const) {
    const cassette = new Cassette([turn]); cassette.next();
    expect(JSON.stringify(cassette.call(name, args))).not.toContain('RECORDED_ONLY');
    expect(cassette.summary()).toMatchObject({ consumed: 0, complete: false, errors: [error] });
  }
});
