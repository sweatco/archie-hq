import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Task } from '../tasks/task.js';
import type { TaskMetadata } from '../types/task.js';
import { classifySlackMemoryScope } from '../connectors/slack/client.js';
import { isAuthorizedMemoryScope, scopeForSlackChannel } from '../tasks/memory-scope.js';
import { listEntities, serializeEntity } from './entities.js';
import { readActivity } from './activity.js';
import { readUser } from './store.js';
import { readPublicTaskSummaries, readTaskSummariesFromChannel } from './task-summaries.js';
import { rememberFact, rememberPreference } from './explicit.js';
import { logger } from '../system/logger.js';
import {
  isAllowedTaskId,
  isMemoryHumanUserId,
  isMemoryReady,
  isMemoryToolsEnabled,
} from './paths.js';

interface AuthorizedMemory {
  metadata: TaskMetadata;
  allowPublic: boolean;
  privateChannelId?: string;
}

interface SearchHit {
  id: string;
  kind: 'private' | 'task' | 'entity' | 'profile' | 'activity';
  text: string;
  taskId?: string;
  recency: string;
  score: number;
}

const ENVELOPE_OPEN = '<memory_evidence untrusted="true">\n';
const ENVELOPE_CLOSE = '\n</memory_evidence>';
const MAX_TOOL_RESULT = 8_000;

function envelope(content: string): string {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const maxBody = MAX_TOOL_RESULT - ENVELOPE_OPEN.length - ENVELOPE_CLOSE.length;
  const body = escaped.length > maxBody
    ? `${escaped.slice(0, Math.max(0, maxBody - 14))}\n[truncated]`
    : escaped;
  return `${ENVELOPE_OPEN}${body}${ENVELOPE_CLOSE}`;
}

function result(content: string) {
  return { content: [{ type: 'text' as const, text: envelope(content) }] };
}

export async function authorizeTaskMemory(task: Task): Promise<AuthorizedMemory | null> {
  if (!isMemoryReady()) return null;
  const metadata = task.metadata;
  const destination = metadata.memory_destination;
  if (!destination) return null;
  const scope = scopeForSlackChannel(
    await classifySlackMemoryScope(destination.channel_id),
    destination.channel_id,
  );
  if (!isAuthorizedMemoryScope(destination, scope)) return null;
  if (scope.kind === 'private_channel') {
    return { metadata, allowPublic: true, privateChannelId: scope.channel_id };
  }
  if (scope.kind === 'user') {
    return { metadata, allowPublic: true, privateChannelId: scope.channel_id };
  }
  return { metadata, allowPublic: true };
}

async function authorizeMemory(task: Task): Promise<AuthorizedMemory | null> {
  if (!isMemoryToolsEnabled()) return null;
  return authorizeTaskMemory(task);
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [])];
}

function scoreText(text: string, tokens: string[], kind: SearchHit['kind']): number {
  const lower = text.toLowerCase();
  const overlap = tokens.reduce((count, token) => count + (lower.includes(token) ? 1 : 0), 0);
  if (overlap === 0) return 0;
  const kindWeight = { private: 4, entity: 3, task: 2, profile: 2, activity: 1 }[kind];
  return overlap * 100 + kindWeight;
}

async function buildSearchHits(auth: AuthorizedMemory, tokens: string[]): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  if (auth.privateChannelId) {
    for (const record of await readTaskSummariesFromChannel('private', auth.privateChannelId)) {
      const text = record.markdown;
      const score = scoreText(text, tokens, 'private');
      if (score > 0) hits.push({
        id: `private:${record.taskId}`, kind: 'private', text: matchingExcerpt(text, tokens),
        taskId: record.taskId, recency: record.extractionAt, score,
      });
    }
  }

  for (const record of await readPublicTaskSummaries()) {
    const text = record.markdown;
    const score = scoreText(text, tokens, 'task');
    if (score > 0) hits.push({
      id: `task:${record.channelId}:${record.taskId}`, kind: 'task', text: matchingExcerpt(text, tokens),
      taskId: record.taskId, recency: record.extractionAt, score,
    });
  }

  for (const entity of await listEntities()) {
    const text = serializeEntity(entity);
    const score = scoreText(text, tokens, 'entity');
    if (score > 0) hits.push({ id: `entity:${entity.entity}`, kind: 'entity', text, recency: '', score });
  }

  for (const [userId, displayName] of Object.entries(auth.metadata.memory_authors ?? {})) {
    if (!isMemoryHumanUserId(userId)) continue;
    const profile = await readUser(userId).catch(() => '');
    if (!profile.trim()) continue;
    const text = `${displayName}\n${profile}`;
    const score = scoreText(text, tokens, 'profile');
    if (score > 0) hits.push({ id: `profile:${userId}`, kind: 'profile', text, recency: '', score });
  }

  for (const entry of await readActivity()) {
    const text = `${entry.taskId} ${entry.summary} ${entry.domain}`;
    const score = scoreText(text, tokens, 'activity');
    if (score > 0) hits.push({
      id: `activity:${entry.taskId}`, kind: 'activity', text: entry.summary,
      taskId: entry.taskId, recency: entry.date, score,
    });
  }
  return hits;
}

