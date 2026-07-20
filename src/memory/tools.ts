/**
 * Memory Read Tools (pull path)
 *
 * Agent-callable, read-only access to the public memory store: `search_memory`,
 * `read_entity`, and `read_task_summary`, exposed as one
 * in-process MCP server registered for every agent track when
 * `ARCHIE_MEMORY_TOOLS=true` (default off; see `isMemoryToolsEnabled`).
 *
 * Invariants:
 * - Zero mutating tools — writes stay funneled through the extraction
 *   side-agent. "Reads are safe to hand to all agents" is enforced by
 *   construction, not by prompt.
 * - Every identifier passes the existing `paths.ts` guards before any
 *   filesystem access; no hand-built paths.
 * - The store is public by construction: private tasks never write it. User
 *   files remain scoped to the calling task's message authors.
 * - Results are size-bounded: search returns thin ranked hits (identifier +
 *   one-liner), full pages only via explicit `read_entity`.
 * - Every invocation with a known task leaves a pull-sensor record
 *   (`kind: "pull"`) in the task's telemetry file — see telemetry.ts;
 */

import { readFile, readdir } from 'fs/promises';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listEntities, readEntity, resolveEntity } from './entities.js';
import { tokenize } from './entity-index.js';
import { renderEntityBlock } from './context.js';
import { readActivity } from './activity.js';
import {
  getSummaryPath,
  getTasksDir,
  isAllowedTaskId,
  isValidEntitySlug,
} from './paths.js';
import { listUserFiles } from './store.js';
import { recordPull } from './telemetry.js';
import type { EntityRecord } from './types.js';

export interface MemoryToolsCtx {
  taskId?: string;
  agent?: string;
  /** Slack user ids of the calling task's message authors. */
  authorUserIds?: string[];
}

// Result bounds (design open question proposes these defaults; tune after
// the first pull telemetry lands).
export const SEARCH_MAX_HITS = 10;
export const RESULT_MAX_CHARS = 8_000;

/** Clamp a tool result to the per-result byte bound with an explicit marker. */
function clamp(text: string): string {
  if (text.length <= RESULT_MAX_CHARS) return text;
  return `${text.slice(0, RESULT_MAX_CHARS)}\n[result truncated at ${RESULT_MAX_CHARS} chars]`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text: clamp(text) }] };
}

function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ============================================================================
// search_memory
// ============================================================================

export interface SearchHit {
  /** entity slug, user id, task id — what the agent passes to a follow-up read. */
  id: string;
  kind: 'entity' | 'user' | 'task-summary' | 'activity';
  /** One-liner: entity L0, user display name, summary first line, activity row. */
  summary: string;
  score: number;
}

// Ties rank stable kinds first: full pages beat episodic artifacts.
const KIND_RANK: Record<SearchHit['kind'], number> = {
  entity: 0,
  user: 1,
  'task-summary': 2,
  activity: 3,
};

function overlap(queryTokens: Set<string>, docTokens: Set<string>): number {
  let n = 0;
  for (const t of queryTokens) if (docTokens.has(t)) n++;
  return n;
}

function entityTokens(r: EntityRecord): Set<string> {
  // Selection scores name/aliases/summary/domain; search adds the facts text
  // (the spec's corpus includes page facts) — same tokenizer either way.
  const parts = [
    r.entity.replace(/-/g, ' '),
    r.displayName,
    r.summary,
    r.domain,
    ...r.aliases,
    ...r.observations.map((o) => o.text),
  ];
  return tokenize(parts.join(' '));
}

/** First line of the `# Summary` section of a task summary, or ''. */
function summaryFirstLine(content: string): string {
  const m = content.match(/^# Summary\s*\n+([^\n]+)/m);
  return (m?.[1] ?? '').trim();
}

/** The content line with the highest query-token overlap (bounded), or ''. */
function bestMatchingLine(queryTokens: Set<string>, text: string, maxChars = 160): string {
  let best = '';
  let bestScore = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const score = overlap(queryTokens, tokenize(line));
    if (score > bestScore) {
      bestScore = score;
      best = line.slice(2).trim();
    }
  }
  if (best.length > maxChars) best = `${best.slice(0, maxChars)}…`;
  return best;
}

