import { describe, it, expect } from 'vitest';
import { deriveMemoryTaskTitle } from '../spawn.js';

describe('deriveMemoryTaskTitle', () => {
  it('prefers the generated title and falls back to the first user message', () => {
    expect(deriveMemoryTaskTitle('Payment retries', 'Fix webhook handling')).toBe('Payment retries');
    expect(deriveMemoryTaskTitle(null, 'Fix webhook handling')).toBe('Fix webhook handling');
  });

  it('bounds the fallback selection text', () => {
    expect(deriveMemoryTaskTitle(undefined, 'x'.repeat(700))).toHaveLength(500);
  });
});
