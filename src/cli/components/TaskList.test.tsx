/**
 * Regression tests for the task list collapsing to a bare header.
 *
 * The list keeps tasks in a sparse array and re-fetches paginated pages on
 * every task:* SSE event. A transient failure used to be swallowed: the page
 * was never retried, and because prefetch assumed pages load contiguously from
 * 0, a missing page 0 was never re-requested. The visible window then held only
 * `undefined` placeholders, which render as nothing — the `Tasks (N)` header
 * with no rows beneath it, stuck until restart.
 *
 * These tests pin the three behaviours that fix it: failed pages retry, a
 * window of placeholders never reads as "tasks exist", and a response from
 * before a refresh cannot clobber the state that replaced it.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { TaskList } from './TaskList.js';

const { fetchTasksMock } = vi.hoisted(() => ({ fetchTasksMock: vi.fn() }));
vi.mock('../api.js', () => ({ fetchTasks: fetchTasksMock }));

const PAGE_SIZE = 20;
const RETRY_DELAY_MS = 1500;

function task(index: number) {
  return {
    task_id: `task-${index}`,
    status: 'completed',
    task_owner: null,
    participants: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    title: `Title ${index}`,
    channel_name: 'cli',
    reminder: null,
    agents: [],
  };
}

/** A page of `count` tasks starting at `offset`, out of `total` overall. */
function page(offset: number, count: number, total: number) {
  return { tasks: Array.from({ length: count }, (_, i) => task(offset + i)), total };
}

function renderList(refreshTrigger = 0) {
  return render(
    <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={refreshTrigger} active={false} />,
  );
}

/**
 * Flush pending fetches, React effects and Ink's throttled frame write.
 * Advances well short of RETRY_DELAY_MS so it never triggers a retry itself.
 */
async function settle() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10);
}

/** Advance past the debounced retry and let the resulting fetch settle. */
async function runRetry() {
  await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
  await settle();
}

describe('TaskList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchTasksMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries page 0 after a transient failure instead of staying empty forever', async () => {
    fetchTasksMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(page(0, 3, 3));

    const { lastFrame, unmount } = renderList();
    await settle();

    // The previously-dead error UI is now wired up, so the failure is visible
    // rather than silently rendering as "No tasks found".
    expect(lastFrame()).toContain('Error: fetch failed');
    expect(lastFrame()).toContain('Retrying');

    await runRetry();

    expect(fetchTasksMock).toHaveBeenCalledTimes(2);
    expect(lastFrame()).toContain('Tasks (3)');
    expect(lastFrame()).toContain('task-0');
    expect(lastFrame()).toContain('task-2');
    expect(lastFrame()).not.toContain('Error:');
    unmount();
  });

  it('never renders a header with no rows when page 0 fails after a refresh', async () => {
    // The wedge from the bug report. A refresh (any task:* SSE event) resets
    // the array; if page 0 then fails while `total` still says 40, the visible
    // window is all placeholders and the list renders as `Tasks (40)` with
    // nothing beneath it. Resetting `total` plus retrying page 0 prevents that.
    let pageZeroFails = false;
    fetchTasksMock.mockImplementation(async ({ offset }: { offset: number }) => {
      if (offset === 0 && pageZeroFails) throw new Error('page 0 unavailable');
      return page(offset, PAGE_SIZE, 40);
    });

    const { lastFrame, rerender, unmount } = renderList(0);
    await settle();
    expect(lastFrame()).toContain('Tasks (40)');
    expect(lastFrame()).toContain('task-0');

    pageZeroFails = true;
    rerender(
      <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={1} active={false} />,
    );
    await settle();
    await runRetry();

    // A header with a count but no task rows is the exact broken state.
    expect(lastFrame()).not.toMatch(/Tasks \(\d+\)/);
    expect(lastFrame()).toContain('Error: page 0 unavailable');

    pageZeroFails = false;
    await runRetry();

    expect(lastFrame()).toContain('Tasks (40)');
    expect(lastFrame()).toContain('task-0');

    const zeroOffsetCalls = fetchTasksMock.mock.calls.filter((c) => c[0].offset === 0);
    expect(zeroOffsetCalls.length).toBeGreaterThan(2);
    unmount();
  });

  it('discards a response from before a refresh so it cannot clobber the new list', async () => {
    let releaseStale: (() => void) | undefined;
    const stale = new Promise<void>((resolve) => { releaseStale = resolve; });

    fetchTasksMock
      // First mount: hangs until we release it, then resolves with old data.
      .mockImplementationOnce(async () => {
        await stale;
        return { tasks: [task(900)], total: 1 };
      })
      // After the refresh: the authoritative data.
      .mockResolvedValue({ tasks: [task(1)], total: 1 });

    const { lastFrame, rerender, unmount } = renderList(0);
    await settle();

    rerender(
      <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={1} active={false} />,
    );
    await settle();
    expect(lastFrame()).toContain('task-1');

    releaseStale!();
    await settle();

    expect(lastFrame()).toContain('task-1');
    expect(lastFrame()).not.toContain('task-900');
    unmount();
  });

  it('still reports a genuinely empty list as "No tasks found"', async () => {
    fetchTasksMock.mockResolvedValue({ tasks: [], total: 0 });

    const { lastFrame, unmount } = renderList();
    await settle();

    expect(lastFrame()).toContain('No tasks found');
    unmount();
  });
});