/**
 * Lexical search over the store. Pure given its inputs; exported for tests.
 * `users` and `summaries` are pre-read (id, text) pairs so the ranker itself
 * touches no filesystem.
 */
export function rankSearchHits(
  query: string,
  entities: EntityRecord[],
  users: Array<{ id: string; displayName: string; text: string }>,
  summaries: Array<{ taskId: string; text: string }>,
  activityRows: Array<{ taskId: string; summary: string; date: string }>,
  maxHits = SEARCH_MAX_HITS,
): SearchHit[] {
  const q = tokenize(query);
  if (q.size === 0) return [];
  const hits: SearchHit[] = [];

  for (const r of entities) {
    if (r.status === 'archived') continue;
    const score = overlap(q, entityTokens(r));
    if (score > 0) {
      hits.push({ id: r.entity, kind: 'entity', summary: r.summary || r.displayName, score });
    }
  }
  for (const u of users) {
    const score = overlap(q, tokenize(`${u.displayName} ${u.text}`));
    if (score > 0) {
      // No pull tool reads user pages (push injection carries them), so the
      // hit itself must surface the matching content: best-matching bullet
      // line as the snippet, not just the display name.
      hits.push({ id: u.id, kind: 'user', summary: `${u.displayName}: ${bestMatchingLine(q, u.text)}`, score });
    }
  }
  for (const s of summaries) {
    const score = overlap(q, tokenize(s.text));
    if (score > 0) {
      hits.push({ id: s.taskId, kind: 'task-summary', summary: summaryFirstLine(s.text), score });
    }
  }
  for (const a of activityRows) {
    const score = overlap(q, tokenize(a.summary));
    if (score > 0) {
      hits.push({ id: a.taskId, kind: 'activity', summary: `${a.date} — ${a.summary}`, score });
    }
  }

  return hits
    .sort(
      (a, b) =>
        b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id),
    )
    .slice(0, maxHits);
}

/** Read every public task summary. */
async function readAllSummaries(): Promise<Array<{ taskId: string; text: string }>> {
  let names: string[];
  try {
    names = await readdir(getTasksDir());
  } catch {
    return [];
  }
  const out: Array<{ taskId: string; text: string }> = [];
  for (const taskId of names) {
    if (!isAllowedTaskId(taskId) || /^\.+$/.test(taskId)) continue;
    try {
      const text = await readFile(getSummaryPath(taskId), 'utf-8');
      out.push({ taskId, text });
    } catch {
      // No summary for this task dir (telemetry-only) — skip.
    }
  }
  return out;
}

