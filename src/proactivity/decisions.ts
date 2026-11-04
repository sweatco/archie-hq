// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Matter, ThreadSnapshot } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEADLINE_LEAD = 15 * MINUTE;

export function publicFollowupAt(snapshot: ThreadSnapshot): number | undefined {
  const activity = snapshot.evidence.filter(e => !e.own && !e.bot)
    .map(e => Math.max(Number(e.ts), Number(e.version)) * 1000);
  if (!activity.length) return undefined;
  let due = Math.max(...activity);
  let days = 0;
  while (days < 2) {
    due += DAY;
    const weekday = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Lisbon', weekday: 'short' }).format(due);
    if (weekday !== 'Sat' && weekday !== 'Sun') days++;
  }
  return due;
}

export function inactivityPhase(snapshot: ThreadSnapshot, now: number): 'unknown' | 'recent' | 'abandoned' {
  const due = publicFollowupAt(snapshot);
  return due === undefined ? 'unknown' : now >= due ? 'abandoned' : 'recent';
}

export function reconciledCheck(previous: Matter | undefined, deadline: number | null, now: number): number {
  if (!previous || previous.state === 'resolved') return now;
  if (previous.state === 'snoozed' || previous.state === 'dismissed') return previous.nextCheck;
  if (deadline === null || (previous.deadline !== null && deadline >= previous.deadline)) return previous.nextCheck;
  return Math.min(previous.nextCheck, Math.max(now, deadline - DEADLINE_LEAD));
}

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

export function nextInvestigationCheck(matter: Matter, snapshot: ThreadSnapshot, now: number): number | undefined {
  const next = nextMatterCheck(matter, now);
  if (next === undefined || matter.state === 'snoozed') return next;
  const abandonedAt = publicFollowupAt(snapshot);
  return abandonedAt !== undefined && abandonedAt > now ? Math.min(next, abandonedAt) : next;
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
  | 'outside_hours' | 'budget_deferred' | 'approval_required' | 'controlled';

export const reasonText: Record<DecisionReason, string> = {
  unchanged: 'Source revisions, context, inactivity eligibility and reminder phase are unchanged; the previous analysis was reused.',
  scheduled: 'Waiting for the next evidence check.', snoozed: 'Deferred until the owner’s agreed reminder.',
  resolved: 'Current evidence says this matter is resolved.', dismissed: 'The owner dismissed this matter.',
  source_unavailable: 'Current source access or complete context could not be verified.', source_changed: 'Source revisions changed; fresh extraction is required.',
  no_help: 'No concrete useful help was found.', already_notified: 'The same evidence and reminder state were already covered.',
  queued: 'A source-backed intervention is queued.', delivered: 'Slack acknowledged this intervention.',
  delivery_uncertain: 'Slack may have accepted the message; reconciliation is required.', active_task: 'An ordinary task is already handling this discussion.',
  outside_hours: 'Delivery is waiting for Lisbon business hours.', budget_deferred: 'Background spending or request capacity is unavailable.',
  approval_required: 'Delivery requires live mode and explicit owner enablement.', controlled: 'An owner control currently suppresses this intervention.',
};
