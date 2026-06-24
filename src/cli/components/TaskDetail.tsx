import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { fetchTaskDetail, fetchTaskEvents, sendMessage, sendApproval } from '../api.js';
import { MessageInput } from './MessageInput.js';
import type { PrCardData } from '../../types/task.js';
import { prCardSubtitle, CLI_PR_CARD_EMOJI } from '../../system/pr-card-format.js';

/**
 * Render a PR card from a `pr_card` event's data. Two lines: a colored title row
 * (`#num branch`) and a dimmed subtitle (`repo · CI summary`) + URL — the same
 * content shown on Slack, with unicode emoji instead of Slack shortcodes.
 */
function renderPrCard(d: Record<string, unknown>): React.ReactNode {
  const card: PrCardData = {
    repo: String(d.repo ?? ''),
    prNumber: Number(d.prNumber ?? 0),
    url: String(d.url ?? ''),
    headRef: String(d.headRef ?? ''),
    state: (d.state as PrCardData['state']) ?? 'open',
    head_sha: String(d.head_sha ?? ''),
    ci: (d.ci as PrCardData['ci']) ?? 'none',
    ciPassed: Number(d.ciPassed ?? 0),
    ciTotal: Number(d.ciTotal ?? 0),
  };
  const color = card.state === 'merged' ? 'magenta' : card.state === 'closed' ? 'red' : 'cyan';
  const title = `#${card.prNumber} ${card.headRef}`;
  const subtitle = `${prCardSubtitle(card, CLI_PR_CARD_EMOJI)} · ${card.url}`;
  return <Text color={color}>{title}{'\n'}<Text dimColor>{subtitle}</Text></Text>;
}

/**
 * Format message for CLI display using from, to, and destination fields.
 *
 * Patterns:
 *   [cli] @pm-agent message                      — CLI input
 *   [Dana in #bot-test] @pm-agent message         — Slack incoming
 *   [pm-agent in #bot-test] message               — agent posting to a channel
 *   [pm-agent in cli] message                     — agent posting to CLI
 *   [pm-agent] @backend-agent message             — agent messaging another agent
 */
