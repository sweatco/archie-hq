import { afterEach, describe, expect, it } from 'vitest';
import { memoryNow, setMemoryClockForEvaluation } from '../clock.js';
import { appendLastTouched } from '../annotations.js';

afterEach(() => {
  process.env.ARCHIE_MEMORY_EVAL_REPLAY = 'true';
  setMemoryClockForEvaluation(null);
  delete process.env.ARCHIE_MEMORY_EVAL_REPLAY;
});

describe('memory replay clock', () => {
  it('is guarded and dates annotations at the replayed completion', () => {
    delete process.env.ARCHIE_MEMORY_EVAL_REPLAY;
    expect(() => setMemoryClockForEvaluation(new Date('2023-05-01T00:00:00Z'))).toThrow('outside isolated replay');
    process.env.ARCHIE_MEMORY_EVAL_REPLAY = 'true';
    setMemoryClockForEvaluation(new Date('2023-05-01T00:00:00Z'));
    expect(memoryNow().toISOString()).toBe('2023-05-01T00:00:00.000Z');
    expect(appendLastTouched('- fact')).toContain('touched: 2023-05-01');
  });
});
