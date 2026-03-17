import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { fetchTaskDetail, fetchTaskEvents, sendMessage, sendApproval } from '../api.js';
import { MessageInput } from './MessageInput.js';

interface AgentStatus {
  agent: string;
  active: boolean;
  last_activity?: string;
}

interface SystemEvent {
  type: string;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

interface PendingApproval {
  timestamp: string;
  text: string;
  approvalType: 'edit_mode' | 'research_budget';
}

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  onEvent?: SystemEvent | null;
  onConnect?: boolean;
}

// ---- Event formatting ----

function formatEvent(event: SystemEvent): React.ReactNode | null {
  switch (event.type) {
    case 'message':
      return <><Text dimColor>[{event.data.from as string}]</Text> <Text color="cyan">@{event.data.to as string}</Text> {event.data.message as string}</>;
    case 'agent:log':
      return <Text dimColor>[{event.agentName}] {event.data.finding as string}</Text>;
    case 'task:created':
    case 'task:resumed':
    case 'task:stopped':
    case 'task:completed':
    case 'agent:active':
    case 'agent:inactive':
      return null; // lifecycle events — shown in header/agents bar
    case 'approval:requested':
      return null; // handled by interactive rendering
    case 'approval:resolved':
      return <>{event.data.approve ? '✅' : '❌'} Approval {event.data.approve ? 'granted' : 'denied'}: {event.data.type as string}</>;
    default:
      return null;
  }
}

