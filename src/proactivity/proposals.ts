// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { CapabilityProposal } from './types.js';
import { z } from 'zod';
import { citationIdentity } from './decisions.js';

export function proposalVersion(proposal: Pick<CapabilityProposal, 'id' | 'repository' | 'outcome' | 'evidence' | 'matter'>): string {
  return createHash('sha256').update(JSON.stringify([proposal.id, proposal.repository, proposal.matter, proposal.outcome, citationIdentity(proposal.evidence)])).digest('hex').slice(0, 24);
}

export function proposalTaskId(team: string, id: string, at = Date.now()): string {
  const stamp = new Date(at).toISOString().replace(/[-:T]/g, '');
  return `task-${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-${createHash('sha256').update(JSON.stringify([team, id])).digest('hex').slice(0, 24)}`;
}

export const TaskSuggestion = z.object({ repository: z.string().max(160), outcome: z.string().min(1).max(1200), evidence: z.array(z.number().int().positive()).min(1).max(20) });

export function suggestionId(proposal: { repository: string; matter: string; evidence: number[] }): string {
  return createHash('sha256').update(JSON.stringify([proposal.repository, proposal.matter, citationIdentity(proposal.evidence)])).digest('hex').slice(0, 24);
}
