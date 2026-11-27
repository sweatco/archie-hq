// SPDX-License-Identifier: AGPL-3.0-or-later
/** Event routines: triggers with `incoming_event` conditions, as the consumer the incoming events inbox hands events to. */
import { z } from 'zod';
import { routineMayUseInput } from '../incoming/access.js';
import { passesFilter } from '../incoming/filter.js';
import type {
  ConsumerMatch,
  HandleResult,
  HandoffWork,
  InboxView,
  IncomingConsumer,
  Input,
} from '../incoming/types.js';
import { loadMetadata } from '../tasks/persistence.js';
import { Task } from '../tasks/task.js';
import type { Trigger, TriggerBinding } from '../types/trigger.js';
import { logger } from './logger.js';
import {
  reservedTaskId,
  ROUTINE_CONSUMER_KIND,
  routineReservationSchema,
} from './routine-handoff.js';
import {
  fireEvent,
  getEnabledTrigger,
  releaseEventSlot,
  triggersEnabled,
} from './trigger-scheduler.js';
import { loadTrigger } from './trigger-store.js';

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

const ACCEPTED: HandleResult = { state: 'accepted' };

export const routineConsumer: IncomingConsumer = {
  kind: ROUTINE_CONSUMER_KIND,
  match: matchRoutines,
  handle: startRoutine,
  reconcile: discardAbandoned,
};

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

/** Starts one Task for the handoff, however often it is retried. A skip leaves no prepared Task behind. */
async function startRoutine(work: HandoffWork): Promise<HandleResult> {
  const { handoff, inbox } = work;
  const snapshot = routineSnapshotSchema.parse(JSON.parse(handoff.snapshot));
  let taskId = handoff.reservation
    ? routineReservationSchema.parse(JSON.parse(handoff.reservation)).task_id
    : undefined;
  if (taskId && (await Task.startedFor(taskId, handoff.id))) return ACCEPTED;

  const skip = async (reason: string): Promise<HandleResult> => {
    if (taskId) await discardUnstarted(taskId, handoff.id);
    return { state: 'skipped', reason };
  };

  const live = await liveRoutine(inbox, snapshot);
  if ('stop' in live) return skip(live.stop);

  const fired = await fireEvent(
    { ...live.routine, action: { prompt: snapshot.prompt }, binding: snapshot.binding },
    {
      origin: handoff.id,
      inputId: snapshot.input_id,
      event: work.body,
      reservedTaskId: taskId,
      reserve: (reserved) => {
        work.saveReservation(JSON.stringify({ task_id: reserved }));
        taskId = reserved;
      },
      whyStop: async () => {
        const again = await liveRoutine(inbox, snapshot);
        return 'stop' in again ? again.stop : null;
      },
      prepare: (input) => Task.prepareTriggered(input),
    },
  );
  return fired.status === 'fired' ? ACCEPTED : skip(fired.reason);
}

/** Removes a Task that never started and gives its run slot back. Returns whether the folder is gone. */
async function discardUnstarted(taskId: string, origin: string): Promise<boolean> {
  const gone = await Task.discardPrepared(taskId, origin);
  if (gone) releaseEventSlot(taskId);
  return gone;
}

/** The routine as it runs now, or why unstarted work for it stops. */
async function liveRoutine(
  inbox: InboxView,
  snapshot: RoutineSnapshot,
): Promise<{ routine: Trigger } | { stop: string }> {
  const input = inbox.input(snapshot.input_id);
  if (!input || input.state === 'deleted') return { stop: 'input_deleted' };
  if (input.state === 'paused') return { stop: 'input_paused' };
  if (!routineMayUseInput(input, snapshot.trigger_id)) return { stop: 'routine_unlinked' };

  const routine = getEnabledTrigger(snapshot.trigger_id);
  // The index holds enabled triggers only, so the record tells a paused routine from a deleted one.
  if (!routine) {
    const stored = await loadTrigger(snapshot.trigger_id);
    if (stored?.status === 'enabled')
      throw new Error(`Routine ${snapshot.trigger_id} is enabled but not indexed yet`);
    return { stop: stored ? 'routine_paused' : 'routine_deleted' };
  }
  const namesInput = routine.conditions.some(
    (condition) => condition.type === 'incoming_event' && condition.input_id === snapshot.input_id,
  );
  return namesInput ? { routine } : { stop: 'routine_changed' };
}

/** The inbox ends some handoffs without calling `handle`; a Task one of them prepared is removed here. */
async function discardAbandoned(inbox: InboxView): Promise<void> {
  for (const { handoffId, reservation } of inbox.abandonedReservations(ROUTINE_CONSUMER_KIND)) {
    const taskId = reservedTaskId(reservation);
    if (!taskId) continue;
    const prepared = (await loadMetadata(taskId))?.status === 'preparing';
    if ((await discardUnstarted(taskId, handoffId)) && prepared)
      logger.system(`Discarded task ${taskId}: its handoff ${handoffId} ended before it started`);
  }
}
