/**
 * The spend cap of a live run. A trial's cost is known only after it ran, so
 * each trial first reserves an allowance and starts only if the cap still
 * covers it; the reservation is replaced by the recorded cost when the trial
 * settles.
 *
 * The allowance is the caller's estimate or the costliest trial seen so far,
 * whichever is higher. A trial that costs more than its allowance can still
 * take the run over the cap by the difference: the engine has no way to stop
 * a task at a cost.
 */

export type Reservation = { ok: true; reservedUsd: number } | { ok: false; reason: string };

export interface SpendSummary {
  capUsd: number;
  spentUsd: number;
  trials: number;
  /** Trials that ran but recorded no cost; each is counted at its reservation. */
  unmeasuredTrials: number;
  refusedTrials: number;
}

export class SpendBudget {
  private spentUsd = 0;
  private reservedUsd = 0;
  private costliestTrialUsd = 0;
  private trials = 0;
  private unmeasuredTrials = 0;
  private refusedTrials = 0;
  private settlementWaiters: (() => void)[] = [];

  constructor(readonly capUsd: number) {}

  /**
   * Set aside the next trial's allowance. Waits while trials in flight hold
   * the remaining room, since they usually settle below their reservation, and
   * refuses once what is already spent leaves no room for another trial.
   */
  async reserve(estimateUsd: number): Promise<Reservation> {
    for (;;) {
      const allowanceUsd = Math.max(estimateUsd, this.costliestTrialUsd);
      if (this.spentUsd + allowanceUsd > this.capUsd) {
        this.refusedTrials += 1;
        return {
          ok: false,
          reason:
            `spend cap reached: $${this.spentUsd.toFixed(2)} of $${this.capUsd.toFixed(2)} spent, ` +
            `and the next trial may cost $${allowanceUsd.toFixed(2)}`,
        };
      }
      if (this.spentUsd + this.reservedUsd + allowanceUsd <= this.capUsd) {
        this.reservedUsd += allowanceUsd;
        return { ok: true, reservedUsd: allowanceUsd };
      }
      await new Promise<void>((resolve) => this.settlementWaiters.push(resolve));
    }
  }

  /** Replace a reservation with what the trial cost; `null` is a trial with no recorded cost. */
  settle(reservedUsd: number, costUsd: number | null): void {
    this.reservedUsd -= reservedUsd;
    this.trials += 1;
    if (costUsd === null) {
      this.unmeasuredTrials += 1;
      this.spentUsd += reservedUsd;
    } else {
      this.spentUsd += costUsd;
      this.costliestTrialUsd = Math.max(this.costliestTrialUsd, costUsd);
    }
    for (const wake of this.settlementWaiters.splice(0)) wake();
  }

  /** Give back a reservation whose trial never started a task. */
  release(reservedUsd: number): void {
    this.reservedUsd -= reservedUsd;
    for (const wake of this.settlementWaiters.splice(0)) wake();
  }

  summary(): SpendSummary {
    return {
      capUsd: this.capUsd,
      spentUsd: this.spentUsd,
      trials: this.trials,
      unmeasuredTrials: this.unmeasuredTrials,
      refusedTrials: this.refusedTrials,
    };
  }
}
