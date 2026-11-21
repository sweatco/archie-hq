// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Input } from './types.js';

/** May this routine still use this input? Every check before and during a run asks here, so scope has one place to go. */
export function routineMayUseInput(input: Input | null, triggerId: string): boolean {
  return input !== null && input.state !== 'deleted' && input.routines.includes(triggerId);
}
