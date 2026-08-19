import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitEvent,
  offEvent,
  offTaskCompleted,
  onEvent,
  onTaskCompleted,
  prepareTaskCompleted,
} from '../event-bus.js';
import type { SystemEvent } from '../event-bus.js';

const listeners: Array<(event: SystemEvent) => void | Promise<void>> = [];
const eventListeners: Array<(event: SystemEvent) => void> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) offTaskCompleted(listener);
  for (const listener of eventListeners.splice(0)) offEvent(listener);
});

describe('durable task completion events', () => {
  it('does not resolve until completion subscribers finish', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listener = vi.fn(() => blocked);
    const genericListener = vi.fn();
    listeners.push(listener);
    eventListeners.push(genericListener);
    onTaskCompleted(listener);
    onEvent(genericListener);

    let settled = false;
    const prepared = prepareTaskCompleted('task-20260815-1200-event1');
    prepared.then(() => { settled = true; });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(genericListener).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    release();
    await expect(prepared).resolves.toBeUndefined();

    emitEvent('task:completed', 'task-20260815-1200-event1');
    expect(genericListener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('propagates completion subscriber failures', async () => {
    const listener = vi.fn(async () => { throw new Error('intent write failed'); });
    listeners.push(listener);
    onTaskCompleted(listener);

    await expect(prepareTaskCompleted('task-20260815-1200-event2'))
      .rejects.toThrow('intent write failed');
  });
});
