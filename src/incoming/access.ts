// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';
import type { InboxView, Input } from './types.js';

type InputReader = Pick<InboxView, 'input'>;

let openInbox: InputReader | null = null;

/** The daemon sets its inbox here when it opens and clears it when it closes. */
export function setOpenInbox(inbox: InputReader | null): void {
  openInbox = inbox;
}

/** May this routine still use this input? Every check before and during a run asks here, so scope has one place to go. */
export function routineMayUseInput(input: Input | null, triggerId: string): boolean {
  return input !== null && input.state !== 'deleted' && input.routines.includes(triggerId);
}

/**
 * A Task that an incoming event started may post, share files and write memory only while its routine may use the input.
 * The inbox is read on every call, and a closed inbox refuses. Every other Task passes.
 */
export function taskMayUseItsInput(
  metadata: Pick<TaskMetadata, 'triggered_by' | 'triggered_start'>,
): boolean {
  const start = metadata.triggered_start;
  if (!start) return true;
  if (!openInbox || !metadata.triggered_by) return false;
  return routineMayUseInput(openInbox.input(start.input_id), metadata.triggered_by);
}
