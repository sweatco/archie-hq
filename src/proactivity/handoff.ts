// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CapabilityProposal, TaskHandoffRecord, ThreadSnapshot } from './types.js';
import type { InitiativeStore } from './store.js';
import type { ProposalSlack } from './slack.js';
import { SourceAccess } from './access.js';
import { notificationWindow } from './service.js';
import { proposalTaskId, proposalVersion } from './proposals.js';
import { ordinaryTasks, taskRuntimeState, type ApprovedTaskRuntime } from './task-adapter.js';
import { createKeyedLock } from '../system/keyed-lock.js';
import { logger } from '../system/logger.js';

const starts = createKeyedLock();
const cards = createKeyedLock();
const cardState = (record: TaskHandoffRecord): NonNullable<TaskHandoffRecord['card_state']> =>
  record.state === 'approved' || record.state === 'prepared' ? 'pending' : record.state;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class HandoffRejection extends Error {
  constructor(readonly reason: 'owner' | 'stale' | 'deferred' | 'controlled', message: string) { super(message); }
}

export class ProposalHandoff {
  private readonly access: SourceAccess;
  private readonly cardWrites = new Map<string, Promise<void>>();

  constructor(private readonly store: InitiativeStore, private readonly slack: ProposalSlack, private readonly owner: string,
    private readonly repositories: () => string[],
    private readonly refresh: (source: { channel: string; thread: string }) => Promise<ThreadSnapshot | null>,
    private readonly tasks: ApprovedTaskRuntime = ordinaryTasks) {
    this.access = new SourceAccess(store, slack);
  }

  private async current(proposal: CapabilityProposal, refresh: boolean): Promise<{ status: 'available' | 'deferred' | 'stale'; reason: string }> {
    if (!this.repositories().includes(proposal.repository) || !this.store.proposalCurrent(proposal, Date.now(), false)) return { status: 'stale', reason: 'Proposal evidence or repository scope changed' };
    const sources = this.store.proposalSources(proposal.id);
    for (const source of sources) {
      const access = await this.access.evaluate(source.channel, true);
      if (access !== 'allowed') return { status: access === 'unavailable' ? 'deferred' : 'stale', reason: 'Source access could not be verified' };
      if (refresh) {
        const snapshot = await this.refresh(source);
        if (!snapshot || snapshot.gap) return { status: 'deferred', reason: 'Complete current source context is unavailable' };
      }
    }
    return sources.length > 0 && this.store.proposalCurrent(proposal, Date.now(), false)
      ? { status: 'available', reason: 'Current source revisions and access verified' }
      : { status: 'stale', reason: 'Source revisions changed or expired' };
  }

  async present(now: number): Promise<void> {
    if (!notificationWindow(now) || this.store.setting('delivery_enabled') !== 'true'
      || ['stop', 'mute', 'pause'].some(control => this.store.setting(control) === 'true')) return;
    const page = this.store.pendingProposalIds(this.store.setting('proposal_cursor'));
    for (const id of page) {
      this.store.set('proposal_cursor', id);
      const proposal = this.store.proposal(id);
      if (!proposal || this.store.handoff(proposal.id)) continue;
      const version = proposalVersion(proposal);
      const previous = this.store.delivery(`proposal:${proposal.id}:${version}`);
      if (previous && previous.state !== 'cancelled') continue;
      if ((await this.current(proposal, false)).status !== 'available') continue;
      const sources = this.store.proposalSources(proposal.id);
      const text = `Feature proposal: ${proposal.outcome}\nRepository: ${proposal.repository}\n\n${sources.map(source => this.slack.link(source.channel, source.thread)).join('\n')}\n\nStart task launches one ordinary Archie task using normal task budgeting, outside the $200/day background allowance. Edit mode and GitHub writes still require their normal approvals.`;
      this.store.enqueueDelivery({ id: `proposal:${proposal.id}:${version}`, channel: await this.slack.ownerDm(), thread: null, text,
        matters: [], evidence: proposal.evidence, policy: this.store.setting('policy')!, digest: false, state: 'pending', ts: null, created: now,
        proposal: { id: proposal.id, version } });
    }
    if (page.length < 20) this.store.set('proposal_cursor', '');
  }

