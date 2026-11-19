/**
 * Tool calls of one task, read from its agents' SDK transcripts.
 *
 * The SDK reader follows one message chain per session, while the PM session
 * is forked after a refusal and replaced for max mode (`src/agents/spawn.ts`).
 * So every session of the task is read, calls copied into a fork are counted
 * once by tool_use id, and the raw transcript lines are counted independently:
 * any call the reader did not return makes the read incomplete.
 *
 * Calls from all sessions and workers are merged by the timestamp of the
 * transcript line that made each call, since a fork's copied history starts at
 * the same moment as its original and a background worker runs alongside the PM.
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import {
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createKeyedLock } from '../../src/system/keyed-lock.js';

export interface ToolCall {
  /** `pm` (the agent key) for the PM's own calls, the subagent type for a delegated worker's. */
  agent: string;
  name: string;
  skill?: string;
  subagentType?: string;
  failed: boolean;
}

/** A session id some task file says the agent ran. */
export interface RecordedSession {
  agentKey: string;
  sessionId: string;
}

export interface TranscriptRead {
  toolCalls: ToolCall[];
  /** Why the calls may be incomplete; empty when every raw tool call was returned by the reader. */
  gaps: string[];
}

/**
 * Archie's own tools report many failures as plain `Error: …` text without the
 * error flag (the `err()` helper in `src/agents/tools.ts`), so the flag alone
 * misses them.
 */
const FAILURE_TEXT = /^Error:/;

/** The Agent tool's result names the worker it started; this ties the worker's transcript to its type. */
const AGENT_ID_IN_RESULT = /\bagentId: (\w+)/;

const UNKNOWN_SUBAGENT = 'unknown-subagent';

/** Session transcripts are named by their UUID; other JSONL files such as journal.jsonl sit beside them. */
const SESSION_TRANSCRIPT =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z
    .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
    .optional(),
});

const messageContentSchema = z.object({ content: z.array(z.unknown()) });

const rawLineSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  message: messageContentSchema.optional(),
});

type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;

interface SessionFiles {
  agentKey: string;
  sessionId: string;
  configDir: string;
  transcriptPath: string;
  subagentPaths: string[];
}

/** Read the tool calls of every session in `taskDir`, in the order they were made. */
export async function readTaskToolCalls(
  taskDir: string,
  recorded: RecordedSession[],
): Promise<TranscriptRead> {
  const gaps: string[] = [];
  const onDisk = await findSessionFiles(taskDir);

  for (const { agentKey, sessionId } of recorded) {
    const found = onDisk.some((s) => s.agentKey === agentKey && s.sessionId === sessionId);
    if (!found) gaps.push(`session ${sessionId} (${agentKey}) is recorded but has no transcript`);
  }

  const rawIds = new Set<string>();
  // A call copied into a fork may be stamped later there; the earliest stamp is when it was made.
  const madeAtMs = new Map<string, number>();
  const sources: CallSource[] = [];
  for (const session of onDisk) {
    for (const path of [session.transcriptPath, ...session.subagentPaths]) {
      for (const { id, atMs } of await readRawToolUses(path)) {
        rawIds.add(id);
        if (atMs !== undefined) madeAtMs.set(id, Math.min(atMs, madeAtMs.get(id) ?? Infinity));
      }
    }
    sources.push(...(await readSessionToolCalls(session)));
  }

  const returnedIds = new Set(sources.flatMap((source) => source.calls.map((c) => c.id)));
  const missed = [...rawIds].filter((id) => !returnedIds.has(id)).length;
  if (missed > 0) {
    gaps.push(`${missed} of ${rawIds.size} raw tool calls were not returned by the reader`);
  }
  return { toolCalls: mergeByTime(sources, madeAtMs), gaps };
}

/** One transcript's calls, in the order the reader returned them. */
export interface CallSource {
  /** `<agentKey>/<sessionId>`, plus `/<agentId>` for a worker; unique within a task. */
  key: string;
  calls: IdentifiedCall[];
}

