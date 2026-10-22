// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Matter } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEADLINE_LEAD = 15 * MINUTE;

export function deadlinePhase(matter: Matter, now: number): 'none' | 'future' | 'approaching' | 'due' {
  if (matter.deadline === null) return 'none';
  if (now >= matter.deadline) return 'due';
  return now >= matter.deadline - DEADLINE_LEAD ? 'approaching' : 'future';
}

export function nextMatterCheck(matter: Matter, now: number): number | undefined {
  if (matter.state === 'resolved' || matter.state === 'dismissed') return undefined;
  if (matter.state === 'snoozed' && matter.nextCheck > now) return matter.nextCheck;
  if (matter.deadline !== null) {
    if (matter.deadline > now) {
      const preparation = matter.deadline - DEADLINE_LEAD;
      return Math.min(now + DAY, preparation > now ? preparation : matter.deadline);
    }
    return now + HOUR;
  }
  return now + DAY;
}

export function citationIdentity(evidence: number[]): string {
  return [...new Set(evidence)].sort((a, b) => a - b).join(',');
}

export function reminderPhase(matter: Matter, now: number): string {
  if (!matter.explicit || matter.deadline === null) return 'ordinary';
  const phase = deadlinePhase(matter, now);
  return phase === 'approaching' || phase === 'due' ? `${phase}:${matter.deadline}` : 'ordinary';
}

export type DecisionReason = 'unchanged' | 'scheduled' | 'snoozed' | 'resolved' | 'dismissed' | 'source_unavailable' | 'source_changed'
  | 'no_help' | 'already_notified' | 'queued' | 'delivered' | 'delivery_uncertain' | 'active_task'
  | 'outside_hours' | 'budget_deferred' | 'approval_required' | 'controlled' | 'proposal_approved';

export const reasonText: Record<DecisionReason, string> = {
  unchanged: 'Source revisions, policy, context and reminder phase are unchanged; the previous analysis was reused.',
  scheduled: 'Waiting for the next evidence check.', snoozed: 'Deferred until the owner’s agreed reminder.',
  resolved: 'Current evidence says this matter is resolved.', dismissed: 'The owner dismissed this matter.',
  source_unavailable: 'Current source access or complete context could not be verified.', source_changed: 'Source revisions changed; fresh extraction is required.',
  no_help: 'No concrete useful help was found.', already_notified: 'The same evidence and reminder state were already covered.',
  queued: 'A source-backed intervention is queued.', delivered: 'Slack acknowledged this intervention.',
  delivery_uncertain: 'Slack may have accepted the message; reconciliation is required.', active_task: 'An ordinary task is already handling this discussion.',
  outside_hours: 'Delivery is waiting for Lisbon business hours.', budget_deferred: 'Background spending or request capacity is unavailable.',
  approval_required: 'Delivery awaits an exact reviewed policy approval.', controlled: 'An owner control currently suppresses this intervention.',
  proposal_approved: 'The owner explicitly approved a normal task using normal task budgeting.',
};
