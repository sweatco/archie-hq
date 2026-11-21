// SPDX-License-Identifier: AGPL-3.0-or-later
/** Incoming events dispatcher: hands committed deliveries to consumers, each under a lease another process can take over. */
import { logger } from '../system/logger.js';
import type { ClaimedHandoff, IncomingStore } from './store.js';
import type { IncomingConsumer } from './types.js';

const LEASE_LOST = 'lost its lease; nothing recorded';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DispatchPolicy {
  /** How long one attempt may take before it counts as failed. */
  leaseMs: number;
  /** The wait before each retry; the attempt after the last entry is final. */
  retryDelaysMs: readonly number[];
  pollMs: number;
  sweepEveryMs: number;
  handoffMaxAgeMs: number;
  /** Also the window in which a repeated event key is recognised. */
  receiptRetentionMs: number;
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  leaseMs: 5 * MINUTE,
  retryDelaysMs: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  pollMs: 1000,
  sweepEveryMs: HOUR,
  handoffMaxAgeMs: 7 * DAY,
  receiptRetentionMs: 30 * DAY,
};

export class IncomingDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private delivering: Promise<void> | undefined;
  private stopped = false;
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: IncomingStore,
    private readonly consumers: readonly IncomingConsumer[],
    private readonly policy: DispatchPolicy = DEFAULT_DISPATCH_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      // A pass in flight already reports its own failure.
      if (this.delivering) return;
      this.runOnce().catch((error: unknown) => {
        logger.error('incoming', 'Incoming dispatcher pass failed', error);
      });
    }, this.policy.pollMs);
    this.timer.unref();
  }

  /** Final. Resolves when the attempt in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    // A failed pass has already been reported to whoever started it.
    await this.delivering?.catch(() => undefined);
  }

  /** Delivers every due handoff; concurrent calls share one pass. */
  runOnce(): Promise<void> {
    this.delivering ??= this.deliverDue().finally(() => {
      this.delivering = undefined;
    });
    return this.delivering;
  }

  private async deliverDue(): Promise<void> {
    while (!this.stopped) {
      this.sweepIfDue();
      const claimed = this.store.claimHandoff(this.clock(), this.policy.leaseMs);
      if (!claimed) return;
      await this.deliver(claimed);
      // Yields to the event loop so the HTTP receiver keeps answering during a backlog.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private sweepIfDue(): void {
    const now = this.clock();
    if (now - this.sweptAt < this.policy.sweepEveryMs) return;
    // Marked before it runs, so a failing sweep waits for the next interval.
    this.sweptAt = now;
    try {
      const { failed, purged } = this.store.sweep(
        now,
        now - this.policy.handoffMaxAgeMs,
        now - this.policy.receiptRetentionMs,
      );
      if (failed + purged > 0)
        logger.system(`Incoming sweep: failed ${failed} stale handoffs, purged ${purged} receipts`);
    } catch (error) {
      // Deliveries continue when housekeeping fails.
      logger.error('incoming', 'Incoming sweep failed', error);
    }
  }

  private async deliver(claimed: ClaimedHandoff): Promise<void> {
    const { handoff, token } = claimed;
    const label = `handoff=${handoff.id} consumer=${handoff.consumerKind}/${handoff.consumerId}`;

    let outcome: 'accepted' | 'skipped';
    try {
      outcome = await this.attempt(claimed);
    } catch (error) {
      const next = this.recordFailure(claimed);
      logger.warn(
        'incoming',
        `Incoming handoff ${next}: ${label} attempt=${handoff.attempts}`,
        error,
      );
      return;
    }

    if (this.store.finishHandoff(handoff.id, token, outcome))
      logger.system(`Incoming handoff ${outcome}: ${label}`);
    else logger.warn('incoming', `Incoming handoff ${LEASE_LOST}: ${label}`);
  }

  /** Records a failed attempt and says what becomes of the handoff. */
  private recordFailure({ handoff, token }: ClaimedHandoff): string {
    const retryIn = this.policy.retryDelaysMs[handoff.attempts - 1];
    if (retryIn === undefined)
      return this.store.finishHandoff(handoff.id, token, 'failed') ? 'failed for good' : LEASE_LOST;
    const released = this.store.releaseHandoff(handoff.id, token, this.clock() + retryIn);
    if (released === 'retry') return `retries in ${retryIn} ms`;
    return released === 'cancelled' ? 'cancelled with its input paused or deleted' : LEASE_LOST;
  }

  private async attempt({ handoff, token, body }: ClaimedHandoff): Promise<'accepted' | 'skipped'> {
    // A crash during the last allowed attempt leaves the handoff pending with its attempts used up.
    if (handoff.attempts > this.policy.retryDelaysMs.length + 1)
      throw new Error('Interrupted during its last attempt');
    const consumer = this.consumers.find((candidate) => candidate.kind === handoff.consumerKind);
    if (!consumer) throw new Error(`No consumer is registered for kind ${handoff.consumerKind}`);

    const work = consumer.handle({
      handoff,
      body,
      saveReservation: (reservation) => {
        if (!this.store.saveReservation(handoff.id, token, reservation))
          throw new Error('Lease lost; the reservation was not saved');
      },
    });
    return endsWithin(this.policy.leaseMs, work);
  }
}

/** Rejects when `work` is still running after `ms`; the work itself keeps running. */
function endsWithin<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Handler was still running after ${ms} ms`)), ms);
    // Lets the process exit at shutdown while a handler hangs.
    timer.unref();
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
