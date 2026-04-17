import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
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

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  onEvent?: SystemEvent | null;
  onConnect?: boolean;
}

// Check if a given approval:requested event has been resolved
function isApprovalResolved(req: SystemEvent, allEvents: SystemEvent[]): boolean {
  const reqType = req.data.approvalType as string;
  return allEvents.some(
    (e) =>
      e.type === 'approval:resolved' &&
      // Match by approval type — resolved events use `type` field
      (e.data.type as string) === reqType &&
      e.timestamp > req.timestamp,
  );
}

export function TaskDetail({ taskId, onBack, onEvent, onConnect }: TaskDetailProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [fallbackLines, setFallbackLines] = useState<string[]>([]); // knowledge.log for old tasks
  const [inputActive, setInputActive] = useState(true);
  const [focusedApprovalLine, setFocusedApprovalLine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const prevOnEvent = useRef<SystemEvent | null>(null);
  const prevOnConnect = useRef<boolean | undefined>(undefined);
  const scrollRef = useRef<ScrollViewRef>(null);
  const autoScroll = useRef(true); // stick to bottom unless user scrolls up
  const [linesBelow, setLinesBelow] = useState(0);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reserve lines: header(1) + agents(1) + margin(1) + indicator/gap(2) + input(1)
  const reservedLines = 6;
  const logHeight = Math.max(5, termHeight - reservedLines);

  // Build log lines with inline approvals
  const logLines: { node: React.ReactNode; approval?: { approvalType: 'edit_mode' | 'research_budget'; eventIndex: number } }[] = [];

  if (events.length > 0) {
    events.forEach((event, idx) => {
      switch (event.type) {
        case 'message':
          logLines.push({
            node: <><Text dimColor>[{event.data.from as string}]</Text> <Text color="cyan">@{event.data.to as string}</Text> {event.data.message as string}</>,
          });
          break;
        case 'agent:log':
          logLines.push({
            node: <Text dimColor>[{event.agentName}] {event.data.finding as string}</Text>,
          });
          break;
        case 'approval:requested': {
          const resolved = isApprovalResolved(event, events);
          if (resolved) {
            logLines.push({
              node: <Text dimColor>✅ {event.data.text as string} (resolved)</Text>,
            });
          } else {
            logLines.push({
              node: <Text color="yellow" bold>⏳ {event.data.text as string}  [y] approve / [n] deny</Text>,
              approval: {
                approvalType: event.data.approvalType as 'edit_mode' | 'research_budget',
                eventIndex: idx,
              },
            });
          }
          break;
        }
        case 'approval:resolved':
          logLines.push({
            node: <Text>{event.data.approve ? '✅' : '❌'} Approval {event.data.approve ? 'granted' : 'denied'}: {event.data.type as string}</Text>,
          });
          break;
        default:
          break;
      }
    });
  } else {
    fallbackLines.forEach((line) => {
      logLines.push({ node: <Text>{line}</Text> });
    });
  }

  // Collect line indices of pending approvals
  const pendingApprovalLines = logLines
    .map((l, i) => l.approval ? i : -1)
    .filter((i) => i >= 0);

  // The approval at the focused line (if any)
  const focusedApproval = focusedApprovalLine !== null
    ? logLines[focusedApprovalLine]?.approval ?? null
    : null;

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

  useInput((input, key) => {
    if (key.escape) {
      // Debounce: option+arrow sends escape before the arrow key arrives.
      // Schedule onBack, cancel if an arrow key comes within 50ms.
      if (escapeTimer.current) clearTimeout(escapeTimer.current);
      escapeTimer.current = setTimeout(() => {
        escapeTimer.current = null;
        onBack();
      }, 50);
      return;
    } else if (key.tab) {
      // Tab cycles through: input → pending approvals → input
      if (inputActive) {
        if (pendingApprovalLines.length > 0) {
          setInputActive(false);
          setFocusedApprovalLine(pendingApprovalLines[0]);
        } else {
          setInputActive(false);
          setFocusedApprovalLine(null);
        }
      } else if (focusedApprovalLine !== null) {
        const currentIdx = pendingApprovalLines.indexOf(focusedApprovalLine);
        const nextIdx = currentIdx + 1;
        if (nextIdx < pendingApprovalLines.length) {
          setFocusedApprovalLine(pendingApprovalLines[nextIdx]);
        } else {
          setInputActive(true);
          setFocusedApprovalLine(null);
        }
      } else {
        setInputActive(true);
        setFocusedApprovalLine(null);
      }
    } else if (!inputActive) {
      // Scroll mode / approval handling
      if (input === 'q' || input === 'Q') exit();
      if (focusedApproval && (input === 'y' || input === 'Y')) {
        sendApproval(taskId, focusedApproval.approvalType, true).catch((err: any) => setError(err.message));
        setFocusedApprovalLine(null);
        setInputActive(true);
      } else if (focusedApproval && (input === 'n' || input === 'N')) {
        sendApproval(taskId, focusedApproval.approvalType, false).catch((err: any) => setError(err.message));
        setFocusedApprovalLine(null);
        setInputActive(true);
      }
    }

    // Cancel pending escape if arrow key follows (option+arrow sequence)
    if (key.upArrow || key.downArrow) {
      if (escapeTimer.current) {
        clearTimeout(escapeTimer.current);
        escapeTimer.current = null;
      }
    }

    // Scroll with arrows (always available) — clear focused approval when scrolling
    const scrollStep = key.meta ? 10 : 1;
    if (key.upArrow) {
      setFocusedApprovalLine(null);
      const refUp = scrollRef.current;
      if (refUp) {
        const current = refUp.getScrollOffset();
        refUp.scrollTo(Math.max(0, current - scrollStep));
      }
    } else if (key.downArrow) {
      setFocusedApprovalLine(null);
      const refDown = scrollRef.current;
      if (refDown) {
        const current = refDown.getScrollOffset();
        const bottom = refDown.getBottomOffset();
        refDown.scrollTo(Math.min(bottom, current + scrollStep));
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

  // logHeight computed above, near hooks

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
            <Box key={a.agent} gap={1}>
              {a.active ? (
                <Text color="green"><Spinner type="dots" /></Text>
              ) : (
                <Text color="gray">○</Text>
              )}
              <Text color={a.active ? 'green' : 'gray'}>{a.agent}</Text>
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
          {logLines.map((line, i) => {
            const isFocused = i === focusedApprovalLine;
            return (
              <Text key={i} wrap="wrap" inverse={isFocused}>{line.node}</Text>
            );
          })}
        </ScrollView>
      )}
      <Box paddingX={1} height={2} flexDirection="column" justifyContent="flex-end">
        {linesBelow > 0 && (
          <Text dimColor>↓ {linesBelow} more below</Text>
        )}
      </Box>

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
