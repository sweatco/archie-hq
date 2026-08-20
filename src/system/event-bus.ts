/**
 * Event Bus — typed EventEmitter singleton
 *
 * All system components emit events here. SSE endpoint subscribes to stream
 * them to CLI clients. Events are fire-and-forget (no persistence).
 */

import { EventEmitter } from 'events';

export type EventType =
  | 'task:created' | 'task:resumed' | 'task:stopped' | 'task:completed'
  | 'agent:active' | 'agent:inactive'
  | 'message' | 'agent:log' | 'agent:bg_task'
  | 'status'
  | 'approval:requested' | 'approval:resolved'
  | 'pr_card'
  | 'reminder:set' | 'reminder:cancelled' | 'reminder:fired'
  | 'trigger:created' | 'trigger:fired' | 'trigger:paused' | 'trigger:resumed' | 'trigger:deleted';

export interface SystemEvent {
  type: EventType;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(50); // SSE clients + internal listeners

type TaskCompletedListener = (event: SystemEvent) => void | Promise<void>;
const taskCompletedListeners = new Set<TaskCompletedListener>();

/**
 * Emit a system event. Fire-and-forget — never throws.
 */
export function emitEvent(
  type: EventType,
  taskId: string,
  data: Record<string, unknown> = {},
  agentName?: string,
): void {
  const event: SystemEvent = {
    type,
    taskId,
    timestamp: new Date().toISOString(),
    agentName,
    data,
  };
  bus.emit('event', event);
}

/** Run durable completion hooks without publishing the completed event yet. */
export async function prepareTaskCompleted(
  taskId: string,
  data: Record<string, unknown> = {},
  agentName?: string,
): Promise<void> {
  const event: SystemEvent = {
    type: 'task:completed',
    taskId,
    timestamp: new Date().toISOString(),
    agentName,
    data,
  };
  await Promise.all([...taskCompletedListeners].map((listener) => listener(event)));
}

/** Subscribe to completion work that must finish before Task.complete resolves. */
export function onTaskCompleted(listener: TaskCompletedListener): void {
  taskCompletedListeners.add(listener);
}

/** Unsubscribe a durable task-completion listener. */
export function offTaskCompleted(listener: TaskCompletedListener): void {
  taskCompletedListeners.delete(listener);
}

/**
 * Subscribe to all system events.
 */
export function onEvent(listener: (event: SystemEvent) => void): void {
  bus.on('event', listener);
}

/**
 * Unsubscribe from system events.
 */
export function offEvent(listener: (event: SystemEvent) => void): void {
  bus.off('event', listener);
}