  async approve(actor: string, deliveryId: string, version: string): Promise<TaskHandoffRecord> {
    if (actor !== this.owner) throw new HandoffRejection('owner', 'Only the configured owner may start a proposal task');
    const delivery = this.store.delivery(deliveryId);
    if (!delivery?.proposal || delivery.state !== 'sent' || !delivery.ts || delivery.proposal.version !== version
      || !await this.slack.verifyDm(delivery.channel)) throw new HandoffRejection('stale', 'Proposal action is unavailable or stale');
    const previous = this.store.handoff(delivery.proposal.id);
    if (previous) {
      if (previous.actor !== actor || previous.version !== version || previous.delivery !== deliveryId) throw new HandoffRejection('stale', 'Proposal approval has changed');
      this.queueCard(previous.proposal);
      await this.continue(previous);
      return this.store.handoff(previous.proposal)!;
    }
    const proposal = this.store.proposal(delivery.proposal.id);
    if (!proposal || proposalVersion(proposal) !== version) throw new HandoffRejection('stale', 'The proposal version changed; request a fresh proposal.');
    const validation = await this.current(proposal, true);
    if (validation.status !== 'available') throw new HandoffRejection(validation.status, validation.reason + '; request a fresh proposal or retry after access recovers.');
    if (this.store.setting('stop') === 'true') throw new HandoffRejection('controlled', 'Initiative is stopped; no proposal task was activated.');
    const record = this.store.approveHandoff({ proposal: proposal.id, version, actor, approved: Date.now(),
      task: proposalTaskId(this.store.setting('team')!, proposal.id), state: 'approved', budget: 'task', delivery: delivery.id });
    this.queueCard(record.proposal);
    await this.continue(record);
    return this.store.handoff(proposal.id)!;
  }

  private async continue(record: TaskHandoffRecord): Promise<void> {
    await starts(record.proposal, async () => {
      const token = this.store.claimHandoff(record.proposal, Date.now());
      if (!token) return;
      let state: TaskHandoffRecord['state'] | undefined;
      try {
        const existing = await this.tasks.read(record.task);
        if (existing?.approved_start?.phase === 'ready' && existing.approved_start.correlation === `initiative:${record.proposal}`
          && existing.approved_start.version === record.version && existing.approved_start.actor === record.actor) { state = 'activated'; return; }
        const delivery = this.store.delivery(record.delivery);
        const proposal = this.store.proposal(record.proposal);
        if (!delivery?.ts || !proposal || proposalVersion(proposal) !== record.version || record.actor !== this.owner
          || !await this.slack.verifyDm(delivery.channel)) { state = 'stale'; return; }
        const source = await this.current(proposal, true);
        if (source.status !== 'available') { if (source.status === 'stale') state = 'stale'; return; }
        if (this.store.setting('stop') === 'true') return;
        const evidence = this.store.proposalSources(proposal.id).flatMap(source => {
          const snapshot = this.store.snapshot(source.channel, source.thread);
          return (snapshot?.evidence ?? []).filter(item => proposal.evidence.includes(item.id)).map(item => ({
            id: item.id, revision: item.version, source: this.slack.link(item.channel, item.thread), text: item.text.slice(0, 200),
          }));
        });
        const brief = `The owner explicitly approved starting the scoped proposal below. Normal task budgeting applies. Existing edit-mode and external-action approvals still apply. Starting or parking this task does not establish that the feature is implemented or released.\n<proposal_evidence untrusted="true">${escape(JSON.stringify({ repository: proposal.repository, intendedResult: proposal.outcome, evidence })).slice(0, 6000)}</proposal_evidence>`;
        await this.tasks.prepare({ taskId: record.task, correlation: `initiative:${proposal.id}`, version: record.version, actor: record.actor,
          brief, destination: { channel: delivery.channel, thread: delivery.ts, name: 'Owner proposal discussion' } });
        if (!this.store.prepareHandoff(record.proposal, token)) return;
        const refreshed = await this.current(proposal, true);
        if (refreshed.status !== 'available') { if (refreshed.status === 'stale') state = 'stale'; return; }
        if (this.store.setting('stop') === 'true') return;
        await this.tasks.start(record.task);
        state = 'activated';
      } catch (error) {
        const metadata = await this.tasks.read(record.task);
        if (metadata?.approved_start?.phase === 'ready' && metadata.approved_start.correlation === `initiative:${record.proposal}`
          && metadata.approved_start.version === record.version && metadata.approved_start.actor === record.actor) state = 'activated';
        throw error;
      } finally {
        this.store.finishHandoff(record.proposal, token, state);
        this.queueCard(record.proposal);
      }
    });
  }

