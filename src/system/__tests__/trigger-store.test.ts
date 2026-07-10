/**
 * Tests for the trigger-id validator that guards every store filesystem path
 * against traversal (CodeQL: uncontrolled data in path expression).
 */

import { describe, it, expect } from 'vitest';
import { isValidTriggerId, generateTriggerId, getTriggerPath } from '../trigger-store.js';

describe('isValidTriggerId', () => {
  it('accepts a freshly generated id', () => {
    expect(isValidTriggerId(generateTriggerId())).toBe(true);
  });

  it('accepts the canonical shape', () => {
    expect(isValidTriggerId('trg-20260710-1152-a3f9k2')).toBe(true);
  });

  it('rejects path-traversal attempts', () => {
    expect(isValidTriggerId('../../etc/passwd')).toBe(false);
    expect(isValidTriggerId('trg-../secret')).toBe(false);
    expect(isValidTriggerId('trg-/etc/passwd')).toBe(false);
    expect(isValidTriggerId('trg-..')).toBe(false);
  });

  it('rejects ids without the trg- prefix or with unsafe chars', () => {
    expect(isValidTriggerId('passwd')).toBe(false);
    expect(isValidTriggerId('trg-a.b')).toBe(false);
    expect(isValidTriggerId('trg_a')).toBe(false);
    expect(isValidTriggerId('')).toBe(false);
  });
});

describe('getTriggerPath', () => {
  it('throws on a malformed id rather than building a traversal path', () => {
    expect(() => getTriggerPath('../../evil')).toThrow(/Invalid trigger id/);
  });

  it('builds a path inside the triggers dir for a valid id', () => {
    const p = getTriggerPath('trg-20260710-1152-a3f9k2');
    expect(p.endsWith('/trg-20260710-1152-a3f9k2.json')).toBe(true);
    expect(p).not.toContain('..');
  });
});
