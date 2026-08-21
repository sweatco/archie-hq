import { afterEach, describe, expect, it } from 'vitest';
import { offEvent, onEvent, type EventType, type SystemEvent } from '../../system/event-bus.js';
import { activeTasks, isTaskTerminating, Task } from '../task.js';

afterEach(() => {
  activeTasks.clear();
});

describe('OAuth lifecycle termination signal', () => {
  it.each([
    ['stop', 'task:stopped', 'stopped'],
    ['complete', 'task:completed', 'completed'],
  ] as const)('covers the full %s teardown and clears before %s', async (method, eventType, status) => {
    let release!: () => void;
    const resurface = new Promise<void>((resolve) => { release = resolve; });
    const observed: Array<{ event: EventType; terminating: boolean; active: boolean }> = [];
    const listener = (event: SystemEvent) => {
      if (event.taskId === 'task-oauth') {
        observed.push({
          event: event.type,
          terminating: isTaskTerminating(event.taskId),
          active: activeTasks.has(event.taskId),
        });
      }
    };
    onEvent(listener);

    const task = {
      taskId: 'task-oauth',
      isActive: true,
      metadata: { edit_allowed: true, status: 'in_progress' },
      agentProcesses: new Map(),
      resurfacePrCards: () => resurface,
      clearTaskTimeout: () => {},
      clearAcks: () => {},
      statusController: { clear: () => {} },
      save: async () => {},
    } as unknown as Task;
    activeTasks.set(task.taskId, task);

    const termination = Task.prototype[method].call(task);
    expect(isTaskTerminating(task.taskId)).toBe(true);
    release();
    await termination;

    expect(task.metadata.status).toBe(status);
    expect(isTaskTerminating(task.taskId)).toBe(false);
    expect(observed).toContainEqual({ event: eventType, terminating: false, active: false });
    offEvent(listener);
  });

  it('still emits the stopped edge after teardown persistence fails', async () => {
    const observed: boolean[] = [];
    const listener = (event: SystemEvent) => {
      if (event.type === 'task:stopped' && event.taskId === 'task-oauth-failed') {
        observed.push(isTaskTerminating(event.taskId) || activeTasks.has(event.taskId));
      }
    };
    onEvent(listener);
    const task = {
      taskId: 'task-oauth-failed', isActive: true,
      metadata: { edit_allowed: true, status: 'in_progress' },
      agentProcesses: new Map(), resurfacePrCards: async () => {},
      clearTaskTimeout: () => {}, clearAcks: () => {}, statusController: { clear: () => {} },
      save: async () => { throw new Error('disk unavailable'); },
    } as unknown as Task;
    activeTasks.set(task.taskId, task);

    await expect(Task.prototype.stop.call(task)).rejects.toThrow('disk unavailable');

    expect(observed).toEqual([false]);
    offEvent(listener);
  });
});
