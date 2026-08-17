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

function renderList(refreshTrigger = 0, active = false) {
  return render(
    <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={refreshTrigger} active={active} />,
  );
}

/**
 * The invariant the bug violated: a counted header must never appear without
 * at least one task row beneath it. Independent of *why* the rows are there
 * (freshly fetched or retained from before a failed refresh).
 */
function assertNoBareHeader(frame: string) {
  if (/Tasks \(\d+\)/.test(frame)) {
    expect(frame).toMatch(/\[[+\-?\S]\]\s+task-\d+/);
  }
}

/** Serves pages out of a live array, so tests can prepend and refresh. */
function serveFrom(list: ReturnType<typeof task>[]) {
  return async ({ offset }: { offset: number }) => ({
    tasks: list.slice(offset, offset + PAGE_SIZE),
    total: list.length,
  });
}

/** Which task the cursor (`>`) currently sits on. */
function selectedTask(frame: string): string | null {
  return frame.split('\n').find((l) => l.trimStart().startsWith('>'))?.match(/task-\d+/)?.[0] ?? null;
}

/** The task rows currently rendered, top to bottom. */
function visibleTasks(frame: string): string[] {
  return frame.split('\n').flatMap((l) => l.match(/task-\d+/) ?? []);
}

const DOWN = '\u001B[B'; // arrow-down key sequence

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

describe('TaskList', { timeout: 30_000 }, () => {
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
    // The wedge from the bug report. A refresh (any task:* SSE event) used to
    // blank the array; if page 0 then failed while `total` still said 40, the
    // visible window was all placeholders and the list rendered as `Tasks (40)`
    // with nothing beneath it. Refreshing in place keeps the previous rows on
    // screen while page 0 retries, so the window is never empty.
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
    assertNoBareHeader(lastFrame()!);
    // Rows from before the failed refresh are retained rather than blanked.
    expect(lastFrame()).toContain('task-0');

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

  describe('scroll position across refreshes', () => {
    /** Render, scroll `steps` rows down, and return the harness. */
    async function renderScrolledDown(list: ReturnType<typeof task>[], steps: number) {
      fetchTasksMock.mockImplementation(serveFrom(list));
      const h = renderList(0, true);
      await settle();
      for (let i = 0; i < steps; i++) h.stdin.write(DOWN);
      await settle();
      return h;
    }

    it('keeps the same task selected and on screen when a task is prepended', async () => {
      const list = Array.from({ length: 60 }, (_, i) => task(i));
      const { lastFrame, rerender, stdin, unmount } = await renderScrolledDown(list, 25);

      const anchored = selectedTask(lastFrame()!);
      const windowBefore = visibleTasks(lastFrame()!);
      expect(anchored).not.toBe('task-0'); // genuinely scrolled away from the top

      // A task:* SSE event: the API prepends the new task (newest-first) and
      // App bumps refreshTrigger.
      list.unshift(task(999));
      rerender(
        <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={1} active={true} />,
      );
      await settle();

      // The list grew and the data refreshed...
      expect(lastFrame()).toContain('Tasks (61)');
      // ...but the viewport did not move: same selection, same rows on screen.
      expect(selectedTask(lastFrame()!)).toBe(anchored);
      expect(visibleTasks(lastFrame()!)).toEqual(windowBefore);
      expect(lastFrame()).not.toContain('task-999'); // the new task is above, off screen

      void stdin;
      unmount();
    });

    it('holds position across a refresh that adds nothing (returning from detail)', async () => {
      // App.handleBack() bumps refreshTrigger on every return from the detail
      // view, which used to snap the list back to the top.
      const list = Array.from({ length: 60 }, (_, i) => task(i));
      const { lastFrame, rerender, unmount } = await renderScrolledDown(list, 25);

      const anchored = selectedTask(lastFrame()!);
      const windowBefore = visibleTasks(lastFrame()!);

      rerender(
        <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={1} active={true} />,
      );
      await settle();

      expect(selectedTask(lastFrame()!)).toBe(anchored);
      expect(visibleTasks(lastFrame()!)).toEqual(windowBefore);
      unmount();
    });

    it('stays pinned to the top so new tasks are visible when not scrolled', async () => {
      const list = Array.from({ length: 60 }, (_, i) => task(i));
      fetchTasksMock.mockImplementation(serveFrom(list));
      const { lastFrame, rerender, unmount } = renderList(0, true);
      await settle();
      expect(visibleTasks(lastFrame()!)[0]).toBe('task-0');

      list.unshift(task(999));
      rerender(
        <TaskList onSelect={() => {}} onCreate={() => {}} refreshTrigger={1} active={true} />,
      );
      await settle();

      // At the top the newest task should appear rather than be scrolled past.
      expect(visibleTasks(lastFrame()!)[0]).toBe('task-999');
      unmount();
    });
  });

  it('still reports a genuinely empty list as "No tasks found"', async () => {
    fetchTasksMock.mockResolvedValue({ tasks: [], total: 0 });

    const { lastFrame, unmount } = renderList();
    await settle();

    expect(lastFrame()).toContain('No tasks found');
    unmount();
  });
});
