/**
 * Event Bus — typed EventEmitter singleton
 *
 * All system components emit events here. SSE endpoint subscribes to stream
 * them to CLI clients. Events are fire-and-forget (no persistence).
 */

import { EventEmitter } from 'events';

export type EventType =
  | 'task:created' | 'task:stopped' | 'task:completed'
  | 'agent:active' | 'agent:inactive'
  | 'message:to_user' | 'message:agent' | 'message:finding' | 'message:user_input'
  | 'approval:requested' | 'approval:resolved';

export interface SystemEvent {
  type: EventType;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(50); // SSE clients + internal listeners

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
