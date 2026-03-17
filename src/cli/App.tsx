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
  const [lastEvent, setLastEvent] = useState<any>(null);
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

        // For detail view: pass event directly to TaskDetail
        if (view === 'detail') {
          setLastEvent(event);
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

  useInput((input, key) => {
    if (view === 'create') return; // create view captures input
    if (view === 'detail') return; // detail view handles its own navigation (esc to go back)
    if (input === 'q' || input === 'Q') {
      exit();
    }
  });

  const handleSelectTask = (taskId: string) => {
    setLastEvent(null);
    setSelectedTaskId(taskId);
    setView('detail');
  };

  const handleBack = () => {
    setSelectedTaskId(null);
    setLastEvent(null);
    setView('list');
  };

  const handleStartCreate = () => {
    setView('create');
  };

  const handleCreateTask = async (message: string) => {
    try {
      const taskId = await createTask(message);
      setLastEvent(null);
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
        {view === 'list' && (
          <TaskList
            onSelect={handleSelectTask}
            onCreate={handleStartCreate}
            refreshTrigger={refreshTrigger}
          />
        )}
        {view === 'detail' && selectedTaskId && (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={handleBack}
            onEvent={lastEvent}
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
