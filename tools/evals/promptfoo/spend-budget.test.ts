import { describe, expect, it } from 'vitest';
import { SpendBudget, type Reservation } from './spend-budget.js';

function reservedUsd(reservation: Reservation): number {
  if (!reservation.ok) throw new Error(`expected a reservation, got: ${reservation.reason}`);
  return reservation.reservedUsd;
}

describe('SpendBudget', () => {
  it('refuses a trial once what is spent leaves no room for its allowance', async () => {
    const budget = new SpendBudget(1);

    budget.settle(reservedUsd(await budget.reserve(0.4)), 0.3);
    budget.settle(reservedUsd(await budget.reserve(0.4)), 0.35);
    const third = await budget.reserve(0.4);

    expect(third).toEqual({
      ok: false,
      reason: 'spend cap reached: $0.65 of $1.00 spent, and the next trial may cost $0.40',
    });
    const summary = budget.summary();
    expect(summary).toMatchObject({ capUsd: 1, trials: 2, unmeasuredTrials: 0, refusedTrials: 1 });
    expect(summary.spentUsd).toBeCloseTo(0.65, 10);
  });

  it('raises the allowance to the costliest trial seen', async () => {
    const budget = new SpendBudget(1);
    budget.settle(reservedUsd(await budget.reserve(0.1)), 0.6);

    // 0.6 spent leaves 0.4: enough for the 0.1 estimate, not for another 0.6 trial.
    expect(await budget.reserve(0.1)).toMatchObject({ ok: false });
  });

  it('makes a trial wait while trials in flight hold the remaining room', async () => {
    const budget = new SpendBudget(1);
    const first = reservedUsd(await budget.reserve(0.4));
    const second = reservedUsd(await budget.reserve(0.4));

    let third: Reservation | undefined;
    const waiting = budget.reserve(0.4).then((reservation) => (third = reservation));
    await Promise.resolve();
    expect(third).toBeUndefined();

    budget.settle(first, 0.2);
    await waiting;
    expect(third).toEqual({ ok: true, reservedUsd: 0.4 });

    budget.settle(second, 0.2);
    budget.settle(0.4, 0.2);
    expect(budget.summary().spentUsd).toBeCloseTo(0.6, 10);
  });

  it('counts a trial with no recorded cost at its reservation', async () => {
    const budget = new SpendBudget(1);
    budget.settle(reservedUsd(await budget.reserve(0.5)), null);

    expect(budget.summary()).toMatchObject({ spentUsd: 0.5, trials: 1, unmeasuredTrials: 1 });
  });

  it('gives a reservation back when the trial never started a task', async () => {
    const budget = new SpendBudget(0.5);
    budget.release(reservedUsd(await budget.reserve(0.5)));

    expect(await budget.reserve(0.5)).toEqual({ ok: true, reservedUsd: 0.5 });
    expect(budget.summary()).toMatchObject({ spentUsd: 0, trials: 0 });
  });
});
