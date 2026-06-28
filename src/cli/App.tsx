import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { connectSSE, createTask } from './api.js';
import { TaskList } from './components/TaskList.js';
import { TaskDetail } from './components/TaskDetail.js';
import { StatusBar } from './components/StatusBar.js';
import { MessageInput } from './components/MessageInput.js';

type View = 'list' | 'detail' | 'create';

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const [view, setView] = useState<View>('list');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [liveEvents, setLiveEvents] = useState<any[]>([]);
  const disconnectRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(() => {
    setRefreshTrigger((n) => n + 1);
  }, []);

  // SSE connection
  useEffect(() => {
    const disconnect = connectSSE({
      taskId: view === 'detail' && selectedTaskId ? selectedTaskId : undefined,
      onEvent: (event) => {
        if (event.type === 'connected') return;

        // For detail view: queue the event for TaskDetail. Accumulate via a
        // functional update — plain replace (setLastEvent(event)) collapses bursts
        // under React batching, dropping events that arrive in the same tick (e.g.
        // an inter-agent message immediately followed by agent:active).
        if (view === 'detail') {
          setLiveEvents((prev) => [...prev, event]);
        }

        // For list view: refresh on task-level events
        if (view === 'list' && event.type?.startsWith('task:')) {
          refresh();
        }
      },
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });

    disconnectRef.current = disconnect;
    return () => disconnect();
  }, [view, selectedTaskId, refresh]);

  const lastEscRef = useRef<number>(0);

  useInput((input, key) => {
    if (view === 'create') return; // create view captures input
    if (view === 'detail') return; // detail view handles its own navigation (esc to go back)
    if (input === 'q' || input === 'Q') {
      exit();
    }
    if (key.escape && view === 'list') {
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
        exit();
      }
      lastEscRef.current = now;
    }
  });

  const handleSelectTask = (taskId: string) => {
    setLiveEvents([]);
    setSelectedTaskId(taskId);
    setView('detail');
  };

  const handleBack = () => {
    setSelectedTaskId(null);
    setLiveEvents([]);
    setView('list');
    refresh();
  };

  const handleStartCreate = () => {
    setView('create');
  };

  const handleCreateTask = async (message: string) => {
    try {
      const taskId = await createTask(message);
      setLiveEvents([]);
      setSelectedTaskId(taskId);
      setView('detail');
    } catch {
      setView('list');
    }
  };

  const handleCancelCreate = () => {
    setView('list');
  };

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Title */}
      <Box paddingX={1}>
        <Text bold color="cyan">Archie CLI</Text>
      </Box>

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="column" height={view === 'list' ? undefined : 0} overflow="hidden" flexGrow={view === 'list' ? 1 : 0}>
          <TaskList
            onSelect={handleSelectTask}
            onCreate={handleStartCreate}
            refreshTrigger={refreshTrigger}
            active={view === 'list'}
          />
        </Box>
        {view === 'detail' && selectedTaskId && (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={handleBack}
            liveEvents={liveEvents}
            onConnect={connected}
          />
        )}
        {view === 'create' && (
          <CreateTaskPrompt onSubmit={handleCreateTask} onCancel={handleCancelCreate} />
        )}
      </Box>

      {/* Status bar */}
      <StatusBar connected={connected} view={view === 'detail' ? 'detail' : 'list'} />
    </Box>
  );
}

function CreateTaskPrompt({ onSubmit, onCancel }: { onSubmit: (msg: string) => void; onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>New Task</Text>
      <Text dimColor>Describe what you need (Esc to cancel):</Text>
      <Box marginTop={1}>
        <MessageInput onSubmit={onSubmit} active={true} placeholder="What do you need help with?" />
      </Box>
    </Box>
  );
}