export function TaskDetail({ taskId, onBack, onEvent, onConnect }: TaskDetailProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [fallbackLines, setFallbackLines] = useState<string[]>([]); // knowledge.log for old tasks
  const [focusIndex, setFocusIndex] = useState(0); // 0 = input, 1+ = approval lines
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const prevOnEvent = useRef<SystemEvent | null>(null);
  const prevOnConnect = useRef<boolean | undefined>(undefined);
  const scrollRef = useRef<ScrollViewRef>(null);
  const autoScroll = useRef(true); // stick to bottom unless user scrolls up
  const [linesBelow, setLinesBelow] = useState(0);

  // Derive display lines from events, falling back to knowledge.log for old tasks
  const logLines: React.ReactNode[] = events.length > 0
    ? events.map(formatEvent).filter((l): l is React.ReactNode => l !== null)
    : fallbackLines;

  const pendingApprovals: PendingApproval[] = events
    .filter((e) => e.type === 'approval:requested')
    .filter((req) => !events.some(
      (e) => e.type === 'approval:resolved' && e.timestamp > req.timestamp,
    ))
    .map((e) => ({
      timestamp: e.timestamp,
      text: e.data.text as string,
      approvalType: e.data.approvalType as 'edit_mode' | 'research_budget',
    }));

  // Initial load: fetch metadata + events
  const loadInitial = useCallback(async () => {
    try {
      const [detail, eventsResult] = await Promise.all([
        fetchTaskDetail(taskId),
        fetchTaskEvents(taskId),
      ]);
      setStatus(detail.metadata?.status || '');
      setAgents(detail.agents || []);
      setEvents(eventsResult.events);
      setEventCursor(eventsResult.total);

      // Fallback: if no events.jsonl yet, render from knowledge.log
      if (eventsResult.events.length === 0 && detail.knowledgeLog) {
        setFallbackLines(detail.knowledgeLog.split('\n').filter((l: string) => l.trim()));
      } else {
        setFallbackLines([]);
      }

      setError(null);
      // Scroll to bottom after initial load
      setTimeout(() => scrollRef.current?.scrollToBottom(), 50);
    } catch (err: any) {
      setError(err.message);
    }
  }, [taskId]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Handle SSE events from parent
  useEffect(() => {
    if (onEvent && onEvent !== prevOnEvent.current) {
      prevOnEvent.current = onEvent;
      setEvents((prev) => [...prev, onEvent]);
      setEventCursor((c) => c + 1);

      // Update agents bar from agent events
      if (onEvent.type === 'agent:active' || onEvent.type === 'agent:inactive') {
        setAgents((prev) => {
          const existing = prev.find((a) => a.agent === onEvent.agentName);
          const active = onEvent.type === 'agent:active';
          if (existing) {
            return prev.map((a) => a.agent === onEvent.agentName ? { ...a, active } : a);
          }
          return [...prev, { agent: onEvent.agentName!, active }];
        });
      }

      // Update status from task events
      if (onEvent.type === 'task:resumed') setStatus('in_progress');
      if (onEvent.type === 'task:completed') setStatus('completed');
      if (onEvent.type === 'task:stopped') setStatus('stopped');

      // Auto-scroll to bottom when new events arrive (if user hasn't scrolled up)
      if (autoScroll.current) {
        setTimeout(() => scrollRef.current?.scrollToBottom(), 0);
      }
    }
  }, [onEvent]);

  // Handle reconnect — fetch missed events
  useEffect(() => {
    if (onConnect !== undefined && onConnect !== prevOnConnect.current) {
      const wasDisconnected = prevOnConnect.current === false;
      prevOnConnect.current = onConnect;
      if (onConnect && wasDisconnected) {
        // Reconnected — fetch events we missed
        fetchTaskEvents(taskId, eventCursor).then((result) => {
          if (result.events.length > 0) {
            setEvents((prev) => [...prev, ...result.events]);
            setEventCursor(result.total);
          }
        }).catch(() => { /* ignore reconnect errors */ });
      }
    }
  }, [onConnect, taskId, eventCursor]);

  // Total focusable items: 1 (input) + pending approvals + 1 (unfocused/scroll mode)
  // focusIndex: 0 = input, 1..N = approvals, N+1 = unfocused
  const focusableCount = 1 + pendingApprovals.length + 1;
  const unfocusedIndex = focusableCount - 1;

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    } else if (key.tab) {
      setFocusIndex((prev) => (prev + 1) % focusableCount);
    } else if (focusIndex === 0) {
      // Input is focused — MessageInput handles its own input (q is just a letter here)
    } else if (focusIndex === unfocusedIndex) {
      // Unfocused / scroll mode
      if (input === 'q' || input === 'Q') exit();
    } else {
      // Approval line is focused — y/n to respond
      const approvalIdx = focusIndex - 1;
      const approval = pendingApprovals[approvalIdx];
      if (approval && (input === 'y' || input === 'Y')) {
        sendApproval(taskId, approval.approvalType, true).catch((err: any) => setError(err.message));
      } else if (approval && (input === 'n' || input === 'N')) {
        sendApproval(taskId, approval.approvalType, false).catch((err: any) => setError(err.message));
      }
    }

    // Scroll with arrows (clamp to bottomOffset since scrollBy clamps to contentHeight)
    if (key.upArrow) {
      scrollRef.current?.scrollBy(-1);
    } else if (key.downArrow) {
      const ref = scrollRef.current;
      if (ref) {
        const bottom = ref.getBottomOffset();
        if (ref.getScrollOffset() < bottom) {
          ref.scrollBy(1);
        }
      }
    }
  });

  const handleSendMessage = async (message: string) => {
    try {
      await sendMessage(taskId, message);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  // Reserve lines: header(1) + agents(1) + margin(1) + indicator/gap(2) + input(1) + approvals(1 each)
  const reservedLines = 6 + pendingApprovals.length;
  const logHeight = Math.max(5, termHeight - reservedLines);

  const inputActive = focusIndex === 0;

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold>Task: {taskId}</Text>
        <Text dimColor>  status: </Text>
        <Text color={status === 'in_progress' ? 'yellow' : status === 'completed' ? 'green' : 'red'}>
          {status}
        </Text>
      </Box>

      {/* Agents bar */}
      <Box paddingX={1} gap={2}>
        {agents.length > 0 ? (
          agents.map((a) => (
            <Box key={a.agent}>
              <Text color={a.active ? 'green' : 'gray'}>
                {a.active ? '●' : '○'} {a.agent}
              </Text>
            </Box>
          ))
        ) : (
          <Text dimColor>No agents</Text>
        )}
      </Box>

      {/* Event log — fills available space, scrollable with arrow keys */}
      {logLines.length === 0 ? (
        <Box height={logHeight} paddingX={1} marginTop={1}>
          <Text dimColor>No log entries yet</Text>
        </Box>
      ) : (
        <ScrollView
          ref={scrollRef}
          height={logHeight}
          paddingX={1}
          marginTop={1}
          onScroll={() => {
            const ref = scrollRef.current;
            if (ref) {
              const bottom = ref.getBottomOffset();
              const offset = ref.getScrollOffset();
              autoScroll.current = offset >= bottom;
              setLinesBelow(Math.max(0, bottom - offset));
            }
          }}
        >
          {logLines.map((line, i) => (
            <Text key={i} wrap="wrap">{line}</Text>
          ))}
        </ScrollView>
      )}
      <Box paddingX={1} height={2} flexDirection="column" justifyContent="flex-end">
        {linesBelow > 0 && (
          <Text dimColor>↓ {linesBelow} more below</Text>
        )}
      </Box>

      {/* Inline approval lines */}
      {pendingApprovals.map((approval, i) => {
        const focused = focusIndex === i + 1;
        return (
          <Box key={approval.timestamp} paddingX={1}>
            <Text
              bold={focused}
              inverse={focused}
              color="yellow"
            >
              ⏳ {approval.text}  [y] approve / [n] deny
            </Text>
          </Box>
        );
      })}

      {/* Message input */}
      <Box paddingX={1}>
        <MessageInput
          onSubmit={handleSendMessage}
          active={inputActive}
          placeholder={inputActive ? 'Type message to PM...' : 'Press Tab to type...'}
        />
      </Box>
    </Box>
  );
}

export type { AgentStatus };