function formatMessageParts(from: string, to: string, destination?: string): { label: string; mention: string } {
  const label = destination ? `${from} in ${destination}` : from;
  const mention = from !== to && to !== 'user' ? ` @${to}` : '';
  return { label, mention };
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

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
  /** Append-only queue of live SSE events from the parent (accumulated so bursts
   *  aren't lost to React batching). TaskDetail processes the delta each render. */
  liveEvents?: SystemEvent[];
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

export function TaskDetail({ taskId, onBack, liveEvents, onConnect }: TaskDetailProps) {
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
  // Live "Archie is …" indicator — the same line pushed to Slack, mirrored here
  // so the status can be tested without Slack. Transient; not persisted.
  const [liveStatus, setLiveStatus] = useState<string>('');
  const [reminder, setReminder] = useState<{ trigger_at: string; reason: string } | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const processedRef = useRef(0); // count of liveEvents already applied
  const prevOnConnect = useRef<boolean | undefined>(undefined);
  const scrollRef = useRef<ScrollViewRef>(null);
  const autoScroll = useRef(true); // stick to bottom unless user scrolls up
  const [linesBelow, setLinesBelow] = useState(0);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reserve lines: header(1) + agents(1) + margin(1) + indicator/gap(2) + input(1)
  const reservedLines = 6;
  const logHeight = Math.max(5, termHeight - reservedLines);

  // Build log lines with inline approvals
  const logLines: { node: React.ReactNode; approval?: { approvalType: 'edit_mode' | 'research_budget' | 'trigger'; eventIndex: number } }[] = [];

  // Fold pr_card events so a card renders once, at its most recent `post`
  // (anchor), showing the latest merged state. `update` events refresh the data
  // without moving the card; a fresh `post` re-anchors it to the bottom.
  const prCardAnchor = new Map<string, number>();
  const prCardLatest = new Map<string, Record<string, unknown>>();
  events.forEach((e, idx) => {
    if (e.type !== 'pr_card') return;
    const cardId = e.data.cardId as string | undefined;
    if (!cardId) return;
    prCardLatest.set(cardId, e.data);
    if (e.data.action === 'post' || !prCardAnchor.has(cardId)) {
      prCardAnchor.set(cardId, idx);
    }
  });

  if (events.length > 0) {
    events.forEach((event, idx) => {
      switch (event.type) {
        case 'message':
          logLines.push({
            node: (() => { const p = formatMessageParts(event.data.from as string, event.data.to as string, event.data.destination as string | undefined); const footer = event.data.footer as string | undefined; return <><Text dimColor>[{p.label}]</Text>{p.mention ? <Text color="cyan">{p.mention}</Text> : null} {event.data.message as string}{footer ? <Text dimColor>{'\n'}{footer}</Text> : null}</>; })(),
          });
          break;
        case 'pr_card': {
          const cardId = event.data.cardId as string | undefined;
          if (!cardId || prCardAnchor.get(cardId) !== idx) break; // render once, at the anchor
          logLines.push({ node: renderPrCard(prCardLatest.get(cardId) ?? event.data) });
          break;
        }
        case 'agent:log':
          logLines.push({
            node: <Text dimColor>[{event.agentName}] {event.data.finding as string}</Text>,
          });
          break;
        case 'agent:bg_task': {
          // One entry per background task, keyed by task_id: render the 'start' as
          // ⏳ running, and once the matching 'end' has arrived (events is rebuilt on
          // every update) fold it into ✅/❌. Skip the 'end' itself.
          if (event.data.action !== 'start') break;
          const key = event.data.key as string;
          const ended = events.find(
            (e) => e.type === 'agent:bg_task' && e.data.action === 'end' && e.data.key === key,
          );
          const desc = (event.data.description as string) || 'background task';
          if (ended) {
            const status = ended.data.status as string;
            logLines.push({
              node: <Text dimColor>{status === 'completed' ? '✅' : '❌'} [{event.agentName}] background task {status} — {desc}</Text>,
            });
          } else {
            logLines.push({
              node: <Text color="yellow">⏳ [{event.agentName}] background task running — {desc}</Text>,
            });
          }
          break;
        }
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
                approvalType: event.data.approvalType as 'edit_mode' | 'research_budget' | 'trigger',
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
        case 'reminder:set':
          logLines.push({
            node: <Text color="magenta">⏰ Reminder set for {formatDateTime(event.data.trigger_at as string)} — {event.data.reason as string}</Text>,
          });
          break;
        case 'reminder:cancelled':
          logLines.push({
            node: <Text dimColor>⏰ Reminder cancelled</Text>,
          });
          break;
        case 'reminder:fired':
          logLines.push({
            node: <Text color="magenta">⏰ Reminder fired — {event.data.reason as string}</Text>,
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
      setReminder(detail.metadata?.reminder ?? null);
      setTitle(detail.metadata?.title ?? null);
      setAgents(detail.agents || []);
      setLiveStatus(''); // ephemeral — repopulates from the next `status` event
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

  // Handle live SSE events from parent. `liveEvents` is an append-only queue, so
  // process only the delta since the last render and apply each event in order —
  // nothing is dropped when several arrive in the same tick.
  useEffect(() => {
    const queue = liveEvents ?? [];
    // Buffer was reset (task switch / fresh connect) — start from the top.
    if (processedRef.current > queue.length) processedRef.current = 0;
    const fresh = queue.slice(processedRef.current);
    if (fresh.length === 0) return;
    processedRef.current = queue.length;

    for (const ev of fresh) {
      // Live status is transient UI, not a log entry — never lands in scrollback.
      if (ev.type === 'status') {
        setLiveStatus((ev.data?.status as string) || '');
        continue;
      }

      setEvents((prev) => [...prev, ev]);
      setEventCursor((c) => c + 1);

      // Update agents bar from agent events
      if (ev.type === 'agent:active' || ev.type === 'agent:inactive') {
        setAgents((prev) => {
          const existing = prev.find((a) => a.agent === ev.agentName);
          const active = ev.type === 'agent:active';
          if (existing) {
            return prev.map((a) => a.agent === ev.agentName ? { ...a, active } : a);
          }
          return [...prev, { agent: ev.agentName!, active }];
        });
      }

      // Update status from task events
      if (ev.type === 'task:resumed') setStatus('in_progress');
      if (ev.type === 'task:completed') { setStatus('completed'); setLiveStatus(''); }
      if (ev.type === 'task:stopped') { setStatus('stopped'); setLiveStatus(''); }

      // Update reminder from reminder events
      if (ev.type === 'reminder:set') {
        setReminder({ trigger_at: ev.data.trigger_at as string, reason: ev.data.reason as string });
      }
      if (ev.type === 'reminder:cancelled' || ev.type === 'reminder:fired') {
        setReminder(null);
      }
    }

    // Auto-scroll to bottom when new events arrive (if user hasn't scrolled up)
    if (autoScroll.current) {
      setTimeout(() => scrollRef.current?.scrollToBottom(), 0);
    }
  }, [liveEvents]);

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
        <Text wrap="truncate-end">
          <Text bold>Task: {taskId}</Text>
          {title && <Text>  {title}</Text>}
          <Text dimColor>  status: </Text>
          <Text color={status === 'in_progress' ? 'yellow' : status === 'completed' ? 'green' : 'red'}>
            {status}
          </Text>
          {reminder && (
            <Text color="magenta">  ⏰ {formatDateTime(reminder.trigger_at)}</Text>
          )}
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
        {liveStatus ? (
          <Box gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>Archie {liveStatus}</Text>
          </Box>
        ) : null}
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
