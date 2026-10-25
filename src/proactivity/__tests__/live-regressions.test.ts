// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { InitiativeService } from '../service.js';
import { proposalVersion } from '../proposals.js';
import type { ObservationSlack } from '../slack.js';
import type { Matter, TaskHandoffRecord } from '../types.js';

const SOURCE = "Live test [PR360-LIVE-153122fe]: By Tuesday 27 Oct, 17:00 Lisbon, I need a tiny read-only task for sweatco/archie-hq to DM me 'PR360-LIVE-153122fe ACK' and finish. No shell, repo access or edits. Please prepare a short acknowledgement and the task suggestion for separate approval. If this stays unresolved, a brief follow-up here would help.";
const RESPONSE = {"threads": [{"channel": "C0BL50N2600", "thread": "1792935287.744389", "observations": [{"key": "pr360-ack-request", "text": "Requester asked for a tiny read-only task for sweatco/archie-hq to DM them 'PR360-LIVE-153122fe ACK' and finish, with no shell, repo access, or edits. Archie is asked to prepare a short acknowledgement and a task suggestion for separate approval. No approval has been granted in the supplied evidence.", "evidence": [1], "kind": "commitment"}], "matters": [{"key": "pr360-ack-dm-task", "title": "PR360-LIVE-153122fe ack DM pending approval", "detail": "Explicit request to prepare a read-only ack DM task suggestion for sweatco/archie-hq, due Tuesday 27 Oct 2026 17:00 Lisbon time (inferred year 2026). The task itself requires separate host approval before any action. Requester asked for a brief follow-up in-thread if unresolved. Owner of execution is not stated.", "evidence": [1], "state": "open", "owner": null, "deadline": {"date": "2026-10-27", "time": "17:00", "timeZone": "Europe/Lisbon"}, "explicit": true, "reopen": false}]}]};
const OUTCOMES = ["Read-only task: send the requester (U03RQQTE1EF) a DM with the exact text 'PR360-LIVE-153122fe ACK', then finish. No shell, repository access or edits. Run only after separate host approval. Requested deadline: Tue 27 Oct 2026, 17:00 Lisbon (year inferred). Owner not stated.", "Read-only task: send a single DM to the requester (U03RQQTE1EF) with the exact text 'PR360-LIVE-153122fe ACK', then finish. No shell, no repository access, no edits. Requires separate host approval before any action.", "Read-only task: send a Slack DM to requester U03RQQTE1EF with the exact text 'PR360-LIVE-153122fe ACK' and then finish. No shell, no repository access, no edits. Intended to complete by Tue 27 Oct 2026, 17:00 Lisbon (year inferred). Requires separate host approval before any action."];
const NOW = Date.parse('2026-10-25T13:37:00Z');
const TS = '1792935287.744389';
let root: string;
let store: InitiativeStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-live-regression-'));
  store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', NOW - 600_000);
  store.channel('C0BL50N2600', true, false);
  store.record({ channel: 'C0BL50N2600', thread: TS, ts: TS, version: TS, author: 'U03RQQTE1EF', text: SOURCE }, NOW);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function populate(evidence = [1], id = 'ack'): Matter {
  const snapshot = store.snapshot('C0BL50N2600', TS)!;
  const matter: Matter = { id, channel: snapshot.channel, thread: TS, title: 'ACK task', detail: 'One private ACK', evidence,
    state: 'open', owner: 'U03RQQTE1EF', deadline: null, explicit: true, nextCheck: NOW, valid: true };
  store.apply([snapshot], [], [matter]);
  return matter;
}

function suggest(matter: Matter, outcome = OUTCOMES[0], evidence = matter.evidence): string {
  return store.proposeCapability({ repository: 'sweatco/archie-hq', outcome, evidence, matter: matter.id });
}

function approve(id: string, state: TaskHandoffRecord['state'] = 'approved') {
  store.approveHandoff({ proposal: id, version: proposalVersion(store.proposal(id)!), actor: 'U03RQQTE1EF', approved: NOW,
    task: 'one-task', state: 'approved', budget: 'task', delivery: 'card' });
  const token = store.claimHandoff(id, NOW)!;
  store.finishHandoff(id, token, state);
}

it('resolves the retained live local deadline on the host instead of accepting model epoch arithmetic', async () => {
  const slack = { inspect: async () => ({ shared: false, ownerCanRead: true }), page: async () => ({ messages: store.snapshot('C0BL50N2600', TS)!.evidence }), active: () => false } as unknown as ObservationSlack;
  const model = { complete: vi.fn().mockResolvedValueOnce(RESPONSE).mockResolvedValue({ resolved: false, help: null, public: false, evidence: [1] }) };
  const service = new InitiativeService(store, slack, model, { mode: 'shadow', owner: 'U03RQQTE1EF', extractionModel: 'haiku', investigationModel: 'sonnet' }, () => NOW);
  try {
    store.schedule('extract', 'global', NOW);
    await service.tick(NOW, true);
    expect(store.matters()[0].deadline).toBe(1793120400000);
    expect(model.complete).toHaveBeenCalledTimes(2);
  } finally { service.stop(); service.release(); }
});

it.each([false, true])('keeps one immutable scope for retained model paraphrases, approved=%s', approved => {
  const matter = populate();
  const id = suggest(matter);
  if (approved) approve(id, 'activated');
  for (const outcome of OUTCOMES.slice(1)) expect(suggest(matter, outcome)).toBe(id);
  expect(store.listProposals()).toHaveLength(1);
  expect(store.proposal(id)?.outcome).toBe(OUTCOMES[0]);
  expect(store.pendingProposalCount(NOW)).toBe(approved ? 0 : 1);
  expect(store.matter(matter.id)?.state).toBe('open');
});

