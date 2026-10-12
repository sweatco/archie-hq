/**
 * Regression tests for how the operator trigger list handles a `pending` proposal.
 *
 * `GET /api/triggers` now returns pending proposals (they used to be filtered out
 * server-side), and the component was never taught about that status. It fell
 * through to the default glyph and rendered `[?]`, reading as "unknown status";
 * pressing `[p]` on such a row called PATCH, which correctly refuses a status
 * change on an unapproved proposal, surfacing a raw `Failed to update trigger: 409`
 * from the fetch layer.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { TriggerList } from './TriggerList.js';

const { fetchTriggers, updateTrigger, deleteTrigger } = vi.hoisted(() => ({
  fetchTriggers: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
}));
vi.mock('../api.js', () => ({ fetchTriggers, updateTrigger, deleteTrigger }));

const PENDING = {
  id: 'trg-20260729-1056-pending',
  status: 'pending',
  binding_kind: 'channel',
  channel_name: 'growth-operations',
  summary: '7-day restock watch',
  created_by: 'U1',
  created_at: '2026-07-29T10:56:00.000Z',
  last_fired_at: null,
  action_prompt: 'watch stock',
};
const LIVE = { ...PENDING, id: 'trg-20260723-1401-live', status: 'enabled', summary: 'Weekday card-stock review' };

/** Let the component's load() promise settle and the frame re-render. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  updateTrigger.mockResolvedValue({});
  deleteTrigger.mockResolvedValue({});
});

describe('TriggerList — pending proposals', () => {
  it('gives a pending proposal its own glyph rather than the unknown-status [?]', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [PENDING] });

    const { lastFrame } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('trg-20260729-1056-pending');
    expect(frame).toContain('[..]');
    expect(frame).not.toContain('[?]');
  });

  it('still renders enabled rows as before', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [LIVE] });

    const { lastFrame } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();

    expect(lastFrame() ?? '').toContain('[on]');
  });

  it('explains the legend so [..] is not a mystery', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [PENDING] });

    const { lastFrame } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();

    expect(lastFrame() ?? '').toMatch(/awaiting approval/i);
  });

  it('[p] on a pending proposal explains itself instead of calling PATCH and surfacing a 409', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [PENDING] });

    const { stdin, lastFrame } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();
    stdin.write('p');
    await settle();

    expect(updateTrigger).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/awaiting approval/i);
    expect(frame).not.toMatch(/409/);
  });

  it('[p] still pauses a live trigger', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [LIVE] });

    const { stdin } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();
    stdin.write('p');
    await settle();

    expect(updateTrigger).toHaveBeenCalledWith('trg-20260723-1401-live', { status: 'paused' });
  });

  it('[d] still withdraws a pending proposal — that is the operator escape hatch', async () => {
    fetchTriggers.mockResolvedValue({ triggers: [PENDING] });

    const { stdin } = render(<TriggerList onBack={() => {}} active refreshTrigger={0} />);
    await settle();
    stdin.write('d');
    await settle();

    expect(deleteTrigger).toHaveBeenCalledWith('trg-20260729-1056-pending');
  });
});
