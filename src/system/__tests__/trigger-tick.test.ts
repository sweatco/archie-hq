/**
 * Tests for planTick — the pure per-tick planning step of the firing engine.
 * Covers the catch-up rule (M1) and per-condition expiry + dedupe (M2).
 */

import { describe, it, expect } from 'vitest';
import { planTick } from '../trigger-scheduler.js';
import type { Trigger, TriggerCondition } from '../../types/trigger.js';

function trig(conditions: TriggerCondition[]): Trigger {
  return {
    id: 'trg-20260101-0900-abc123',
    status: 'enabled',
    created_by: 'U1',
    created_at: '2026-01-01T00:00:00Z',
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'general' },
    conditions,
    action: { prompt: 'do it' },
  };
}

const daily9 = (nextRunAt: string): TriggerCondition => ({
  type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: nextRunAt,
});
const oneOff = (nextRunAt: string): TriggerCondition => ({
  type: 'schedule', tz: 'UTC', next_run_at: nextRunAt,
});
const onMessage: TriggerCondition = { type: 'channel_message', channel_id: 'C1' };

describe('planTick — catch-up (M1)', () => {
  it('a recurring window missed during downtime is due, and advances to the NEXT future run (catch up once)', () => {
    // next_run_at was yesterday 09:00; now is today 09:05 — the process was down.
    const now = new Date('2026-06-25T09:05:00Z');
    const plan = planTick(trig([daily9('2026-06-24T09:00:00Z')]), now);
    expect(plan.dueCount).toBe(1);
    expect(plan.stillActive).toBe(true);
    const sched = plan.nextConditions[0] as Extract<TriggerCondition, { type: 'schedule' }>;
    // Advanced to the next future 09:00 (tomorrow) — every missed window collapses to one fire.
    expect(sched.next_run_at).toBe('2026-06-26T09:00:00.000Z');
  });

  it('a not-yet-due recurring condition is left untouched', () => {
    const now = new Date('2026-06-25T08:00:00Z');
    const plan = planTick(trig([daily9('2026-06-25T09:00:00Z')]), now);
    expect(plan.dueCount).toBe(0);
    expect(plan.stillActive).toBe(true);
    const sched = plan.nextConditions[0] as Extract<TriggerCondition, { type: 'schedule' }>;
    expect(sched.next_run_at).toBe('2026-06-25T09:00:00Z');
  });
});

describe('planTick — per-condition + dedupe (M2)', () => {
  it('a fired one-off is dropped but a sibling recurring survives', () => {
    const now = new Date('2026-06-25T09:05:00Z');
    const plan = planTick(trig([oneOff('2026-06-25T09:00:00Z'), daily9('2026-06-25T09:00:00Z')]), now);
    expect(plan.dueCount).toBe(2); // both due this tick...
    // ...but only the recurring remains, advanced; the one-off is gone.
    expect(plan.nextConditions).toHaveLength(1);
    const sched = plan.nextConditions[0] as Extract<TriggerCondition, { type: 'schedule' }>;
    expect(sched.cron).toBe('0 9 * * *');
    expect(sched.next_run_at).toBe('2026-06-26T09:00:00.000Z');
    expect(plan.stillActive).toBe(true);
  });

  it('a lone one-off leaves the trigger spent (pause)', () => {
    const now = new Date('2026-06-25T09:05:00Z');
    const plan = planTick(trig([oneOff('2026-06-25T09:00:00Z')]), now);
    expect(plan.dueCount).toBe(1);
    expect(plan.nextConditions).toHaveLength(0);
    expect(plan.stillActive).toBe(false);
  });

  it('a channel_message condition keeps the trigger active after a one-off fires', () => {
    const now = new Date('2026-06-25T09:05:00Z');
    const plan = planTick(trig([oneOff('2026-06-25T09:00:00Z'), onMessage]), now);
    expect(plan.dueCount).toBe(1);
    expect(plan.nextConditions).toEqual([onMessage]);
    expect(plan.stillActive).toBe(true);
  });

  it('reports due count so the caller fires once even when multiple conditions coincide', () => {
    const now = new Date('2026-06-25T09:05:00Z');
    const plan = planTick(trig([daily9('2026-06-25T09:00:00Z'), daily9('2026-06-25T09:00:00Z')]), now);
    expect(plan.dueCount).toBe(2); // caller uses dueCount>0 → exactly one fire
    expect(plan.nextConditions).toHaveLength(2); // both advanced
  });
});