  async recover(): Promise<void> {
    for (const record of this.store.pendingHandoffs()) {
      try { await this.continue(record); }
      catch (error) { logger.warn('initiative', 'Approved task recovery deferred', error); }
    }
    for (const record of this.store.pendingHandoffCards(Date.now())) this.queueCard(record.proposal);
  }

  private queueCard(id: string): void {
    if (this.cardWrites.has(id)) return;
    // Card IO is serialized independently: a slow Starting edit cannot delay
    // activation or land after the final edit. SQLite retains failed edits.
    const writing = cards(`${this.store.setting('team')}:${id}`, async () => {
      for (;;) {
        const record = this.store.handoff(id);
        if (!record || record.card_state === cardState(record) || (record.card_retry ?? 0) > Date.now()) return;
        const lease = this.store.claimHandoffCard(id, Date.now());
        if (!lease) return;
        const state = cardState(record);
        try {
          const delivery = this.store.delivery(record.delivery);
          if (!delivery?.ts || record.actor !== this.owner || !await this.slack.verifyDm(delivery.channel)) throw new Error('Approved proposal card unavailable');
          const status = state === 'activated' ? `Task started: ${record.task}. Its outcome remains unverified.`
            : state === 'stale' ? 'Approval is stale; no prepared task was activated. Request a fresh proposal.'
              : 'Starting… Approval saved; task preparation is pending.';
          await this.slack.updateProposal(delivery, status, state === 'activated' ? this.slack.link(delivery.channel, delivery.ts) : undefined);
          this.store.finishHandoffCard(id, state, lease);
        } catch (error) {
          this.store.finishHandoffCard(id, state, lease, Date.now() + 60_000);
          throw error;
        }
      }
    }).catch(error => { logger.warn('initiative', 'Proposal card update deferred', error); })
      .finally(() => {
        this.cardWrites.delete(id);
        const record = this.store.handoff(id);
        if (record && record.card_state !== cardState(record) && (record.card_retry ?? 0) <= Date.now()) this.queueCard(id);
      });
    this.cardWrites.set(id, writing);
  }

  async drainCards(): Promise<void> {
    while (this.cardWrites.size) await Promise.all(this.cardWrites.values());
  }

  async describe(id: string) {
    const proposal = this.store.proposal(id);
    if (!proposal) throw new Error('Unknown proposal');
    const validation = await this.current({ ...proposal, status: 'pending filing' }, false);
    const handoff = this.store.handoff(id);
    const metadata = handoff ? await this.tasks.read(handoff.task) : null;
    const delivery = handoff ? this.store.delivery(handoff.delivery) : null;
    return { proposal: validation.status === 'available' ? proposal : { id, sourceState: validation.status, explanation: validation.reason },
      handoff, runtime: taskRuntimeState(metadata), outcome: proposal.acknowledgedOutcome ?? 'unverified',
      conversation: delivery?.ts ? this.slack.link(delivery.channel, delivery.ts) : undefined };
  }

  async acknowledge(actor: string, id: string, state: 'implemented' | 'released' | 'rejected', artifact: string, acceptance: string): Promise<void> {
    if (actor !== this.owner) throw new Error('Owner acknowledgement required');
    const proposal = this.store.proposal(id);
    if (!proposal || !this.store.handoff(id) || !this.repositories().includes(proposal.repository)) throw new Error('Unknown approved proposal task');
    if (!acceptance.trim() || acceptance.length > 1200 || !artifact.startsWith(`https://github.com/${proposal.repository}/`)) throw new Error('Repository artifact and explicit acceptance result required');
    this.store.acknowledgeOutcome(id, { state, actor, at: Date.now(), artifact, acceptance });
  }
}
