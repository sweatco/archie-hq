/**
 * Session record: one comparable unit per task, built only from files in the
 * task folder, so the same builder serves pulled production folders and eval
 * trials. Shape and rules: docs/plans/20261118-behaviour-evals.md (Design).
 * Grades are not part of it: promptfoo keeps them with its results.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { reduceNonceCost } from '../../src/agents/task-usage.js';
import { systemEventSchema, type SystemEvent } from '../../src/system/event-bus.js';
import type { TaskStatus } from '../../src/types/task.js';
import { readTaskToolCalls, type RecordedSession, type ToolCall } from './transcript.js';

export type { ToolCall } from './transcript.js';

export interface Turn {
  inbound: string;
  replies: string[];
}

/** The task's lifecycle status, or `approval_requested` while it waits on a human. */
export type TerminalState = TaskStatus | 'approval_requested';

export interface SessionRecord {
  source: 'production' | 'eval';
  taskId: string;
  eval?: { caseId: string; ref: string; trial: number };
  turns: Turn[];
  toolCalls: ToolCall[];
  /** False when some tool call in the transcripts was not returned by the SDK reader. */
  complete: boolean;
  terminalState: TerminalState;
  /** `costUsd` is null when the task has no usage records: unmeasured, not free. */
  usage: { costUsd: number | null; models: string[] };
  /** Stage 3 adds a recorded manifest; until then nothing ties a session to its prompts and plugins. */
  manifest: 'unknown';
}

export interface BuiltRecord {
  record: SessionRecord;
  /** Why `record.complete` is false. */
  gaps: string[];
}

const PM_AGENT_ID = 'pm-agent';
const PM_AGENT_KEY = 'pm';

/** The SDK marks internal, non-billed turns with this model (as in `src/agents/task-usage.ts`). */
const SYNTHETIC_MODEL = '<synthetic>';

const metadataSchema = z.object({
  task_id: z.string(),
  status: z.enum(['preparing', 'in_progress', 'stopped', 'completed']),
  agent_sessions: z
    .record(z.string(), z.union([z.string(), z.object({ session_id: z.string().optional() })]))
    .optional(),
});

const usageLineSchema = z.object({
  query_nonce: z.string().optional(),
  agentKey: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

type UsageLine = z.infer<typeof usageLineSchema>;

/** Build the record for the task folder `taskDir` (`sessions/<taskId>/`). */
export async function buildSessionRecord(
  taskDir: string,
  source: SessionRecord['source'],
): Promise<BuiltRecord> {
  const sharedDir = join(taskDir, 'shared');
  const metadataPath = join(sharedDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    throw new Error(`${taskDir} is not a task folder: shared/metadata.json is missing`);
  }

  const metadata = metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
  const events = await readJsonLines(join(sharedDir, 'events.jsonl'), systemEventSchema);
  const usageLines = await readJsonLines(join(sharedDir, 'usage.jsonl'), usageLineSchema);

  const { toolCalls, gaps } = await readTaskToolCalls(
    taskDir,
    recordedSessions(metadata, usageLines),
  );

  const record: SessionRecord = {
    source,
    taskId: metadata.task_id,
    turns: buildTurns(events),
    toolCalls,
    complete: gaps.length === 0,
    terminalState: resolveTerminalState(metadata.status, events),
    usage: summarizeUsage(usageLines),
    manifest: 'unknown',
  };
  return { record, gaps };
}

async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  if (!existsSync(path)) return [];
  const items: T[] = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(schema.parse(JSON.parse(line)));
    } catch {
      continue; // skip malformed, as the engine's own readers do
    }
  }
  return items;
}

/** Every session usage.jsonl or metadata.json says ran, not only the current one. */
function recordedSessions(
  metadata: z.infer<typeof metadataSchema>,
  usageLines: UsageLine[],
): RecordedSession[] {
  const sessions = new Map<string, RecordedSession>();
  for (const line of usageLines) {
    if (!line.session_id) continue;
    const agentKey = line.agentKey ?? PM_AGENT_KEY;
    sessions.set(`${agentKey}/${line.session_id}`, { agentKey, sessionId: line.session_id });
  }
  const pmSession = metadata.agent_sessions?.[PM_AGENT_ID];
  const pmSessionId = typeof pmSession === 'string' ? pmSession : pmSession?.session_id;
  if (pmSessionId) {
    sessions.set(`${PM_AGENT_KEY}/${pmSessionId}`, {
      agentKey: PM_AGENT_KEY,
      sessionId: pmSessionId,
    });
  }
  return [...sessions.values()];
}

/** Each inbound message opens a turn; the PM's replies belong to the latest one. */
function buildTurns(events: SystemEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.type !== 'message') continue;
    const text = typeof event.data.message === 'string' ? event.data.message : '';
    if (event.data.to === PM_AGENT_ID) {
      turns.push({ inbound: text, replies: [] });
    } else if (event.data.to === 'user') {
      // A reply before any inbound message (none seen so far) still needs a turn to live in.
      if (turns.length === 0) turns.push({ inbound: '', replies: [] });
      turns[turns.length - 1]?.replies.push(text);
    }
  }
  return turns;
}

/**
 * Metadata holds the lifecycle status; an approval wait shows only in events.
 * The engine parks a task for approval by stopping it, so a pending approval
 * outranks `stopped`. Same order and replay rules as
 * `tools/debug-mcp/wait-for-task.ts`: completed, then awaiting approval, then
 * the status.
 */
function resolveTerminalState(status: TaskStatus, events: SystemEvent[]): TerminalState {
  if (status === 'completed') return status;
  let awaitingApproval = false;
  for (const event of events) {
    if (event.type === 'approval:requested') awaitingApproval = true;
    if (
      event.type === 'approval:resolved' ||
      event.type === 'task:created' ||
      event.type === 'task:resumed' ||
      event.type === 'task:completed'
    ) {
      awaitingApproval = false;
    }
  }
  return awaitingApproval ? 'approval_requested' : status;
}

/** Cost is cumulative within one query() call, so records are reduced per nonce, then summed. */
function summarizeUsage(usageLines: UsageLine[]): SessionRecord['usage'] {
  if (usageLines.length === 0) return { costUsd: null, models: [] };

  const byNonce = new Map<string, UsageLine[]>();
  usageLines.forEach((line, index) => {
    const nonce = line.query_nonce || `no-nonce-${index}`;
    byNonce.set(nonce, [...(byNonce.get(nonce) ?? []), line]);
  });
  let costUsd = 0;
  for (const lines of byNonce.values()) costUsd += reduceNonceCost(lines);

  const models = new Set<string>();
  for (const line of usageLines) {
    for (const model of Object.keys(line.modelUsage ?? {})) {
      if (model !== SYNTHETIC_MODEL) models.add(model);
    }
  }
  return { costUsd, models: [...models].sort() };
}
