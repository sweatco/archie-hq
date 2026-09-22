import { describe, expect, it } from 'vitest';
import { deriveMemoryDestination, isAuthorizedMemoryScope, scopeForSlackChannel } from '../memory-scope.js';

describe('memory destination', () => {
  it('derives only one deterministic Slack destination', () => {
    expect(deriveMemoryDestination({ a: { type: 'slack', channel_id: 'C1' } })).toEqual({ channel_id: 'C1' });
    expect(deriveMemoryDestination({
      a: { type: 'slack', channel_id: 'C1' },
      b: { type: 'slack', channel_id: 'C2' },
    }, 'a')).toEqual({ channel_id: 'C1' });
    expect(deriveMemoryDestination({
      a: { type: 'slack', channel_id: 'C1' },
    }, 'a', 'C2')).toEqual({ channel_id: 'C2' });
    expect(deriveMemoryDestination({
      a: { type: 'slack', channel_id: 'C1' },
      b: { type: 'slack', channel_id: 'C2' },
    })).toBeUndefined();
    expect(deriveMemoryDestination({ a: { type: 'cli' } })).toBeUndefined();
  });

  it('authorizes a safe live classification only for the exact destination', () => {
    const destination = { channel_id: 'C1' };
    expect(isAuthorizedMemoryScope(destination, scopeForSlackChannel({ kind: 'public', channel_id: 'C1' }, 'C1'))).toBe(true);
    expect(isAuthorizedMemoryScope(destination, scopeForSlackChannel({ kind: 'private_channel', channel_id: 'C1' }, 'C1'))).toBe(true);
    expect(isAuthorizedMemoryScope(destination, scopeForSlackChannel({ kind: 'none' }, 'C1'))).toBe(false);
    expect(isAuthorizedMemoryScope(destination, scopeForSlackChannel({ kind: 'public', channel_id: 'C2' }, 'C2'))).toBe(false);
  });
});
