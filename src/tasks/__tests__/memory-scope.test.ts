import { describe, expect, it } from 'vitest';
import { joinMemoryScope, type ClassifiedMemoryScope } from '../memory-scope.js';
import type { TaskMemoryScope } from '../../types/task.js';

const publicC = { kind: 'public', channel_id: 'C1' } as const;
const publicOther = { kind: 'public', channel_id: 'C2' } as const;
const privateC = { kind: 'channel', channel_id: 'C1' } as const;
const privateOther = { kind: 'channel', channel_id: 'C2' } as const;
const userU = { kind: 'user', user_id: 'U000001' } as const;
const userOther = { kind: 'user', user_id: 'U000002' } as const;

describe('joinMemoryScope', () => {
  it.each<[TaskMemoryScope | undefined, ClassifiedMemoryScope, TaskMemoryScope]>([
    [undefined, publicC, { kind: 'none' }],
    [{ kind: 'unclassified' }, publicC, publicC],
    [{ kind: 'unclassified' }, privateC, privateC],
    [{ kind: 'unclassified' }, userU, userU],
    [{ kind: 'unclassified' }, { kind: 'none' }, { kind: 'none' }],
    [{ kind: 'none' }, publicC, { kind: 'none' }],
    [publicC, { kind: 'none' }, { kind: 'none' }],
    [publicC, publicC, publicC],
    [publicC, publicOther, { kind: 'public', channel_id: null }],
    [{ kind: 'public', channel_id: null }, publicC, { kind: 'public', channel_id: null }],
    [publicC, privateC, privateC],
    [publicC, privateOther, { kind: 'none' }],
    [privateC, publicC, privateC],
    [privateC, publicOther, { kind: 'none' }],
    [privateC, privateC, privateC],
    [privateC, privateOther, { kind: 'none' }],
    [userU, userU, userU],
    [userU, userOther, { kind: 'none' }],
    [userU, publicC, { kind: 'none' }],
    [userU, privateC, { kind: 'none' }],
    [privateC, userU, { kind: 'none' }],
  ])('joins %j with %j to %j', (current, incoming, expected) => {
    expect(joinMemoryScope(current, incoming)).toEqual(expected);
  });

  it('never widens after collapsing to none', () => {
    const audiences: ClassifiedMemoryScope[] = [publicC, privateC, userU, { kind: 'none' }];
    for (const incoming of audiences) {
      expect(joinMemoryScope({ kind: 'none' }, incoming)).toEqual({ kind: 'none' });
    }
  });
});
