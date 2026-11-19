// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { passesFilter } from '../filter.js';
import { inputFilterSchema, type PointerCheck } from '../types.js';

const event = {
  type: 'incident.opened',
  data: { severity: 2, tags: ['mobile', 'payments'], owner: null, 'a/b': 'slash', 'm~n': 'tilde' },
};

describe('passesFilter', () => {
  it('passes every event when the filter is empty', () => {
    expect(passesFilter([], event)).toBe(true);
  });

  it.each<[string, PointerCheck, boolean]>([
    ['an equal string', { pointer: '/type', op: 'equals', value: 'incident.opened' }, true],
    ['a different string', { pointer: '/type', op: 'equals', value: 'incident.closed' }, false],
    ['a number by value, not text', { pointer: '/data/severity', op: 'equals', value: '2' }, false],
    ['membership', { pointer: '/data/severity', op: 'in', values: [1, 2] }, true],
    ['non-membership', { pointer: '/data/severity', op: 'in', values: [3] }, false],
    ['an array element', { pointer: '/data/tags/1', op: 'equals', value: 'payments' }, true],
    ['an index past the end', { pointer: '/data/tags/2', op: 'present' }, false],
    ['a non-canonical index', { pointer: '/data/tags/01', op: 'present' }, false],
    ['a present null', { pointer: '/data/owner', op: 'present' }, true],
    ['null by equality', { pointer: '/data/owner', op: 'equals', value: null }, true],
    ['a missing key', { pointer: '/data/missing', op: 'present' }, false],
    ['a path through a scalar', { pointer: '/type/length', op: 'present' }, false],
    ['an inherited property', { pointer: '/data/constructor', op: 'present' }, false],
    ['an escaped slash', { pointer: '/data/a~1b', op: 'equals', value: 'slash' }, true],
    ['an escaped tilde', { pointer: '/data/m~0n', op: 'equals', value: 'tilde' }, true],
    ['the whole document', { pointer: '', op: 'present' }, true],
  ])('checks %s', (_name, check, expected) => {
    expect(passesFilter([check], event)).toBe(expected);
  });

  it('requires every check to pass', () => {
    const type: PointerCheck = { pointer: '/type', op: 'equals', value: 'incident.opened' };
    const severe: PointerCheck = { pointer: '/data/severity', op: 'in', values: [1] };
    expect(passesFilter([type], event)).toBe(true);
    expect(passesFilter([type, severe], event)).toBe(false);
  });
});

describe('inputFilterSchema', () => {
  it.each([
    ['a pointer without a leading slash', [{ pointer: 'type', op: 'present' }]],
    ['an unknown operator', [{ pointer: '/type', op: 'matches', value: '.*' }]],
    ['a structured comparison value', [{ pointer: '/data', op: 'equals', value: { a: 1 } }]],
    ['an empty membership list', [{ pointer: '/type', op: 'in', values: [] }]],
    ['an integer too large to compare exactly', [{ pointer: '/id', op: 'equals', value: 2 ** 53 }]],
    [
      'more than sixteen checks',
      Array.from({ length: 17 }, () => ({ pointer: '', op: 'present' })),
    ],
  ])('rejects %s', (_name, filter) => {
    expect(inputFilterSchema.safeParse(filter).success).toBe(false);
  });
});
