/**
 * Tests for the trigger scheduler's pure helpers — cron next-run computation
 * (including a DST boundary) and the ≥1h recurring-interval floor.
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, validateRecurringInterval, MIN_RECURRING_INTERVAL_MS, describeSchedule, friendlyTz } from '../trigger-scheduler.js';

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

  it('rejects a sub-hour gap even when the first inter-run gap is wide', () => {
    // 9:00 and 9:30 daily: the 9:00→9:30 gap (30m) is below the floor, even
    // though 9:30→next-day-9:00 is ~23.5h. The tightest-gap check must catch it.
    expect(validateRecurringInterval('0,30 9 * * *', 'UTC').ok).toBe(false);
  });

  it('accepts two daily runs that are ≥1h apart', () => {
    expect(validateRecurringInterval('0 9,18 * * *', 'UTC').ok).toBe(true);
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

describe('friendlyTz', () => {
  it('maps IANA zones to a city label', () => {
    expect(friendlyTz('Europe/London')).toBe('London time');
    expect(friendlyTz('America/New_York')).toBe('New York time');
  });
  it('keeps UTC as-is', () => {
    expect(friendlyTz('UTC')).toBe('UTC');
  });
});

describe('describeSchedule (cron → plain English)', () => {
  it('daily at a time', () => {
    expect(describeSchedule('0 9 * * *', 'Europe/London')).toBe('every day at 9:00 AM (London time)');
  });
  it('afternoon time in 12h clock (min=10, hour=15 → 3:10 PM)', () => {
    expect(describeSchedule('10 15 * * *', 'Europe/London')).toBe('every day at 3:10 PM (London time)');
  });
  it('weekdays', () => {
    expect(describeSchedule('0 9 * * 1-5', 'UTC')).toBe('every weekday at 9:00 AM (UTC)');
  });
  it('a single weekday', () => {
    expect(describeSchedule('30 8 * * 1', 'UTC')).toBe('every Monday at 8:30 AM (UTC)');
  });
  it('multiple weekdays', () => {
    expect(describeSchedule('0 9 * * 1,3,5', 'UTC')).toBe('every Monday, Wednesday, Friday at 9:00 AM (UTC)');
  });
  it('hourly with no minute offset', () => {
    expect(describeSchedule('0 * * * *', 'UTC')).toBe('every hour');
  });
  it('hourly at a minute offset', () => {
    expect(describeSchedule('7 * * * *', 'UTC')).toBe('every hour at :07');
  });
  it('monthly on a day-of-month', () => {
    expect(describeSchedule('0 9 1 * *', 'UTC')).toBe('on the 1st of each month at 9:00 AM (UTC)');
  });
  it('midnight and noon read correctly', () => {
    expect(describeSchedule('0 0 * * *', 'UTC')).toBe('every day at 12:00 AM (UTC)');
    expect(describeSchedule('0 12 * * *', 'UTC')).toBe('every day at 12:00 PM (UTC)');
  });
  it('falls back to a generic phrase for unusual crons (never shows raw cron)', () => {
    const out = describeSchedule('5 4 2 5 1', 'UTC');
    expect(out).not.toContain('5 4 2 5 1');
  });
});
