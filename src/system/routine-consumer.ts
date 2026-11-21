// SPDX-License-Identifier: AGPL-3.0-or-later
/** Event routines: triggers with `incoming_event` conditions, seen from the incoming events inbox. */
import { z } from 'zod';
import { passesFilter } from '../incoming/filter.js';
import type { ConsumerMatch, Input } from '../incoming/types.js';
import type { Trigger, TriggerBinding } from '../types/trigger.js';
import { getEnabledTrigger, triggersEnabled } from './trigger-scheduler.js';

export const ROUTINE_CONSUMER_KIND = 'routine';

const bindingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('channel'), channel_id: z.string(), channel_name: z.string() }),
  z.object({
    type: z.literal('user'),
    user_id: z.string(),
    channel_id: z.string(),
    channel_name: z.string(),
  }),
]) satisfies z.ZodType<TriggerBinding>;

/** What a run uses instead of the live trigger: the instructions and destination as they were at receipt. */
export const routineSnapshotSchema = z.object({
  v: z.literal(1),
  trigger_id: z.string(),
  input_id: z.string(),
  prompt: z.string(),
  binding: bindingSchema,
});
export type RoutineSnapshot = z.infer<typeof routineSnapshotSchema>;

/** One snapshot per routine that is linked, enabled, names this input and passes its own filter. */
export function matchRoutines(input: Input, event: Record<string, unknown>): ConsumerMatch[] {
  if (!triggersEnabled()) return [];
  return input.routines.flatMap((triggerId) => {
    const trigger = getEnabledTrigger(triggerId);
    if (!trigger || !listensTo(trigger, input.id, event)) return [];
    const snapshot: RoutineSnapshot = {
      v: 1,
      trigger_id: trigger.id,
      input_id: input.id,
      prompt: trigger.action.prompt,
      binding: trigger.binding,
    };
    return [{ consumerId: trigger.id, snapshot: JSON.stringify(snapshot) }];
  });
}

function listensTo(trigger: Trigger, inputId: string, event: Record<string, unknown>): boolean {
  return trigger.conditions.some(
    (condition) =>
      condition.type === 'incoming_event' &&
      condition.input_id === inputId &&
      passesFilter(condition.filter ?? [], event),
  );
}