/**
 * Merge sources into one sequence by when each call was made, keeping each
 * source's own order and counting a call copied into a fork once. Calls made
 * in the same millisecond go in source-key order, so the result does not
 * depend on the order the sources were listed in. A call without a timestamp
 * keeps the time of the call before it in its source.
 */
export function mergeByTime(sources: CallSource[], madeAtMs: Map<string, number>): ToolCall[] {
  const queues = sources
    .map((source) => {
      let previousMs = -Infinity;
      const calls = source.calls.map((entry) => {
        previousMs = madeAtMs.get(entry.id) ?? previousMs;
        return { ...entry, atMs: previousMs };
      });
      return { key: source.key, calls, next: 0 };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const merged: ToolCall[] = [];
  const seen = new Set<string>();
  for (;;) {
    let earliest: (typeof queues)[number] | undefined;
    let earliestMs = Infinity;
    for (const queue of queues) {
      const head = queue.calls[queue.next];
      // Strictly earlier, so a tie goes to the queue with the lower key.
      if (head && (earliest === undefined || head.atMs < earliestMs)) {
        earliest = queue;
        earliestMs = head.atMs;
      }
    }
    if (!earliest) return merged;
    const head = earliest.calls[earliest.next++];
    if (head && !seen.has(head.id)) {
      seen.add(head.id);
      merged.push(head.call);
    }
  }
}

/** Main transcripts are `claude/<agentKey>/session/projects/<slug>/<sessionId>.jsonl`. */
async function findSessionFiles(taskDir: string): Promise<SessionFiles[]> {
  const claudeDir = join(taskDir, 'claude');
  if (!existsSync(claudeDir)) return [];

  const sessions: SessionFiles[] = [];
  for (const agentEntry of await readdir(claudeDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const configDir = join(claudeDir, agentEntry.name, 'session');
    const projectsDir = join(configDir, 'projects');
    if (!existsSync(projectsDir)) continue;

    for (const projectEntry of await readdir(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = join(projectsDir, projectEntry.name);
      for (const fileEntry of await readdir(projectDir, { withFileTypes: true })) {
        const sessionId = SESSION_TRANSCRIPT.exec(fileEntry.name)?.[1];
        if (!fileEntry.isFile() || !sessionId) continue;
        sessions.push({
          agentKey: agentEntry.name,
          sessionId,
          configDir,
          transcriptPath: join(projectDir, fileEntry.name),
          subagentPaths: await findSubagentPaths(join(projectDir, sessionId, 'subagents')),
        });
      }
    }
  }
  return sessions;
}

async function findSubagentPaths(subagentsDir: string): Promise<string[]> {
  if (!existsSync(subagentsDir)) return [];
  const entries = await readdir(subagentsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(subagentsDir, e.name));
}

/** Tool calls written by the model, read without the SDK's chain-following. */
async function readRawToolUses(path: string): Promise<{ id: string; atMs?: number }[]> {
  const uses: { id: string; atMs?: number }[] = [];
  for (const line of await readRawLines(path)) {
    if (line.type !== 'assistant' || !line.message) continue;
    const parsedMs = line.timestamp ? Date.parse(line.timestamp) : NaN;
    const atMs = Number.isNaN(parsedMs) ? undefined : parsedMs;
    for (const block of line.message.content) {
      const toolUse = toolUseBlockSchema.safeParse(block);
      if (toolUse.success) uses.push({ id: toolUse.data.id, atMs });
    }
  }
  return uses;
}

async function readRawLines(path: string): Promise<z.infer<typeof rawLineSchema>[]> {
  const lines: z.infer<typeof rawLineSchema>[] = [];
  for (const text of (await readFile(path, 'utf8')).split('\n')) {
    if (!text.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue; // the SDK reader skips the same malformed lines
    }
    const parsed = rawLineSchema.safeParse(json);
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}

export type IdentifiedCall = { id: string; call: ToolCall };

/**
 * One session's calls as one source for the main transcript and one per
 * worker, each worker labelled with the type its Agent call asked for. A
 * worker that cannot be tied to its Agent call is kept as `unknown-subagent`.
 */
async function readSessionToolCalls(session: SessionFiles): Promise<CallSource[]> {
  const { main, subagents } = await readSessionMessages(session);
  const mainUses = extractToolUses(main);
  const workers = subagents.map((s) => ({ agentId: s.agentId, uses: extractToolUses(s.messages) }));
  const subagentTypes = mapSubagentTypes([mainUses, ...workers.map((w) => w.uses)]);

  const sessionKey = `${session.agentKey}/${session.sessionId}`;
  return [
    { key: sessionKey, calls: toToolCalls(mainUses, session.agentKey) },
    ...workers.map(({ agentId, uses }) => ({
      key: `${sessionKey}/${agentId}`,
      calls: toToolCalls(uses, subagentTypes.get(agentId) ?? UNKNOWN_SUBAGENT),
    })),
  ];
}

const runExclusive = createKeyedLock();

/**
 * The SDK reader resolves transcripts under CLAUDE_CONFIG_DIR at call time and
 * takes no option for it, so the variable is set around each read. Reads are
 * serialized because promptfoo builds several records concurrently.
 */
async function readSessionMessages(session: SessionFiles): Promise<{
  main: SessionMessage[];
  subagents: { agentId: string; messages: SessionMessage[] }[];
}> {
  return runExclusive('CLAUDE_CONFIG_DIR', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = session.configDir;
    try {
      const main = await getSessionMessages(session.sessionId);
      const subagents: { agentId: string; messages: SessionMessage[] }[] = [];
      for (const agentId of await listSubagents(session.sessionId)) {
        subagents.push({
          agentId,
          messages: await getSubagentMessages(session.sessionId, agentId),
        });
      }
      return { main, subagents };
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
}

interface ToolUses {
  uses: ToolUseBlock[];
  results: Map<string, ToolResultBlock>;
}

function extractToolUses(messages: SessionMessage[]): ToolUses {
  const uses: ToolUseBlock[] = [];
  const results = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    const parsed = messageContentSchema.safeParse(message.message);
    if (!parsed.success) continue;
    for (const block of parsed.data.content) {
      const toolUse = toolUseBlockSchema.safeParse(block);
      if (toolUse.success) uses.push(toolUse.data);
      const toolResult = toolResultBlockSchema.safeParse(block);
      if (toolResult.success) results.set(toolResult.data.tool_use_id, toolResult.data);
    }
  }
  return { uses, results };
}

function toToolCalls({ uses, results }: ToolUses, agent: string): IdentifiedCall[] {
  return uses.map((use) => {
    const call: ToolCall = { agent, name: use.name, failed: isFailed(results.get(use.id)) };
    const skill = use.input?.skill;
    if (use.name === 'Skill' && typeof skill === 'string') call.skill = skill;
    const subagentType = use.input?.subagent_type;
    if (use.name === 'Agent' && typeof subagentType === 'string') call.subagentType = subagentType;
    return { id: use.id, call };
  });
}

function isFailed(result: ToolResultBlock | undefined): boolean {
  if (!result) return false;
  if (result.is_error === true) return true;
  return FAILURE_TEXT.test(resultText(result).trimStart());
}

function resultText(result: ToolResultBlock): string {
  if (typeof result.content === 'string') return result.content;
  return (result.content ?? []).map((block) => block.text ?? '').join('\n');
}

/** Worker agent id → the worker type its Agent call asked for. */
function mapSubagentTypes(sources: ToolUses[]): Map<string, string> {
  const byAgentId = new Map<string, string>();
  for (const { uses, results } of sources) {
    for (const use of uses) {
      if (use.name !== 'Agent') continue;
      const result = results.get(use.id);
      const agentId = result && AGENT_ID_IN_RESULT.exec(resultText(result))?.[1];
      if (!agentId) continue;
      const subagentType = use.input?.subagent_type;
      byAgentId.set(agentId, typeof subagentType === 'string' ? subagentType : UNKNOWN_SUBAGENT);
    }
  }
  return byAgentId;
}
