// SPDX-License-Identifier: AGPL-3.0-or-later
export interface SourceMessage {
  channel: string;
  thread: string;
  ts: string;
  version: string;
  author: string;
  text: string;
  deleted?: boolean;
  own?: boolean;
  bot?: boolean;
  context?: boolean;
  eventId?: string;
}

export interface Evidence extends SourceMessage {
  id: number;
  captured: number;
}

export interface ThreadSnapshot {
  channel: string;
  thread: string;
  generation: number;
  evidence: Evidence[];
  gap: string | null;
  removed?: Array<{ ts: string; version: string }>;
}

export interface Matter {
  id: string;
  channel: string;
  thread: string;
  title: string;
  detail: string;
  evidence: number[];
  state: 'open' | 'snoozed' | 'resolved' | 'dismissed';
  owner: string | null;
  deadline: number | null;
  explicit: boolean;
  nextCheck: number;
  valid: boolean;
  policy: string;
  reopen?: boolean;
}

export interface Observation {
  id: string;
  channel: string;
  thread: string;
  text: string;
  evidence: number[];
  kind: 'commitment' | 'decision' | 'change' | 'question' | 'opportunity';
}

export interface Job {
  kind: string;
  target: string;
  token: string;
  payload: string;
  attempts: number;
  generation: number;
}

export interface Delivery {
  id: string;
  channel: string;
  thread: string | null;
  text: string;
  matters: string[];
  evidence: number[];
  policy: string;
  digest: boolean;
  state: 'pending' | 'sending' | 'uncertain' | 'sent' | 'cancelled';
  ts: string | null;
  created: number;
  proposal?: { id: string; version: string };
}

export interface CapabilityProposal {
  id: string;
  repository: string;
  outcome: string;
  evidence: number[];
  status: string;
  acknowledgedOutcome?: { state: 'implemented' | 'released' | 'rejected'; actor: string; at: number; artifact: string; acceptance: string };
}

export interface TaskHandoffRecord {
  proposal: string; version: string; actor: string; approved: number; task: string;
  state: 'approved' | 'prepared' | 'activated' | 'stale'; budget: 'task'; delivery: string;
  card_state?: 'pending' | 'activated' | 'stale' | null;
  card_retry?: number;
}

export function lisbonDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}
