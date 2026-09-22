/**
 * Unit tests for TaskStatusController — the rendering rules behind the single
 * "Archie is …" indicator: the current action wins, debounce/de-dup, no
 * flicker between turns, keepalive, suspend, and clear-on-stop.
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

  it('shows a generic line when the agent is active with no specific action', () => {
    ctl.setActive();
    flush();
    expect(pushed).toEqual(['is working on this…']);
  });

  it('shows the specific action from a note', () => {
    ctl.note('checking Jira');
    flush();
    expect(pushed.at(-1)).toBe('is checking Jira…');
  });

  it('debounces and de-dupes repeated identical activity', () => {
    ctl.note('going through the details');
    ctl.note('going through the details');
    flush();
    expect(pushed).toEqual(['is going through the details…']);
  });

  it('keeps the indicator between turns rather than flickering', () => {
    ctl.setActive();
    flush();
    expect(pushed.at(-1)).toBe('is working on this…');

    // Turn ended, but the task has not parked — leave the indicator alone.
    ctl.setIdle();
    flush();
    expect(pushed).toEqual(['is working on this…']); // unchanged — not cleared
  });

  it('clears the indicator on stop/complete', () => {
    ctl.setActive();
    flush();
    expect(pushed.at(-1)).toBe('is working on this…');

    ctl.clear();
    expect(pushed.at(-1)).toBe('');
  });

  it('re-shows the status after a post if work continues', () => {
    ctl.note('going through the details');
    flush();
    expect(pushed.at(-1)).toBe('is going through the details…');

    // The PM posted an interim message — Slack auto-cleared the shimmer. The
    // next render should re-push because work is still under way.
    ctl.notePosted();
    flush();
    expect(pushed.at(-1)).toBe('is going through the details…');
  });

  it('re-asserts the status on an interval to beat Slack’s ~2-min timeout', () => {
    ctl.note('researching');
    flush();
    expect(pushed).toEqual(['is researching…']);

    // No new activity for a long-running tool — keepalive should re-push.
    vi.advanceTimersByTime(90_000);
    expect(pushed).toEqual(['is researching…', 'is researching…']);
    vi.advanceTimersByTime(90_000);
    expect(pushed).toEqual(['is researching…', 'is researching…', 'is researching…']);
  });

  it('freezes the indicator on suspend and ignores the turn’s wind-down', () => {
    ctl.note('putting this together');
    flush();
    expect(pushed.at(-1)).toBe('is putting this together…');

    // Turn winding down to completion — blank it now, not at turn-end.
    ctl.suspend();
    expect(pushed.at(-1)).toBe('');

    // Trailing tool calls during the wind-down must NOT resurface it...
    ctl.note('going through the details');
    flush();
    expect(pushed.at(-1)).toBe('');
    // ...and the keepalive must not re-push either.
    vi.advanceTimersByTime(300_000);
    expect(pushed.at(-1)).toBe('');
  });

  it('stops re-asserting after clear', () => {
    ctl.note('researching');
    flush();
    ctl.clear();
    const len = pushed.length; // includes the '' from clear
    expect(pushed.at(-1)).toBe('');
    vi.advanceTimersByTime(300_000);
    expect(pushed.length).toBe(len); // no keepalive pushes after clear
  });
});
