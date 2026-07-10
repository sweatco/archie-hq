import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { fetchTriggers, updateTrigger, deleteTrigger } from '../api.js';

interface TriggerSummary {
  id: string;
  status: string;
  created_by: string;
  created_at: string;
  last_fired_at: string | null;
  binding_kind: 'channel' | 'user';
  channel_name: string;
  action_prompt: string;
  summary: string;
}

interface TriggerListProps {
  onBack: () => void;
  active: boolean;
  refreshTrigger: number;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'enabled': return <Text color="green">[on]</Text>;
    case 'paused': return <Text color="yellow">[--]</Text>;
    default: return <Text color="gray">[?]</Text>;
  }
}

export function TriggerList({ onBack, active, refreshTrigger }: TriggerListProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const visibleRows = Math.max(1, termHeight - 5);

  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { triggers: t } = await fetchTriggers();
      setTriggers(t);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load, refreshTrigger]);

  useInput((input, key) => {
    if (!active) return;
    if (key.escape || input === 'b' || input === 'B') {
      onBack();
    } else if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(triggers.length - 1, c + 1));
    } else if ((input === 'p' || input === 'P') && triggers[cursor]) {
      const t = triggers[cursor];
      const next = t.status === 'enabled' ? 'paused' : 'enabled';
      updateTrigger(t.id, { status: next }).then(load).catch((e: any) => setError(e.message));
    } else if ((input === 'd' || input === 'D') && triggers[cursor]) {
      deleteTrigger(triggers[cursor].id).then(() => {
        setCursor((c) => Math.max(0, c - 1));
        return load();
      }).catch((e: any) => setError(e.message));
    } else if (input === 'r' || input === 'R') {
      load();
    }
  });

  if (loading) {
    return <Box padding={1}><Text dimColor>Loading triggers...</Text></Box>;
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press <Text color="cyan" bold>b</Text> to go back</Text>
      </Box>
    );
  }

  if (triggers.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>No triggers set up</Text>
        <Text dimColor>Ask Archie in Slack or the CLI to "remind me…" or "every weekday at 9am…". Press <Text color="cyan" bold>b</Text> to go back.</Text>
      </Box>
    );
  }

  const scrollTop = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), triggers.length - visibleRows));
  const visible = triggers.slice(scrollTop, scrollTop + visibleRows);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Triggers ({triggers.length})</Text>
        <Text dimColor>   [p] pause/resume  [d] delete  [r] refresh  [b] back</Text>
      </Box>
      {visible.map((t, i) => {
        const selected = scrollTop + i === cursor;
        const where = t.binding_kind === 'channel' ? `#${t.channel_name}` : 'DM';
        return (
          <Box key={t.id} paddingX={1}>
            <Text wrap="truncate-end">
              <Text color={selected ? 'cyan' : undefined} bold={selected}>{selected ? '> ' : '  '}</Text>
              <StatusIcon status={t.status} />
              <Text color={selected ? 'cyan' : undefined} bold={selected}> {t.id}</Text>
              <Text dimColor>  {where}</Text>
              <Text>  {t.summary}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
