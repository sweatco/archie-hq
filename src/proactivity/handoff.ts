// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
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
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class HandoffRejection extends Error {}

export class ProposalHandoff {
  private readonly access: SourceAccess;
  private readonly cardWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly store: InitiativeStore,
    private readonly slack: ProposalSlack,
    private readonly repositories: () => string[],
    private readonly refresh: (source: {
      channel: string;
      thread: string;
    }) => Promise<ThreadSnapshot | null>,
    private readonly tasks: ApprovedTaskRuntime = ordinaryTasks,
  ) {
    this.access = new SourceAccess(store, slack);
  }

  private async current(
    proposal: CapabilityProposal,
    recipient: string,
    refresh: boolean,
  ): Promise<{ status: 'available' | 'deferred' | 'stale'; reason: string }> {
    if (this.store.matter(proposal.matter)?.owner !== recipient)
      return { status: 'stale', reason: 'Responsible employee changed' };
    if (!this.repositories().includes(proposal.repository))
      return { status: 'stale', reason: 'Repository scope changed' };
    if (!this.store.proposalCurrent(proposal, Date.now(), false)) {
      const matter = this.store.matter(proposal.matter);
      // Channel access loss invalidates derived matters until extraction revalidates them.
      const unchanged = proposal.evidence.every((id) => {
        const revision = this.store.attention.revision(id);
        return (
          revision?.excerpt &&
          this.store.attention.currentMessage(revision.channel, revision.ts)?.id === id
        );
      });
      return matter?.state === 'open' && !matter.valid && unchanged
        ? { status: 'deferred', reason: 'Matter is awaiting source revalidation' }
        : { status: 'stale', reason: 'Proposal evidence or work context changed' };
    }
    const sources = this.store.proposalSources(proposal.id);
    for (const source of sources) {
      const access = await this.access.evaluate(source.channel, recipient);
      if (access !== 'allowed')
        return {
          status: access === 'unavailable' ? 'deferred' : 'stale',
          reason: 'Source access could not be verified',
        };
      if (refresh) {
        const snapshot = await this.refresh(source);
        if (!snapshot || snapshot.gap)
          return { status: 'deferred', reason: 'Complete current source context is unavailable' };
      }
    }
    return sources.length > 0 &&
      this.store.matter(proposal.matter)?.owner === recipient &&
      this.store.proposalCurrent(proposal, Date.now(), false)
      ? { status: 'available', reason: 'Current source revisions and access verified' }
      : { status: 'stale', reason: 'Source revisions changed or expired' };
  }

  async present(now: number): Promise<void> {
    if (!notificationWindow(now)) return;
    const page = this.store.pendingProposalIds(this.store.setting('proposal_cursor'));
    for (const id of page) {
      this.store.set('proposal_cursor', id);
      const proposal = this.store.proposal(id);
      if (!proposal || this.store.handoff(proposal.id)) continue;
      const recipient = this.store.matter(proposal.matter)?.owner;
      if (!recipient) continue;
      const version = proposalVersion(proposal);
      const previous = this.store.delivery(`proposal:${proposal.id}:${version}:${recipient}`);
      if (previous && previous.state !== 'cancelled') continue;
      if ((await this.current(proposal, recipient, false)).status !== 'available') continue;
      const sources = this.store.proposalSources(proposal.id);
      const text = `Task suggestion: ${proposal.outcome}\nRepository: ${proposal.repository}\n\n${sources.map((source) => this.slack.link(source.channel, source.thread)).join('\n')}\n\nStart task launches one ordinary Archie task using normal task budgeting, outside the $200/day background allowance. Edit mode and GitHub writes still require their normal approvals.`;
      this.store.enqueueDelivery({
        id: `proposal:${proposal.id}:${version}:${recipient}`,
        recipient,
        channel: await this.slack.dm(recipient),
        thread: null,
        text,
        matters: [],
        evidence: proposal.evidence,
        digest: false,
        state: 'pending',
        ts: null,
        created: now,
        proposal: { id: proposal.id, version },
      });
    }
    if (page.length < 20) this.store.set('proposal_cursor', '');
  }

  async approve(actor: string, deliveryId: string, version: string): Promise<TaskHandoffRecord> {
    const delivery = this.store.delivery(deliveryId);
    if (!delivery?.proposal) throw new HandoffRejection('Proposal action is unavailable or stale');
    if (delivery.recipient !== actor || !this.store.deliveryRecipientCurrent(delivery))
      throw new HandoffRejection('Only the responsible employee may start this proposal task');
    if (
      delivery.state !== 'sent' ||
      !delivery.ts ||
      delivery.proposal.version !== version ||
      !(await this.slack.verifyDm(delivery.channel, actor))
    )
      throw new HandoffRejection('Proposal action is unavailable or stale');
    const previous = this.store.handoff(delivery.proposal.id);
    if (previous) {
      if (
        previous.actor !== actor ||
        previous.version !== version ||
        previous.delivery !== deliveryId
      )
        throw new HandoffRejection('Proposal approval has changed');
      this.queueCard(previous.proposal);
      await this.continue(previous);
      const updated = this.store.handoff(previous.proposal);
      assert(updated, 'Approved handoff disappeared while continuing it');
      return updated;
    }
    const proposal = this.store.proposal(delivery.proposal.id);
    if (!proposal || proposalVersion(proposal) !== version)
      throw new HandoffRejection('The proposal version changed; request a fresh proposal.');
    const validation = await this.current(proposal, actor, true);
    if (validation.status !== 'available')
      throw new HandoffRejection(
        validation.reason + '; request a fresh proposal or retry after access recovers.',
      );
    const team = this.store.setting('team');
    assert(team, 'Initiative store is missing its workspace identity');
    const record = this.store.approveHandoff({
      proposal: proposal.id,
      version,
      actor,
      approved: Date.now(),
      task: proposalTaskId(team, proposal.id),
      state: 'approved',
      budget: 'task',
      delivery: delivery.id,
    });
    this.queueCard(record.proposal);
    await this.continue(record);
    const updated = this.store.handoff(proposal.id);
    assert(updated, 'Approved handoff disappeared while continuing it');
    return updated;
  }

  private async continue(record: TaskHandoffRecord): Promise<void> {
    await starts(record.proposal, async () => {
      const token = this.store.claimHandoff(record.proposal, Date.now());
      if (!token) return;
      let state: TaskHandoffRecord['state'] | undefined;
      try {
        const existing = await this.tasks.read(record.task);
        if (
          existing?.approved_start?.phase === 'ready' &&
          existing.approved_start.correlation === `initiative:${record.proposal}` &&
          existing.approved_start.version === record.version &&
          existing.approved_start.actor === record.actor
        ) {
          state = 'activated';
          return;
        }
        const delivery = this.store.delivery(record.delivery);
        const proposal = this.store.proposal(record.proposal);
        if (
          !delivery?.ts ||
          !proposal ||
          proposalVersion(proposal) !== record.version ||
          delivery.recipient !== record.actor ||
          !(await this.slack.verifyDm(delivery.channel, record.actor))
        ) {
          state = 'stale';
          return;
        }
        const source = await this.current(proposal, record.actor, true);
        if (source.status !== 'available') {
          if (source.status === 'stale') state = 'stale';
          return;
        }
        const evidence = this.store.proposalSources(proposal.id).flatMap((source) => {
          const snapshot = this.store.snapshot(source.channel, source.thread);
          return (snapshot?.evidence ?? [])
            .filter((item) => proposal.evidence.includes(item.id))
            .map(
              (item) =>
                `Evidence ${item.id} (revision ${item.version})\nSource: ${this.slack.link(item.channel, item.thread)}\n${item.text}`,
            );
        });
        const brief = `The responsible employee explicitly approved starting the scoped proposal below. Normal task budgeting applies. Existing edit-mode and external-action approvals still apply. Starting or parking this task does not establish that the feature is implemented or released.\n<proposal_evidence untrusted="true">${escape(proposal.outcome)}</proposal_evidence>`;
        await this.tasks.prepare({
          taskId: record.task,
          correlation: `initiative:${proposal.id}`,
          version: record.version,
          actor: record.actor,
          brief,
          evidence: `Repository: ${proposal.repository}\nIntended result: ${proposal.outcome}\n\n${evidence.join('\n\n')}`,
          destination: {
            channel: delivery.channel,
            thread: delivery.ts,
            name: 'Approved proposal discussion',
          },
        });
        if (!this.store.prepareHandoff(record.proposal, token)) return;
        const refreshed = await this.current(proposal, record.actor, true);
        if (refreshed.status !== 'available') {
          if (refreshed.status === 'stale') state = 'stale';
          return;
        }
        await this.tasks.start(record.task);
        state = 'activated';
      } catch (error) {
        const metadata = await this.tasks.read(record.task);
        if (
          metadata?.approved_start?.phase === 'ready' &&
          metadata.approved_start.correlation === `initiative:${record.proposal}` &&
          metadata.approved_start.version === record.version &&
          metadata.approved_start.actor === record.actor
        )
          state = 'activated';
        throw error;
      } finally {
        this.store.finishHandoff(record.proposal, token, state);
        this.queueCard(record.proposal);
      }
    });
  }

  async recover(): Promise<void> {
    for (const record of this.store.pendingHandoffs()) {
      try {
        await this.continue(record);
      } catch (error) {
        logger.warn('initiative', 'Approved task recovery deferred', error);
      }
    }
    for (const record of this.store.pendingHandoffCards(Date.now()))
      this.queueCard(record.proposal);
  }

  private queueCard(id: string): void {
    if (this.cardWrites.has(id)) return;
    // Card IO is serialized independently: a slow Starting edit cannot delay
    // activation or land after the final edit. SQLite retains failed edits.
    const writing = cards(`${this.store.setting('team')}:${id}`, async () => {
      for (;;) {
        const record = this.store.handoff(id);
        if (
          !record ||
          record.card_state === cardState(record) ||
          (record.card_retry ?? 0) > Date.now()
        )
          return;
        const lease = this.store.claimHandoffCard(id, Date.now());
        if (!lease) return;
        const state = cardState(record);
        try {
          const delivery = this.store.delivery(record.delivery);
          if (
            !delivery?.ts ||
            delivery.recipient !== record.actor ||
            !(await this.slack.verifyDm(delivery.channel, record.actor))
          )
            throw new Error('Approved proposal card unavailable');
          const status =
            state === 'activated'
              ? `Task started: ${record.task}. Its outcome remains unverified.`
              : state === 'stale'
                ? 'Approval is stale; no prepared task was activated. Request a fresh proposal.'
                : 'Starting… Approval saved; task preparation is pending.';
          await this.slack.updateProposal(
            delivery,
            status,
            state === 'activated' ? this.slack.link(delivery.channel, delivery.ts) : undefined,
          );
          this.store.finishHandoffCard(id, state, lease);
        } catch (error) {
          this.store.finishHandoffCard(id, state, lease, Date.now() + 60_000);
          throw error;
        }
      }
    })
      .catch((error) => {
        logger.warn('initiative', 'Proposal card update deferred', error);
      })
      .finally(() => {
        this.cardWrites.delete(id);
        const record = this.store.handoff(id);
        if (
          record &&
          record.card_state !== cardState(record) &&
          (record.card_retry ?? 0) <= Date.now()
        )
          this.queueCard(id);
      });
    this.cardWrites.set(id, writing);
  }

  async drainCards(): Promise<void> {
    while (this.cardWrites.size) await Promise.all(this.cardWrites.values());
  }

  async describe(id: string, actor: string) {
    const proposal = this.store.proposal(id);
    if (!proposal || this.store.matter(proposal.matter)?.owner !== actor)
      throw new Error('Proposal unavailable');
    const validation = await this.current(proposal, actor, false);
    const saved = this.store.handoff(id);
    const handoff = saved?.actor === actor ? saved : null;
    const metadata = handoff ? await this.tasks.read(handoff.task) : null;
    const delivery = handoff ? this.store.delivery(handoff.delivery) : null;
    return {
      proposal:
        validation.status === 'available'
          ? proposal
          : { id, sourceState: validation.status, explanation: validation.reason },
      handoff,
      runtime: taskRuntimeState(metadata),
      outcome: 'unverified',
      conversation: delivery?.ts ? this.slack.link(delivery.channel, delivery.ts) : undefined,
    };
  }
}
