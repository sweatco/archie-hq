/**
 * Tests for planReminderRearm — the pure decision behind what replaces a
 * reminder that just fired.
 *
 * Why this exists: recurring monitoring used to be the agent's job, re-armed by
 * hand on every wake ("call set_reminder again with 'in 12 hours'"). Measured over
 * the 40 re-arms of task-20260617-1454-i1a08v, that produced 6 wrong intervals
 * (5x 24h and 1x 22.7h instead of 12h — silently halving the monitoring rate),
 * 37 minutes of slot drift, and 36 fires where a fixed 12h cadence over the same
 * 481h span owed 40. Moving the cadence into the runtime removes all three
 * failure modes, so the rule that does it is tested directly.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { planReminderRearm } from '../reminder-scheduler.js';

describe('planReminderRearm', () => {
  it('clears a one-shot reminder — no cron, nothing to re-arm', () => {
    expect(planReminderRearm({}, new Date('2026-07-29T05:00:00Z'))).toBeNull();
  });

  it('re-arms a recurring reminder at the next cron instant after the fire', () => {
    // 05:00 and 17:00 daily UTC; fired at 05:00 → next is 17:00 the same day.
    const out = planReminderRearm(
      { cron: '0 5,17 * * *', tz: 'UTC' },
      new Date('2026-07-29T05:00:00Z'),
    );
    expect(out?.trigger_at.toISOString()).toBe('2026-07-29T17:00:00.000Z');
    expect(out?.cron).toBe('0 5,17 * * *');
    expect(out?.tz).toBe('UTC');
  });

  it('holds a fixed slot instead of drifting from the wake time', () => {
    // The hand-rolled "in 12 hours from now" pattern drifted 37 min over 20 days.
    // A late fire must still re-arm on the scheduled slot, not 12h from the delay.
    const lateFire = new Date('2026-07-29T05:52:43Z'); // 52 min late
    const out = planReminderRearm({ cron: '0 5,17 * * *', tz: 'UTC' }, lateFire);
    expect(out?.trigger_at.toISOString()).toBe('2026-07-29T17:00:00.000Z');
  });

  it('fires once on catch-up and skips missed windows rather than replaying them', () => {
    // Process was down for two days. Re-arm lands on the next FUTURE instant, so
    // downtime costs one catch-up fire, not one fire per missed window.
    const afterDowntime = new Date('2026-07-31T06:00:00Z');
    const out = planReminderRearm({ cron: '0 5,17 * * *', tz: 'UTC' }, afterDowntime);
    expect(out?.trigger_at.toISOString()).toBe('2026-07-31T17:00:00.000Z');
  });

  it('resolves the cron in its own timezone, not the host\'s', () => {
    // 09:00 Europe/London in July is BST (UTC+1) → 08:00Z.
    const out = planReminderRearm(
      { cron: '0 9 * * *', tz: 'Europe/London' },
      new Date('2026-07-29T09:00:00Z'),
    );
    expect(out?.trigger_at.toISOString()).toBe('2026-07-30T08:00:00.000Z');
  });

  it('defaults a cron with no timezone to UTC rather than failing', () => {
    const out = planReminderRearm({ cron: '0 9 * * *' }, new Date('2026-07-29T10:00:00Z'));
    expect(out?.trigger_at.toISOString()).toBe('2026-07-30T09:00:00.000Z');
    expect(out?.tz).toBe('UTC');
  });

  it('degrades to a one-shot when the cron no longer computes', () => {
    // Never re-arm forever on a broken value — same call the trigger tick makes.
    expect(planReminderRearm({ cron: 'not-a-cron', tz: 'UTC' }, new Date())).toBeNull();
  });
});
