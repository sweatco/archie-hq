/**
 * Unit tests for createKeyedLock — per-key async serialization used to make a
 * task's PR-card writes mutually exclusive.
 */

import { describe, it, expect } from 'vitest';
import { createKeyedLock } from '../keyed-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createKeyedLock', () => {
  it('serializes same-key operations in arrival order (no interleaving)', async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = lock('k', async () => {
      log.push('B:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      log.push('B:end');
    });
    await firstStarted.promise;
    const second = lock('k', async () => {
      log.push('A:start');
      log.push('A:end');
    });

    expect(log).toEqual(['B:start']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(['B:start', 'B:end', 'A:start', 'A:end']);
  });

  it('runs different keys concurrently', async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    const xStarted = deferred();
    const releaseX = deferred();
    const x = lock('x', async () => {
      log.push('x:start');
      xStarted.resolve();
      await releaseX.promise;
      log.push('x:end');
    });
    await xStarted.promise;
    await lock('y', async () => { log.push('y:start'); log.push('y:end'); });

    expect(log).toEqual(['x:start', 'y:start', 'y:end']);
    releaseX.resolve();
    await x;
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
