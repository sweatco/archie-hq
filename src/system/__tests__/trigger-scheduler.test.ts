/**
 * Tests for the trigger scheduler's pure helpers — cron next-run computation
 * (including a DST boundary) and the ≥1h recurring-interval floor.
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, validateRecurringInterval, MIN_RECURRING_INTERVAL_MS } from '../trigger-scheduler.js';

describe('computeNextRun', () => {
  it('computes the next weekday-9am run after a given instant', () => {
    // Friday 2026-06-26 10:00 UTC → next weekday 9am is Monday 2026-06-29 09:00 UTC
    const from = new Date('2026-06-26T10:00:00Z');
    const next = computeNextRun('0 9 * * 1-5', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-06-29T09:00:00.000Z');
  });

  it('computes hourly runs', () => {
    const from = new Date('2026-06-26T10:30:00Z');
    const next = computeNextRun('0 * * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-06-26T11:00:00.000Z');
  });

  it('honours timezone + DST — 9am local stays 9am across the US spring-forward', () => {
    // US DST 2026 begins Sun Mar 8. A daily 9am America/New_York job:
    //  - Sat Mar 7 fires at 14:00 UTC (EST, UTC-5)
    //  - Sun Mar 8 fires at 13:00 UTC (EDT, UTC-4) — still 9am local
    const beforeDst = computeNextRun('0 9 * * *', 'America/New_York', new Date('2026-03-07T15:00:00Z'));
    expect(beforeDst?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('returns null for an invalid cron expression', () => {
    expect(computeNextRun('not a cron', 'UTC')).toBeNull();
  });
});

describe('validateRecurringInterval (≥1h floor)', () => {
  it('rejects an every-minute schedule', () => {
    const r = validateRecurringInterval('* * * * *', 'UTC');
    expect(r.ok).toBe(false);
  });

  it('rejects an every-30-minutes schedule', () => {
    const r = validateRecurringInterval('0,30 * * * *', 'UTC');
    expect(r.ok).toBe(false);
  });

  it('accepts an hourly schedule (exactly at the floor)', () => {
    const r = validateRecurringInterval('0 * * * *', 'UTC');
    expect(r.ok).toBe(true);
  });

  it('accepts weekday-9am', () => {
    expect(validateRecurringInterval('0 9 * * 1-5', 'America/New_York').ok).toBe(true);
  });

  it('rejects an invalid cron expression with an error', () => {
    const r = validateRecurringInterval('nonsense', 'UTC');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cron/i);
  });

  it('the floor constant is one hour', () => {
    expect(MIN_RECURRING_INTERVAL_MS).toBe(60 * 60_000);
  });
});
