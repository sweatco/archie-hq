// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { CapabilityProposal } from './types.js';
import { citationIdentity } from './decisions.js';

export function proposalVersion(proposal: Pick<CapabilityProposal, 'repository' | 'outcome' | 'evidence'>): string {
  return createHash('sha256').update(JSON.stringify([proposal.repository, proposal.outcome, citationIdentity(proposal.evidence)])).digest('hex').slice(0, 24);
}

export function proposalTaskId(team: string, id: string, at = Date.now()): string {
  const stamp = new Date(at).toISOString().replace(/[-:T]/g, '');
  return `task-${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-${createHash('sha256').update(JSON.stringify([team, id])).digest('hex').slice(0, 24)}`;
}
