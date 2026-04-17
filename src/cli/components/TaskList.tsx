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
  const fetchedPages = useRef(new Set<number>());
  const fetchingPages = useRef(new Set<number>());

  const fetchPage = useCallback(async (page: number) => {
    if (fetchedPages.current.has(page) || fetchingPages.current.has(page)) return;
    fetchingPages.current.add(page);
    try {
      const { tasks, total: t } = await fetchTasks({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
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
    } finally {
      fetchingPages.current.delete(page);
    }
  }, []);

  // Initial load + reset on refresh
  useEffect(() => {
    fetchedPages.current.clear();
    fetchingPages.current.clear();
    setAllTasks([]);
    setCursor(0);
    setScrollTop(0);
    setLoading(true);
    fetchPage(0).finally(() => setLoading(false));
  }, [refreshTrigger, fetchPage]);

  // Prefetch pages to cover visible area + buffer ahead of cursor
  useEffect(() => {
    const needed = cursor + visibleRows + PREFETCH_BUFFER;
    const loadedCount = allTasks.filter(Boolean).length;
    if (loadedCount < total) {
      const startPage = Math.floor(loadedCount / PAGE_SIZE);
      const endPage = Math.floor(Math.min(needed, total - 1) / PAGE_SIZE);
      for (let p = startPage; p <= endPage; p++) {
        fetchPage(p).catch(() => {});
      }
    }
  }, [cursor, allTasks, total, visibleRows, fetchPage]);

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

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>Loading tasks...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Is the Archie server running?</Text>
      </Box>
    );
  }

  if (allTasks.length === 0) {
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
        const channel = task.channel_name
          ? (task.channel_name.startsWith('DM with') ? task.channel_name : `#${task.channel_name}`)
          : 'cli';

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
              {activeAgents > 0 && <Text color="green">  {activeAgents} active</Text>}
              {task.reminder && <Text color="magenta">  ⏰ {formatDateTime(task.reminder.trigger_at)} — {task.reminder.reason.length > 50 ? task.reminder.reason.slice(0, 50) + '…' : task.reminder.reason}</Text>}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
