/**
 * Tests for planStatusChange — the pure decision behind update_trigger's
 * enabled/paused handling, including auto-resume on reschedule.
 */

import { describe, it, expect } from 'vitest';
import { planStatusChange } from '../trigger-scheduler.js';

describe('planStatusChange', () => {
  it('auto-resumes a paused trigger when it is rescheduled (new conditions, no explicit status)', () => {
    // e.g. a one-off that already fired (auto-paused) being given a new time.
    expect(planStatusChange({ currentStatus: 'paused', hasNewConditions: true })).toEqual({
      target: 'enabled', statusChange: 'resumed', autoResume: true,
    });
  });

  it('does NOT auto-resume when only the prompt/summary changed (no new conditions)', () => {
    expect(planStatusChange({ currentStatus: 'paused', hasNewConditions: false })).toEqual({
      target: 'unchanged', statusChange: null, autoResume: false,
    });
  });

  it('an explicit pause wins even when conditions are also being changed', () => {
    expect(planStatusChange({ currentStatus: 'paused', hasNewConditions: true, requestedStatus: 'paused' })).toEqual({
      target: 'unchanged', statusChange: null, autoResume: false,
    });
    expect(planStatusChange({ currentStatus: 'enabled', hasNewConditions: true, requestedStatus: 'paused' })).toEqual({
      target: 'paused', statusChange: 'paused', autoResume: false,
    });
  });

  it('an explicit resume is a normal (non-auto) resume', () => {
    expect(planStatusChange({ currentStatus: 'paused', hasNewConditions: false, requestedStatus: 'enabled' })).toEqual({
      target: 'enabled', statusChange: 'resumed', autoResume: false,
    });
  });

  it('rescheduling an already-enabled trigger changes nothing about its status', () => {
    expect(planStatusChange({ currentStatus: 'enabled', hasNewConditions: true })).toEqual({
      target: 'unchanged', statusChange: null, autoResume: false,
    });
  });

  it('is a no-op when the requested status already matches', () => {
    expect(planStatusChange({ currentStatus: 'enabled', hasNewConditions: false, requestedStatus: 'enabled' })).toEqual({
      target: 'unchanged', statusChange: null, autoResume: false,
    });
    expect(planStatusChange({ currentStatus: 'paused', hasNewConditions: false, requestedStatus: 'paused' })).toEqual({
      target: 'unchanged', statusChange: null, autoResume: false,
    });
  });
});
