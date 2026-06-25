/**
 * Unit tests for TaskStatusController — the rendering rules behind the single
 * "Archie is …" Slack indicator: PM precedence, single-specialist specific
 * action, multi-specialist domain aggregation, debounce/de-dup, no handoff
 * flicker, and clear-on-stop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TaskStatusController } from '../status.js';

describe('TaskStatusController', () => {
  let pushed: string[];
  let ctl: TaskStatusController;

  beforeEach(() => {
    vi.useFakeTimers();
    pushed = [];
    ctl = new TaskStatusController((s) => pushed.push(s));
  });

  afterEach(() => {
    ctl.dispose();
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTime(900);

  it('shows the PM action when the PM is active', () => {
    ctl.setActive('pm-agent', true, '');
    flush();
    expect(pushed).toEqual(['is working on this…']);
  });

  it('shows a specific PM action from a note', () => {
    ctl.note('pm-agent', true, '', 'checking Jira');
    flush();
    expect(pushed.at(-1)).toBe('is checking Jira…');
  });

  it('shows a single specialist’s specific action', () => {
    ctl.note('backend-agent', false, 'backend', 'digging into the backend');
    flush();
    expect(pushed.at(-1)).toBe('is digging into the backend…');
  });

  it('aggregates several specialists by domain, never naming them', () => {
    ctl.setActive('backend-agent', false, 'backend');
    ctl.setActive('mobile-agent', false, 'mobile');
    flush();
    expect(pushed.at(-1)).toBe('is checking backend and mobile…');
  });

  it('lets the PM take precedence over an active specialist', () => {
    ctl.setActive('backend-agent', false, 'backend');
    ctl.setActive('pm-agent', true, '');
    flush();
    expect(pushed.at(-1)).toBe('is working on this…');
  });

  it('debounces and de-dupes repeated identical activity', () => {
    ctl.note('backend-agent', false, 'backend', 'digging into the backend');
    ctl.note('backend-agent', false, 'backend', 'digging into the backend');
    flush();
    expect(pushed).toEqual(['is digging into the backend…']);
  });

  it('keeps the indicator during a handoff (no active agent) rather than flickering', () => {
    ctl.setActive('pm-agent', true, '');
    flush();
    expect(pushed.at(-1)).toBe('is working on this…');

    // PM delegated and went idle; the specialist has not picked up yet.
    ctl.setIdle('pm-agent');
    flush();
    expect(pushed).toEqual(['is working on this…']); // unchanged — not cleared
  });

  it('clears the indicator on stop/complete', () => {
    ctl.setActive('backend-agent', false, 'backend');
    flush();
    expect(pushed.at(-1)).toBe('is working on the backend…');

    ctl.clear();
    expect(pushed.at(-1)).toBe('');
  });

  it('re-shows the status after a post if work continues', () => {
    ctl.note('backend-agent', false, 'backend', 'digging into the backend');
    flush();
    expect(pushed.at(-1)).toBe('is digging into the backend…');

    // PM posted an interim message — Slack auto-cleared the shimmer. The next
    // render should re-push because the specialist is still working.
    ctl.notePosted();
    flush();
    expect(pushed.at(-1)).toBe('is digging into the backend…');
  });
});