function renderHits(hits: SearchHit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. [${h.kind}] ${h.id} — ${h.summary || '(no summary)'} (score ${h.score})`,
  );
  // Per-kind follow-up guidance: user hits have NO read tool (their content is
  // in the snippet above; full preferences arrive via push injection), so
  // never point agents at read_entity for them — that's a guaranteed miss.
  const followUps = ['Follow up: [entity] → read_entity(slug); [task-summary]/[activity] → read_task_summary(taskId); [user] → snippet above is the content (no read tool for user pages).'];
  return [`${hits.length} result(s). ${followUps[0]}`, ...lines].join('\n');
}

// ============================================================================
// Server factory
// ============================================================================

/**
 * Build the three read tools for one spawn. Takes primitives, not Agent/Task,
 * so the memory module stays decoupled from core types; the caller passes the
 * spawn's taskId + agent id (pull sensor) and author user ids for user-memory
 * scoping. Exported for tests — the server
 * wrapper below is what production registers.
 */
export function buildMemoryTools(ctx: MemoryToolsCtx) {
  const { taskId, agent } = ctx;

  const searchMemory = tool(
    'search_memory',
    'Search organizational memory (entity pages, your task\'s users\' preferences, task summaries, recent activity) by keywords. Results are scoped to what this task may read (org-derived content and this task\'s own artifacts). Returns ranked thin hits — follow up with read_entity / read_task_summary for full content.',
    {
      query: z.string().describe('Keywords to search for (lexical match, not semantic)'),
      max_results: z.number().int().min(1).max(25).optional()
        .describe(`Maximum hits to return (default ${SEARCH_MAX_HITS})`),
    },
    async (args) => {
      const [entities, users, summaries, activity] = await Promise.all([
        listEntities(),
        listUserFiles(),
        readAllSummaries(),
        readActivity(),
      ]);
      // User hits are limited to this task's authors. Organizational summaries
      // and activity are already public because only public tasks write them.
      const authorIds = new Set(ctx.authorUserIds ?? []);
      const visibleUsers = users.filter((u) => authorIds.has(u.id));
      const rows = activity
        .map((a) => ({ taskId: a.taskId, summary: a.summary, date: a.date }));
      const hits = rankSearchHits(args.query, entities, visibleUsers, summaries, rows, args.max_results ?? SEARCH_MAX_HITS);
      await recordPull(taskId, agent, 'search_memory', { query: args.query }, {
        returned: hits.map((h) => h.id),
        count: hits.length,
        zeroResult: hits.length === 0,
      });
      if (hits.length === 0) {
        return ok('No results. The store may not cover this topic — proceed without memory or try different keywords.');
      }
      return ok(renderHits(hits));
    },
  );

  const readEntityTool = tool(
    'read_entity',
    'Read one entity page in full (facts, relations) by slug — slugs come from the entity index or search_memory results. Aliases resolve to their canonical page.',
    {
      slug: z.string().describe('Entity slug (lowercase-kebab) or a known alias'),
    },
    async (args) => {
      const raw = args.slug?.trim() ?? '';
      // Reject path-capable aliases before any filesystem access.
      const safeAliasShape = /^[A-Za-z0-9 _-]{1,64}$/.test(raw);
      if (!isValidEntitySlug(raw) && !safeAliasShape) {
        await recordPull(taskId, agent, 'read_entity', { slug: raw }, { returned: [], count: 0, zeroResult: true });
        return toolError(`Invalid entity slug: ${JSON.stringify(raw)}. Slugs are lowercase-kebab (see the entity index).`);
      }
      let rec = isValidEntitySlug(raw) ? await readEntity(raw) : null;
      if (!rec) {
        // Alias / near-slug resolution — same resolver extraction uses.
        rec = resolveEntity(raw, await listEntities());
      }
      await recordPull(taskId, agent, 'read_entity', { slug: raw }, {
        returned: rec ? [rec.entity] : [],
        count: rec ? 1 : 0,
        zeroResult: !rec,
      });
      if (!rec) return ok(`No entity found for ${JSON.stringify(raw)}. Use search_memory or the entity index to find valid slugs.`);
      const archivedNote = rec.status === 'archived' ? 'NOTE: this entity is archived (stale) — verify before relying on it.\n' : '';
      return ok(`${archivedNote}${renderEntityBlock(rec)}`);
    },
  );

  const readTaskSummary = tool(
    'read_task_summary',
    'Read a public per-task memory summary (what a past task did, what it changed in memory, related tasks) by task ID.',
    {
      taskId: z.string().describe('Task ID, e.g. task-20260601-1000-abc123'),
    },
    async (args) => {
      const id = args.taskId?.trim() ?? '';
      if (!isAllowedTaskId(id) || /^\.+$/.test(id)) {
        await recordPull(taskId, agent, 'read_task_summary', { taskId: id }, { returned: [], count: 0, zeroResult: true });
        return toolError(`Invalid task ID: ${JSON.stringify(id)}`);
      }
      let text: string;
      try {
        text = await readFile(getSummaryPath(id), 'utf-8');
      } catch {
        await recordPull(taskId, agent, 'read_task_summary', { taskId: id }, { returned: [], count: 0, zeroResult: true });
        return ok(`No summary found for task ${id}.`);
      }
      await recordPull(taskId, agent, 'read_task_summary', { taskId: id }, { returned: [id], count: 1, zeroResult: false });
      return ok(text);
    },
  );

  return { searchMemory, readEntity: readEntityTool, readTaskSummary };
}

/** The in-process `memory-tools` MCP server production registers per spawn. */
export function createMemoryToolsMcpServer(ctx: MemoryToolsCtx) {
  const t = buildMemoryTools(ctx);
  return createSdkMcpServer({
    name: 'memory-tools',
    version: '1.0.0',
    tools: [t.searchMemory, t.readEntity, t.readTaskSummary],
  });
}