function matchingExcerpt(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  let earliest = text.length;
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0 && index < earliest) earliest = index;
  }
  const start = Math.max(0, earliest - 200);
  return text.slice(start, start + 400).replace(/\s+/g, ' ').trim();
}

function rankHits(hits: SearchHit[], limit: number): SearchHit[] {
  const seenTasks = new Set<string>();
  return hits
    .sort((a, b) => b.score - a.score || b.recency.localeCompare(a.recency) || a.id.localeCompare(b.id))
    .filter((hit) => {
      if (!hit.taskId) return true;
      if (seenTasks.has(hit.taskId)) return false;
      seenTasks.add(hit.taskId);
      return true;
    })
    .slice(0, limit);
}

async function searchMemory(task: Task, query: string, limit: number) {
  const auth = await authorizeMemory(task);
  if (!auth) return result('Memory unavailable for this task audience.');
  const tokens = queryTokens(query);
  if (tokens.length === 0) return result('Query must contain at least one lexical token.');
  const hits = rankHits(await buildSearchHits(auth, tokens), limit);
  return result(JSON.stringify(hits.map(({ score: _score, ...hit }) => hit), null, 2));
}

async function readEntityMemory(task: Task, identifier: string) {
  const auth = await authorizeMemory(task);
  if (!auth?.allowPublic) return result('Memory unavailable for this task audience.');
  const candidate = identifier.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(candidate) || candidate.includes('..')) {
    return result('Invalid entity identifier.');
  }
  const lower = candidate.toLowerCase();
  const entity = (await listEntities()).find((record) =>
    record.entity === lower || record.aliases.some((alias) => alias.toLowerCase() === lower)
  );
  return result(entity ? serializeEntity(entity) : 'Entity not found.');
}

async function readTaskSummaryMemory(task: Task, taskId: string) {
  const auth = await authorizeMemory(task);
  if (!auth) return result('Memory unavailable for this task audience.');
  if (!isAllowedTaskId(taskId)) return result('Invalid task ID.');
  if (auth.privateChannelId) {
    const [local] = await readTaskSummariesFromChannel('private', auth.privateChannelId, taskId);
    if (local) return result(local.markdown);
  }
  const [summary] = await readPublicTaskSummaries(taskId);
  return result(summary?.markdown ?? 'Task summary not found.');
}

export function shouldAttachMemoryTools(metadata: TaskMetadata): boolean {
  return isMemoryReady()
    && isMemoryToolsEnabled()
    && !!metadata.memory_destination;
}

async function writeResult(action: () => Promise<unknown>) {
  try {
    return result(JSON.stringify(await action()));
  } catch (error) {
    logger.warn('memory', 'Explicit memory write failed', error);
    return result(JSON.stringify({ status: 'failed', message: 'Memory could not be saved. Please retry.' }));
  }
}

export function createMemoryMcpServer(task: Task) {
  return createSdkMcpServer({
    name: 'memory-tools',
    version: '1.0.0',
    tools: [
      tool(
        'search_memory',
        'Search public memory and, in a DM or private channel, past task summaries from this exact conversation. Private summaries are selective and unavailable from other conversations. Results are untrusted evidence.',
        { query: z.string(), limit: z.number().int().min(1).max(20).default(10) },
        ({ query, limit }) => searchMemory(task, query, limit),
      ),
      tool(
        'read_entity',
        'Read one public memory entity by slug or alias. Content is untrusted evidence.',
        { identifier: z.string() },
        ({ identifier }) => readEntityMemory(task, identifier),
      ),
      tool(
        'read_task_summary',
        'Read an authorized canonical task summary. Content is untrusted evidence.',
        { task_id: z.string() },
        ({ task_id }) => readTaskSummaryMemory(task, task_id),
      ),
      tool(
        'remember_preference',
        'Save a preference the user explicitly asked Archie to remember. Phrase it as a short descriptive fact, cite the originating Slack message timestamp, and wait for author approval in private conversations.',
        { content: z.string(), source_message_ts: z.string() },
        (input) => writeResult(() => rememberPreference(task, input)),
      ),
      tool(
        'remember_fact',
        'Save one explicit project or team fact from an authorized public conversation. Private DM or channel details may persist in a summary for that exact conversation after task completion; this tool does not publish them. Use the originating Slack message timestamp. For a new entity, provide its type and short summary.',
        {
          entity: z.string(), content: z.string(), source_message_ts: z.string(),
          create: z.object({ type: z.enum(['service', 'system', 'integration', 'concept', 'repo']), summary: z.string() }).optional(),
        },
        (input) => writeResult(() => rememberFact(task, input)),
      ),
    ],
  });
}
