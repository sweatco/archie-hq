// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';
import type { InputServices } from './inputs.js';
import type { InboxView, Input } from './types.js';

type InputReader = Pick<InboxView, 'input'>;

let openInbox: InputReader | null = null;

/** The daemon sets its inbox here when it opens and clears it when it closes. */
export function setOpenInbox(inbox: InputReader | null): void {
  openInbox = inbox;
}

let daemonInputs: InputServices | null = null;

/** The daemon sets its store and vault here beside the inbox, for code that changes inputs while it runs. */
export function setInputServices(services: InputServices | null): void {
  daemonInputs = services;
}

/** Null when incoming events are off or the inbox could not be opened. */
export function inputServices(): InputServices | null {
  return daemonInputs;
}

/** May this routine still use this input? Every check before and during a run asks here, so scope has one place to go. */
export function routineMayUseInput(input: Input | null, triggerId: string): boolean {
  return input !== null && input.state !== 'deleted' && input.routines.includes(triggerId);
}

type EventStart = Pick<TaskMetadata, 'triggered_by' | 'triggered_start'>;

/**
 * A Task that an incoming event started may post, share files and write memory only while its routine may use the input.
 * The inbox is read on every call, and a closed inbox refuses. Every other Task passes.
 */
export function taskMayUseItsInput(metadata: EventStart): boolean {
  return inputRefusal(metadata) === null;
}

/** True while the input of a Task that an event started cannot be checked: the answer may differ once the inbox is open. */
export function inputUnchecked(metadata: EventStart): boolean {
  return metadata.triggered_start !== undefined && !openInbox;
}

/** Why such a Task is refused, or null when it may go on. A closed inbox is named apart from a lost link. */
export function inputRefusal(metadata: EventStart): string | null {
  const start = metadata.triggered_start;
  if (!start) return null;
  if (inputUnchecked(metadata))
    return 'the incoming events inbox is not open, so the input that started this task cannot be checked';
  if (
    !metadata.triggered_by ||
    !routineMayUseInput(openInbox?.input(start.input_id) ?? null, metadata.triggered_by)
  )
    return 'this task may no longer use the incoming events input that started it';
  return null;
}
