import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { fetchTasks } from '../api.js';

interface TaskSummary {
  task_id: string;
  status: string;
  task_owner: string | null;
  participants: string[];
  created_at: string;
  updated_at: string;
  agents?: { agentId: string; active: boolean }[];
}

interface TaskListProps {
  onSelect: (taskId: string) => void;
  onCreate: () => void;
  refreshTrigger: number;
}

function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'in_progress': return { icon: '[*]', color: 'yellow' };
    case 'completed': return { icon: '[+]', color: 'green' };
    case 'stopped': return { icon: '[-]', color: 'red' };
    default: return { icon: '[?]', color: 'gray' };
  }
}

export function TaskList({ onSelect, onCreate, refreshTrigger }: TaskListProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTasks()
      .then((data) => {
        if (!cancelled) {
          data.sort((a: TaskSummary, b: TaskSummary) =>
            b.task_id.localeCompare(a.task_id));
          setTasks(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshTrigger]);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(tasks.length - 1, c + 1));
    } else if (key.return && tasks.length > 0) {
      onSelect(tasks[cursor].task_id);
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

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>No tasks found</Text>
        <Text dimColor>Press <Text color="cyan" bold>n</Text> to create a new task</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Tasks ({tasks.length})</Text>
      </Box>
      {tasks.map((task, i) => {
        const selected = i === cursor;
        const { icon, color } = statusIcon(task.status);
        const activeAgents = task.agents?.filter((a) => a.active).length ?? 0;

        return (
          <Box key={task.task_id} paddingX={1}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '>' : ' '} <Text color={color}>{icon}</Text> {task.task_id}
              <Text dimColor>  {task.task_owner || 'unassigned'}</Text>
              {activeAgents > 0 && <Text color="green">  {activeAgents} active</Text>}
              <Text dimColor>  {task.participants.length} agents</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
