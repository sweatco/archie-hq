// SPDX-License-Identifier: AGPL-3.0-or-later
/** What a routine's handoff holds in the inbox. Kept apart from the consumer, so a listing can read it without loading Tasks. */
import { z } from 'zod';

export const ROUTINE_CONSUMER_KIND = 'routine';

/** Exists once a run slot was taken; names the Task every later attempt continues. */
export const routineReservationSchema = z.object({ task_id: z.string() });

/** The Task a reservation names, or undefined when the stored text is not a reservation. */
export function reservedTaskId(reservation: string): string | undefined {
  try {
    const reserved = routineReservationSchema.safeParse(JSON.parse(reservation));
    return reserved.success ? reserved.data.task_id : undefined;
  } catch {
    return undefined;
  }
}
