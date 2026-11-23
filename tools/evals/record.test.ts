import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseInvocation } from './record.js';

describe('parseInvocation', () => {
  it('takes one task folder and a source', () => {
    expect(parseInvocation(['sessions/task-20260101-0900-evalfx', '--source', 'eval'])).toEqual({
      taskDir: resolve('sessions/task-20260101-0900-evalfx'),
      source: 'eval',
    });
    expect(parseInvocation(['a']).source).toBe('production');
  });

  it('rejects malformed input', () => {
    expect(() => parseInvocation([])).toThrow('expected exactly one task folder');
    expect(() => parseInvocation(['a', 'b'])).toThrow('expected exactly one task folder');
    expect(() => parseInvocation(['a', '--source', 'staging'])).toThrow();
  });
});
