/**
 * Unit tests for the CLI API client's approval sender.
 *
 * The merge-approval CLI regression (AC8): sendApproval previously posted only
 * {type, approve}, so a type:'merge' resolution 400'd (the API requires the PR
 * identity) and the CLI showed a blank screen. These tests pin the fix — merge
 * resolutions carry github+pr_number in the body; other types omit them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendApproval } from '../api.js';

describe('sendApproval', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bodyOf(callIndex = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('sends github/pr_number in the body for type merge (AC8 regression)', async () => {
    await sendApproval('task-123', 'merge', true, { github: 'org/backend', pr_number: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/tasks/task-123/approve');
    expect((init as RequestInit).method).toBe('POST');
    expect(bodyOf()).toEqual({
      type: 'merge',
      approve: true,
      github: 'org/backend',
      pr_number: 42,
    });
  });

  it('carries the identity on a merge denial too', async () => {
    await sendApproval('task-123', 'merge', false, { github: 'org/backend', pr_number: 7 });

    expect(bodyOf()).toEqual({
      type: 'merge',
      approve: false,
      github: 'org/backend',
      pr_number: 7,
    });
  });

  it('omits identity for non-merge types (backward compatible)', async () => {
    await sendApproval('task-123', 'edit_mode', false);

    const body = bodyOf();
    expect(body).toEqual({ type: 'edit_mode', approve: false });
    expect(body).not.toHaveProperty('github');
    expect(body).not.toHaveProperty('pr_number');
  });

  it('omits identity for a merge call with no identity passed (guards the spread)', async () => {
    await sendApproval('task-123', 'merge', true);

    const body = bodyOf();
    expect(body).toEqual({ type: 'merge', approve: true });
    expect(body).not.toHaveProperty('github');
  });
});
