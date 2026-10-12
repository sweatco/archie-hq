/**
 * The CLI reminder indicator across a recurring fire.
 *
 * This consumer is the entire justification for emitting `reminder:fired` before
 * the re-armed `reminder:set`: the fold reads `fired` as "nothing pending now"
 * (`setReminder(null)`), so with the events the other way round the ⏰ line went
 * blank for the whole interval on a reminder that was in fact armed, and only came
 * back on a manual refresh that re-read `metadata.reminder`.
 *
 * The initial fetch is left UNRESOLVED on purpose. `loadInitial` also calls
 * `setReminder(metadata.reminder ?? null)`, and it resolves after the synchronous
 * live-event fold — so letting it complete would overwrite whatever the fold
 * decided, and the test would then pass or fail on the fixture rather than on the
 * event order. With the fetch pending, the rendered indicator is the fold's output
 * alone.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { TaskDetail } from './TaskDetail.js';

const { fetchTaskDetail, fetchTaskEvents, sendMessage, sendApproval } = vi.hoisted(() => ({
  fetchTaskDetail: vi.fn(),
  fetchTaskEvents: vi.fn(),
  sendMessage: vi.fn(),
  sendApproval: vi.fn(),
}));
vi.mock('../api.js', () => ({ fetchTaskDetail, fetchTaskEvents, sendMessage, sendApproval }));

const TASK_ID = 'task-20260729-1200-abc123';
const NEXT_WAKE = '2026-08-01T17:00:00.000Z';
const CLOCK = '⏰';

type Ev = { type: string; taskId: string; data: Record<string, unknown>; timestamp: string };
let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}): Ev => ({
  type, taskId: TASK_ID, data, timestamp: `2026-08-01T05:00:0${seq++}.000Z`,
});
const armed = () => ev('reminder:set', { trigger_at: NEXT_WAKE, reason: 'offer-code check', cron: '0 5,17 * * *', tz: 'UTC' });
const fired = () => ev('reminder:fired', { reason: 'offer-code check' });

/**
 * The HEADER line only. `⏰` also prefixes the reminder entries in the scrollback
 * log, so asserting against the whole frame would pass on a log line and prove
 * nothing about the indicator this AC is actually about.
 */
async function headerFor(events: Ev[]): Promise<string> {
  const { lastFrame } = render(<TaskDetail taskId={TASK_ID} onBack={() => {}} liveEvents={events} />);
  await new Promise((r) => setTimeout(r, 30));
  const header = (lastFrame() ?? '').split('\n').find((l) => l.includes('Task:'));
  if (header === undefined) throw new Error('header line not rendered');
  return header;
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  fetchTaskDetail.mockReturnValue(new Promise(() => {})); // never resolves — see header
  fetchTaskEvents.mockReturnValue(new Promise(() => {}));
});

describe('reminder indicator across a recurring fire', () => {
  it('shows the armed wake once a reminder is set', async () => {
    // Guards the assertions below: absence must mean "cleared", not "never rendered".
    expect(await headerFor([armed()])).toContain(CLOCK);
  });

  it('stays armed when the fire is followed by the re-arm (shipped order)', async () => {
    expect(await headerFor([fired(), armed()])).toContain(CLOCK);
  });

  it('goes blank on the reverse order — this is WHY the emit order matters', async () => {
    // set → fired is the pre-fix order: the fold applies them in sequence, so the
    // last word is `fired` → setReminder(null) → no indicator for the whole interval.
    expect(await headerFor([armed(), fired()])).not.toContain(CLOCK);
  });

  it('clears for a one-shot, which fires with no re-arm behind it', async () => {
    expect(await headerFor([fired()])).not.toContain(CLOCK);
  });

  it('clears on cancellation', async () => {
    expect(await headerFor([armed(), ev('reminder:cancelled')])).not.toContain(CLOCK);
  });
});
