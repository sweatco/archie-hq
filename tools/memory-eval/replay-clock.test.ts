import { describe, expect, it } from 'vitest';
import { withReplayDate } from './replay-clock.js';

describe('isolated replay clock', () => {
  it('dates zero-argument construction and restores the process clock', async () => {
    const actualDate = globalThis.Date;
    const wallClock = actualDate.now();
    await withReplayDate('2023-05-01T08:00:00Z', async () => {
      expect(new Date().toISOString()).toBe('2023-05-01T08:00:00.000Z');
      expect(Date()).toBe(new actualDate('2023-05-01T08:00:00Z').toString());
      expect(new Date('2020-01-01T00:00:00Z').toISOString()).toBe('2020-01-01T00:00:00.000Z');
      expect(Date.parse('2020-01-01T00:00:00Z')).toBe(actualDate.parse('2020-01-01T00:00:00Z'));
      expect(Date.now()).toBeGreaterThanOrEqual(wallClock);
      await expect(withReplayDate('2023-05-02T00:00:00Z', async () => undefined)).rejects.toThrow('overlapping');
    });
    expect(globalThis.Date).toBe(actualDate);
  });

  it('restores the clock after a failed replay', async () => {
    const actualDate = globalThis.Date;
    await expect(withReplayDate('2023-05-01T08:00:00Z', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(globalThis.Date).toBe(actualDate);
    await expect(withReplayDate('bad', async () => undefined)).rejects.toThrow('invalid replay');
    expect(globalThis.Date).toBe(actualDate);
  });
});