it('uses order-insensitive citations and stable host work context even when the model cites a subset', () => {
  const second = store.record({ channel: 'C0BL50N2600', thread: TS, ts: '1792935288.000001', version: '1792935288.000001', author: 'U03RQQTE1EF', text: 'Keep the same tiny read-only ACK scope.' }, NOW)!;
  const matter = populate([1, second]);
  const id = suggest(matter, OUTCOMES[0], [1]);
  expect(suggest(matter, OUTCOMES[1], [second, 1])).toBe(id);
  expect(suggest({ ...matter, evidence: [second, 1] }, OUTCOMES[2], [1, second])).toBe(id);
  const scope = store.proposal(id)!;
  expect(proposalVersion({ ...scope, evidence: [...scope.evidence].reverse() })).toBe(proposalVersion(scope));
});

it.each([false, true])('requires a new identity and approval for fresh evidence, previously approved=%s', approved => {
  const matter = populate(); const previous = suggest(matter); const version = proposalVersion(store.proposal(previous)!);
  if (approved) approve(previous, 'activated');
  const fresh = store.record({ channel: 'C0BL50N2600', thread: TS, ts: '1792935289.000001', version: '1792935289.000001', author: 'U03RQQTE1EF', text: 'Change the task: acknowledge the new scope as NEW ACK.' }, NOW)!;
  const updated = populate([1, fresh]);
  expect(store.proposalCurrent(store.proposal(previous)!, NOW)).toBe(false);
  expect(store.pendingProposalCount(NOW)).toBe(0);
  const next = suggest(updated, 'Send NEW ACK for the changed scope', [fresh]);
  expect(next).not.toBe(previous);
  expect(proposalVersion(store.proposal(next)!)).not.toBe(version);
  expect(store.handoff(next)).toBeNull();
  expect(store.pendingProposalCount(NOW)).toBe(1);
  expect(store.handoff(previous)?.version).toBe(approved ? version : undefined);
});

it('keeps genuinely different matters and repositories distinct', () => {
  const matter = populate(); const original = suggest(matter);
  const other = populate([1], 'different-work');
  expect(suggest(other, 'Prepare a separate read-only checklist')).not.toBe(original);
  expect(store.proposeCapability({ repository: 'sweatco/another-repo', outcome: OUTCOMES[0], evidence: [1], matter: matter.id })).not.toBe(original);
});

it.each(['approved', 'prepared', 'activated', 'stale'] as const)('excludes a %s handoff from awaiting approval', state => {
  const matter = populate(); const id = suggest(matter);
  expect(store.pendingProposalCount(NOW)).toBe(1);
  approve(id, state);
  expect(store.pendingProposalCount(NOW)).toBe(0);
});

it.each(['resolved', 'dismissed', 'snoozed'] as const)('excludes an obsolete %s candidate', state => {
  const matter = populate(); suggest(matter);
  store.attention.saveMatter({ ...matter, state });
  expect(store.pendingProposalCount(NOW)).toBe(0);
});

it('excludes unavailable and expired source evidence without changing approval state', () => {
  const matter = populate(); suggest(matter);
  expect(store.pendingProposalCount(NOW + 91 * 86_400_000)).toBe(0);
  store.channel(matter.channel, false, false);
  expect(store.pendingProposalCount(NOW)).toBe(0);
});

it('reports the current awaiting-approval count without treating task activation as feature completion', () => {
  const matter = populate(); const id = suggest(matter);
  const service = new InitiativeService(store, {} as ObservationSlack, { complete: vi.fn() }, { mode: 'shadow', owner: 'U03RQQTE1EF', extractionModel: 'haiku', investigationModel: 'sonnet' });
  try {
    expect(service.status(NOW)).toContain('Task suggestions awaiting approval: 1.');
    approve(id, 'activated');
    expect(service.status(NOW)).toContain('Task suggestions awaiting approval: 0.');
    expect(store.matter(matter.id)?.state).toBe('open');
  } finally { service.stop(); service.release(); }
});

it('changes the approval version when host evidence context grows even if model wording and citations stay the same', () => {
  const matter = populate(); const original = suggest(matter); const version = proposalVersion(store.proposal(original)!);
  const fresh = store.record({ channel: 'C0BL50N2600', thread: TS, ts: '1792935290.000001', version: '1792935290.000001', author: 'U03RQQTE1EF', text: 'Additional scope: acknowledge the verification result only after this check.' }, NOW)!;
  const updated = populate([1, fresh]);
  const next = suggest(updated, OUTCOMES[0], [1]);
  expect(next).not.toBe(original);
  expect(proposalVersion(store.proposal(next)!)).not.toBe(version);
  expect(store.proposalCurrent(store.proposal(original)!, NOW)).toBe(false);
  expect(store.handoff(next)).toBeNull();
});

it.each([false, true])('ignores changes in selected already-known work-thread citations, approved=%s', approved => {
  const known = store.record({ channel: 'C0BL50N2600', thread: TS, ts: '1792935291.000001', version: '1792935291.000001', author: 'U03RQQTE1EF', text: 'Keep this read-only; send the same single ACK and finish.' }, NOW)!;
  const matter = populate([1]);
  const first = suggest(matter, OUTCOMES[0], [1]);
  const version = proposalVersion(store.proposal(first)!);
  if (approved) approve(first, 'activated');
  expect(suggest(matter, OUTCOMES[1], [known, 1])).toBe(first);
  expect(store.listProposals()).toHaveLength(1);
  expect(proposalVersion(store.proposal(first)!)).toBe(version);
  expect(store.pendingProposalCount(NOW)).toBe(approved ? 0 : 1);
});
