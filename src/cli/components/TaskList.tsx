import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { fetchTasks } from '../api.js';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

interface TaskSummary {
  task_id: string;
  status: string;
  task_owner: string | null;
  participants: string[];
  created_at: string;
  updated_at: string;
  title: string | null;
  channel_name: string | null;
  reminder: { trigger_at: string; reason: string } | null;
  agents?: { agentId: string; active: boolean }[];
}

interface TaskListProps {
  onSelect: (taskId: string) => void;
  onCreate: () => void;
  refreshTrigger: number;
  active: boolean;
}

const PAGE_SIZE = 20;
const PREFETCH_BUFFER = 10;
// How long to wait before retrying a page whose fetch failed (server restart,
// transient network error). Without a retry, a failed page leaves a permanent
// gap in the list — most visibly an all-empty page 0, which renders as a bare
// header with no rows.
const RETRY_DELAY_MS = 1500;

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'in_progress': return <Text color="yellow">[<Spinner type="dots" />]</Text>;
    case 'completed': return <Text color="green">[+]</Text>;
    case 'stopped': return <Text color="red">[-]</Text>;
    default: return <Text color="gray">[?]</Text>;
  }
}

export function TaskList({ onSelect, onCreate, refreshTrigger, active }: TaskListProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  // Reserve lines for: title bar (1) + header with margin (2) + status bar (1)
  const visibleRows = Math.max(1, termHeight - 4);

  const [allTasks, setAllTasks] = useState<TaskSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryTick, setRetryTick] = useState(0);
  const fetchedPages = useRef(new Set<number>());
  const fetchingPages = useRef(new Set<number>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every refresh. A fetch started under an old generation must not
  // write into the array (or mutate the page-tracking sets) belonging to a
  // newer generation — otherwise a stale, in-flight response can repopulate a
  // freshly-reset list out of order.
  const generation = useRef(0);

  // Schedule a single debounced retry. Failed pages are left unmarked so the
  // prefetch effect re-attempts them when this fires.
  const scheduleRetry = useCallback(() => {
    if (retryTimer.current) return;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setRetryTick((n) => n + 1);
    }, RETRY_DELAY_MS);
  }, []);

  const loadPage = useCallback(async (page: number) => {
    if (fetchedPages.current.has(page) || fetchingPages.current.has(page)) return;
    const gen = generation.current;
    fetchingPages.current.add(page);
    try {
      const { tasks, total: t } = await fetchTasks({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      if (gen !== generation.current) return; // superseded by a refresh — discard
      fetchedPages.current.add(page);
      setTotal(t);
      setAllTasks((prev) => {
        const next = [...prev];
        // Ensure array is large enough
        while (next.length < page * PAGE_SIZE + tasks.length) {
          next.push(undefined as any);
        }
        for (let i = 0; i < tasks.length; i++) {
          next[page * PAGE_SIZE + i] = tasks[i];
        }
        return next;
      });
      setError(null);
      if (page === 0) setLoading(false);
    } catch (err) {
      if (gen !== generation.current) return; // superseded — ignore
      // Leave the page unmarked so it is retried. Only surface an error when
      // page 0 fails, since that is what leaves the list with nothing to show.
      if (page === 0) {
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      }
      scheduleRetry();
    } finally {
      // Only the owning generation may clear the marker, so a stale fetch can't
      // delete the tracking entry of a fetch started after a refresh.
      if (gen === generation.current) fetchingPages.current.delete(page);
    }
  }, [scheduleRetry]);

  // Initial load + reset on refresh
  useEffect(() => {
    generation.current += 1;
    fetchedPages.current.clear();
    fetchingPages.current.clear();
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setAllTasks([]);
    setTotal(0);
    setCursor(0);
    setScrollTop(0);
    setError(null);
    setLoading(true);
    loadPage(0);
  }, [refreshTrigger, loadPage]);

  // Fetch (and retry) every page overlapping the visible window + buffer.
  // This deliberately does NOT assume pages load contiguously from 0: it fills
  // whichever pages in range are still missing, so a page that previously
  // failed — including page 0 — gets re-fetched instead of being skipped.
  useEffect(() => {
    if (total === 0) {
      // Page 0 hasn't established the total yet (still loading or it failed).
      // Re-attempt it; loadPage de-dupes if it is already in flight.
      loadPage(0);
      return;
    }
    const needed = cursor + visibleRows + PREFETCH_BUFFER;
    const firstPage = Math.max(0, Math.floor(scrollTop / PAGE_SIZE));
    const lastPage = Math.floor(Math.min(needed, total - 1) / PAGE_SIZE);
    for (let p = firstPage; p <= lastPage; p++) {
      loadPage(p);
    }
  }, [cursor, scrollTop, total, visibleRows, retryTick, loadPage]);

  // Cancel any pending retry on unmount.
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // Keep cursor in view
  useEffect(() => {
    if (cursor < scrollTop) {
      setScrollTop(cursor);
    } else if (cursor >= scrollTop + visibleRows) {
      setScrollTop(cursor - visibleRows + 1);
    }
  }, [cursor, visibleRows, scrollTop]);

  useInput((input, key) => {
    if (!active) return;
    const step = key.meta ? 10 : 1;
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - step));
    } else if (key.downArrow) {
      const maxIndex = Math.min(allTasks.length, total) - 1;
      setCursor((c) => Math.min(maxIndex, c + step));
    } else if (key.return && allTasks.length > 0 && allTasks[cursor]) {
      onSelect(allTasks[cursor].task_id);
    } else if (input === 'n' || input === 'N') {
      onCreate();
    }
  });

  // Count real entries, not the sparse array length: a page of `undefined`
  // placeholders must not read as "tasks exist".
  const loadedCount = allTasks.filter(Boolean).length;

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>Loading tasks...</Text>
      </Box>
    );
  }

  if (error && loadedCount === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Is the Archie server running? Retrying…</Text>
      </Box>
    );
  }

  if (loadedCount === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>No tasks found</Text>
        <Text dimColor>Press <Text color="cyan" bold>n</Text> to create a new task</Text>
      </Box>
    );
  }

  const visible = allTasks.slice(scrollTop, scrollTop + visibleRows);

  return (
    <Box flexDirection="column" height={visibleRows + 2}>
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Tasks ({total})</Text>
        {total > visibleRows && <Text dimColor>  {cursor + 1}/{total}</Text>}
      </Box>
      {visible.map((task, i) => {
        if (!task) return null;
        const globalIndex = scrollTop + i;
        const selected = globalIndex === cursor;
        const activeAgents = task.agents?.filter((a) => a.active).length ?? 0;
        const channel = !task.channel_name || task.channel_name === 'cli'
          ? 'cli'
          : task.channel_name.startsWith('DM with')
            ? task.channel_name
            : `#${task.channel_name}`;

        return (
          <Box key={task.task_id} paddingX={1}>
            <Text wrap="truncate-end">
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '> ' : '  '}
              </Text>
              <StatusIcon status={task.status} />
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {' '}{task.task_id}
              </Text>
              <Text dimColor>  {channel}</Text>
              {task.title && <Text>  {task.title}</Text>}
              {activeAgents > 0 && <Text color="green">  {activeAgents} active</Text>}
              {task.reminder && <Text color="magenta">  ⏰ {formatDateTime(task.reminder.trigger_at)} — {task.reminder.reason.length > 50 ? task.reminder.reason.slice(0, 50) + '…' : task.reminder.reason}</Text>}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
