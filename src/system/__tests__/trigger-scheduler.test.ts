/**
 * Tests for the trigger scheduler's pure helpers — cron next-run computation
 * (including a DST boundary) and the ≥1h recurring-interval floor.
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, validateRecurringInterval, MIN_RECURRING_INTERVAL_MS, describeSchedule, friendlyTz, buildTriggerSeed } from '../trigger-scheduler.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import type { Trigger } from '../../types/trigger.js';

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

const trigger = (binding: Trigger['binding']): Trigger => ({
  id: 'trg-20260818-1200-abc123',
  status: 'enabled',
  created_by: 'U1',
  created_at: '2026-08-18T12:00:00Z',
  binding,
  conditions: [],
  action: { prompt: 'Summarise what changed.' },
} as Trigger);

const channelBinding = { type: 'channel', channel_id: 'C0BL', channel_name: 'bot-test' } as const;
const messageFire = { kind: 'message', thread: { channel: { id: 'C0BL', name: 'bot-test' } } } as never;

describe('buildTriggerSeed', () => {
  it('carries the trigger\'s action prompt first, whatever the fire kind', () => {
    for (const ctx of [{ kind: 'schedule' } as const, messageFire]) {
      expect(buildTriggerSeed(trigger(channelBinding), ctx).startsWith('Summarise what changed.')).toBe(true);
    }
  });

  // The message is in knowledge.log, which the PM reads at the start of every turn and
  // which is the only place a delegated specialist can see it. Nothing about it belongs in
  // this seed — not the text, and not a line telling the PM to go and read the log.
  it('says nothing about the message or the log', () => {
    const seed = buildTriggerSeed(trigger(channelBinding), messageFire);
    expect(seed).not.toContain('knowledge');
    expect(seed).not.toContain('bot-test"');
  });


  // The triggering thread is the task's default channel by the time this runs, and that is
  // where post_to_user goes on its own, so a delivery line here would restate a default.
  it('gives a message fire no delivery line at all', () => {
    expect(buildTriggerSeed(trigger(channelBinding), messageFire)).toBe('Summarise what changed.');
  });

  // A channel-bound schedule fire routes through post_to_user like everything else: the
  // fire recorded `delivery_target`, and the first post opens a thread there and links it.
  // So there is no channel id to hand the PM, and no delivery line at all.
  it('gives a channel-bound schedule fire no delivery line either', () => {
    const seed = buildTriggerSeed(trigger(channelBinding), { kind: 'schedule' });
    expect(seed).toBe('Summarise what changed.');
    expect(seed).not.toContain('C0BL');
  });

  it('adds exactly one line for the DM case, which cannot take that path yet', () => {
    expect(buildTriggerSeed(trigger({ type: 'user', user_id: 'U123ABC' }), { kind: 'schedule' }).split('\n\n')).toHaveLength(2);
  });

  it('DMs the creator for a user-bound schedule fire', () => {
    const seed = buildTriggerSeed(trigger({ type: 'user', user_id: 'U123ABC' }), { kind: 'schedule' });
    expect(seed).toContain('direct message (Slack user ID U123ABC)');
  });
});

describe('AGENT_PROMPTS.triggered', () => {
  // fireTrigger appends the delivery line to the prompt it passes in, and it is the only
  // thing that knows the fire kind. This template asserting a destination of its own is
  // how it came to say "post the result to the bound channel" directly underneath a
  // delivery line telling the agent to reply in the triggering thread.
  it('names no delivery destination of its own', () => {
    const out = AGENT_PROMPTS.triggered('do the thing', 'a scheduled run');
    for (const claim of ['bound channel', 'default channel', 'direct message', 'thread', 'read-only']) {
      expect(out).not.toContain(claim);
    }
  });

  it('is the reason and the seed, and nothing else', () => {
    expect(AGENT_PROMPTS.triggered('do the thing', 'a scheduled run')).toBe(
      'A trigger you were set up with has fired (a scheduled run).\n\nDo this now: do the thing',
    );
  });
});
