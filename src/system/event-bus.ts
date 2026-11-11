/**
 * Event Bus — typed EventEmitter singleton
 *
 * All system components emit events here. SSE endpoint subscribes to stream
 * them to CLI clients. Events are fire-and-forget (no persistence).
 */

import { z } from 'zod';
import { EventEmitter } from 'events';

const eventTypes = [
  'task:created',
  'task:resumed',
  'task:stopped',
  'task:completed',
  'agent:active',
  'agent:inactive',
  'message',
  'agent:log',
  'agent:bg_task',
  'status',
  'approval:requested',
  'approval:resolved',
  'pr_card',
  'reminder:set',
  'reminder:cancelled',
  'reminder:fired',
  'trigger:created',
  'trigger:fired',
  'trigger:paused',
  'trigger:resumed',
  'trigger:deleted',
] as const;
export type EventType = (typeof eventTypes)[number];

export interface SystemEvent {
  type: EventType;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

export const systemEventSchema = z.object({
  type: z.enum(eventTypes),
  taskId: z.string(),
  timestamp: z.string(),
  agentName: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

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
