/**
 * Tool calls of one task, read from its agents' SDK transcripts.
 *
 * The SDK reader follows one message chain per session, while the PM session
 * is forked after a refusal and replaced for max mode (`src/agents/spawn.ts`).
 * So every session of the task is read, calls copied into a fork are counted
 * once by tool_use id, and the raw transcript lines are counted independently:
 * any call the reader did not return makes the read incomplete.
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

/** The Agent tool's result names the worker it started; this ties the worker's transcript to that call. */
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

/** Read the tool calls of every session in `taskDir`, oldest session first. */
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

  const ordered = await orderByFirstTimestamp(onDisk);
  const toolCalls: ToolCall[] = [];
  const seenToolUseIds = new Set<string>();
  const rawToolUseIds = new Set<string>();

  for (const session of ordered) {
    for (const path of [session.transcriptPath, ...session.subagentPaths]) {
      for (const id of await readRawToolUseIds(path)) rawToolUseIds.add(id);
    }
    const calls = await readSessionToolCalls(session);
    for (const { id, call } of calls) {
      if (seenToolUseIds.has(id)) continue;
      seenToolUseIds.add(id);
      toolCalls.push(call);
    }
  }

  const missed = [...rawToolUseIds].filter((id) => !seenToolUseIds.has(id)).length;
  if (missed > 0) {
    gaps.push(`${missed} of ${rawToolUseIds.size} raw tool calls were not returned by the reader`);
  }
  return { toolCalls, gaps };
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

async function orderByFirstTimestamp(sessions: SessionFiles[]): Promise<SessionFiles[]> {
  const keyed: { session: SessionFiles; firstTimestamp: string }[] = [];
  for (const session of sessions) {
    keyed.push({ session, firstTimestamp: await readFirstTimestamp(session.transcriptPath) });
  }
  keyed.sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  return keyed.map((k) => k.session);
}

async function readFirstTimestamp(path: string): Promise<string> {
  for (const line of await readRawLines(path)) {
    if (line.timestamp) return line.timestamp;
  }
  return '';
}

/** Tool_use ids written by the model, counted without the SDK's chain-following. */
async function readRawToolUseIds(path: string): Promise<string[]> {
  const ids: string[] = [];
  for (const line of await readRawLines(path)) {
    if (line.type !== 'assistant' || !line.message) continue;
    for (const block of line.message.content) {
      const toolUse = toolUseBlockSchema.safeParse(block);
      if (toolUse.success) ids.push(toolUse.data.id);
    }
  }
  return ids;
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

type IdentifiedCall = { id: string; call: ToolCall };

/**
 * One session's calls in execution order, each worker's calls placed right
 * after the Agent call that started it. A worker that cannot be tied to its
 * Agent call goes last rather than being dropped.
 */
async function readSessionToolCalls(session: SessionFiles): Promise<IdentifiedCall[]> {
  const { main, subagents } = await readSessionMessages(session);
  const mainUses = extractToolUses(main);
  const workers = subagents.map((s) => ({ agentId: s.agentId, uses: extractToolUses(s.messages) }));
  const placements = mapSubagentTypes([mainUses, ...workers.map((w) => w.uses)]);

  const workerCallsByToolUseId = new Map<string, IdentifiedCall[]>();
  const unplacedWorkers: IdentifiedCall[][] = [];
  for (const { agentId, uses } of workers) {
    const placement = placements.get(agentId);
    const calls = toToolCalls(uses, placement?.subagentType ?? UNKNOWN_SUBAGENT);
    if (placement) workerCallsByToolUseId.set(placement.toolUseId, calls);
    else unplacedWorkers.push(calls);
  }

  const ordered: IdentifiedCall[] = [];
  const append = (entry: IdentifiedCall): void => {
    ordered.push(entry);
    const workerCalls = workerCallsByToolUseId.get(entry.id);
    workerCallsByToolUseId.delete(entry.id);
    for (const workerCall of workerCalls ?? []) append(workerCall);
  };
  for (const entry of toToolCalls(mainUses, session.agentKey)) append(entry);
  // Workers whose Agent call the reader did not return, then those never tied to one.
  // Deleting while iterating is safe for a Map: removed entries are not visited.
  for (const [toolUseId, calls] of workerCallsByToolUseId) {
    workerCallsByToolUseId.delete(toolUseId);
    for (const entry of calls) append(entry);
  }
  for (const calls of unplacedWorkers) {
    for (const entry of calls) append(entry);
  }
  return ordered;
}

/**
 * The SDK reader resolves transcripts under CLAUDE_CONFIG_DIR at call time and
 * takes no option for it, so the variable is set around each read and reads
 * must not overlap.
 */
async function readSessionMessages(session: SessionFiles): Promise<{
  main: SessionMessage[];
  subagents: { agentId: string; messages: SessionMessage[] }[];
}> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = session.configDir;
  try {
    const main = await getSessionMessages(session.sessionId);
    const subagents: { agentId: string; messages: SessionMessage[] }[] = [];
    for (const agentId of await listSubagents(session.sessionId)) {
      subagents.push({ agentId, messages: await getSubagentMessages(session.sessionId, agentId) });
    }
    return { main, subagents };
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
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

/** Worker agent id → the Agent call that started it and the worker's type. */
function mapSubagentTypes(
  sources: ToolUses[],
): Map<string, { toolUseId: string; subagentType: string }> {
  const byAgentId = new Map<string, { toolUseId: string; subagentType: string }>();
  for (const { uses, results } of sources) {
    for (const use of uses) {
      if (use.name !== 'Agent') continue;
      const result = results.get(use.id);
      const agentId = result && AGENT_ID_IN_RESULT.exec(resultText(result))?.[1];
      if (!agentId) continue;
      const subagentType = use.input?.subagent_type;
      byAgentId.set(agentId, {
        toolUseId: use.id,
        subagentType: typeof subagentType === 'string' ? subagentType : UNKNOWN_SUBAGENT,
      });
    }
  }
  return byAgentId;
}
