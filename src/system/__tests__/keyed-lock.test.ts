/**
 * Unit tests for createKeyedLock — per-key async serialization used to make a
 * task's PR-card writes mutually exclusive.
 */

import { describe, it, expect } from 'vitest';
import { createKeyedLock } from '../keyed-lock.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('createKeyedLock', () => {
  it('serializes same-key operations in arrival order (no interleaving)', async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    const op = (label: string, delay: number) =>
      lock('k', async () => {
        log.push(`${label}:start`);
        await tick(delay);
        log.push(`${label}:end`);
      });

    // Start B with a longer delay first; A must still wait for B to finish.
    await Promise.all([op('B', 20), op('A', 0)]);
    expect(log).toEqual(['B:start', 'B:end', 'A:start', 'A:end']);
  });

  it('runs different keys concurrently', async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    await Promise.all([
      lock('x', async () => { log.push('x:start'); await tick(20); log.push('x:end'); }),
      lock('y', async () => { log.push('y:start'); await tick(0); log.push('y:end'); }),
    ]);
    // y (different key) does not wait for x — it starts and finishes inside x's window.
    expect(log).toEqual(['x:start', 'y:start', 'y:end', 'x:end']);
  });

  it('continues the chain after a rejection (one failure does not wedge the key)', async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const failing = lock('k', async () => { order.push('1'); throw new Error('boom'); });
    const next = lock('k', async () => { order.push('2'); return 'ok'; });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['1', '2']);
  });

  it('propagates the fn return value to the caller', async () => {
    const lock = createKeyedLock();
    await expect(lock('k', async () => 42)).resolves.toBe(42);
  });
});
