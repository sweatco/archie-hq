/**
 * Memory Lifecycle
 *
 * Orchestrates post-task memory extraction. Uses a sequential queue to
 * prevent concurrent writes from corrupting shared memory files.
 */

import { writeFile, readFile, rename, unlink, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import {
  isMemoryEnabled,
  getSummaryPath,
  isSlackUserId,
} from './paths.js';
import { readUser, applyUserUpdatesWithIdentity } from './store.js';
import { runExtraction } from './extractor.js';
import { applyEntityUpdate, listEntities, readEntity } from './entities.js';
import { rebuildIndex, readIndexMarkdown } from './entity-index.js';
import { appendActivity, readActivity } from './activity.js';
import { sanitizeTaskSummary } from './sanitize.js';
import { enqueuePending, dequeuePending, readPendingEntries } from './pending-queue.js';
import { recordUserUpdateDropped } from './telemetry.js';
import { parseTranscript } from './transcript.js';
import { loadMetadata, readKnowledgeLog } from '../tasks/persistence.js';
import { withTaskDataLock } from '../tasks/data-lock.js';
import { getBotUserId } from '../connectors/slack/client.js';
import { logger } from '../system/logger.js';
import type { ExtractionResult, UserRef, ActivityEntry, MemoryUpdate, EntityUpdate } from './types.js';
import type { TaskMetadata } from '../types/task.js';

// ============================================================================
// Sequential extraction queue
// ============================================================================

let pendingMutationQueue: Promise<void> = Promise.resolve();
let extractionQueue: Promise<void> = Promise.resolve();

type ExtractionOutcome = 'completed' | 'terminal-skip' | 'retry';

interface ExtractionJournal {
  v: 2;
  generation: string;
  state: 'applying' | 'committed';
  users: Record<string, { displayName: string; updates: MemoryUpdate[] }>;
  entities: EntityUpdate[];
}

function journalPath(taskId: string): string {
  return join(dirname(getSummaryPath(taskId)), 'extraction-journal.json');
}

async function readExtractionJournal(taskId: string, generation: string): Promise<ExtractionJournal> {
  try {
    const value = JSON.parse(await readFile(journalPath(taskId), 'utf-8')) as ExtractionJournal | {
      v: 1;
      users: ExtractionJournal['users'];
      entities: EntityUpdate[];
    };
    if (value?.v === 2 && value.generation === generation && value.users && Array.isArray(value.entities)) return value;
    if (value?.v === 1 && generation === 'legacy' && value.users && Array.isArray(value.entities)) {
      return { v: 2, generation, state: 'applying', users: value.users, entities: value.entities };
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') logger.warn('memory', `Ignoring invalid extraction journal for ${taskId}: ${error}`);
  }
  return { v: 2, generation, state: 'applying', users: {}, entities: [] };
}

async function writeExtractionJournal(taskId: string, journal: ExtractionJournal): Promise<void> {
  const path = journalPath(taskId);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(journal, null, 2), 'utf-8');
  await rename(temp, path);
}

async function deleteExtractionJournal(taskId: string, generation: string): Promise<void> {
  try {
    const journal = JSON.parse(await readFile(journalPath(taskId), 'utf-8')) as { v?: number; generation?: string };
    if (journal.v === 2 && journal.generation !== generation) return;
    if (journal.v === 1 && generation !== 'legacy') return;
    await unlink(journalPath(taskId));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function appendUnique<T>(target: T[], values: readonly T[]): void {
  const seen = new Set(target.map((value) => JSON.stringify(value)));
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(value);
  }
}

function mutatePending<T>(action: () => Promise<T>): Promise<T> {
  const mutation = pendingMutationQueue.then(action);
  pendingMutationQueue = mutation.then(() => undefined, () => undefined);
  return mutation;
}

function scheduleExtraction(taskId: string, intent: Promise<string>, recovery = false): void {
  extractionQueue = extractionQueue
    .then(async () => {
      const generation = await intent;
      const outcome = await processExtraction(taskId, generation);
      if (outcome === 'retry') return;
      await mutatePending(() => dequeuePending(taskId, generation));
      await deleteExtractionJournal(taskId, generation);
    })
    .catch((err) => logger.warn(
      'memory',
      `${recovery ? 'Recovery extraction' : 'Extraction'} failed for ${taskId}: ${err}`,
    ));
}

/**
 * Persist a completed task's extraction intent, then schedule serialized work.
 * The returned promise settles after the durable intent write; extraction stays
 * in the background and failures are logged without poisoning later jobs.
 */
export function handleTaskCompleted(taskId: string): Promise<void> {
  if (!isMemoryEnabled()) return Promise.resolve();
  const generation = randomUUID();
  const intent = mutatePending(() => enqueuePending(taskId, generation));
  scheduleExtraction(taskId, intent);
  return intent.then(() => undefined);
}

/**
 * Schedule extraction without re-enqueuing on disk. Used by startup recovery
 * — the entry is already in pending-extractions.md so we only want to drain.
 */
export function rescheduleTaskCompleted(taskId: string, generation?: string): void {
  if (!isMemoryEnabled()) return;
  const intent = generation
    ? Promise.resolve(generation)
    : mutatePending(async () => (
      (await readPendingEntries()).find((entry) => entry.taskId === taskId)?.generation ?? 'legacy'
    ));
  scheduleExtraction(taskId, intent, true);
}

/** Wait until every currently scheduled queue mutation, extraction, and housekeeping pass has settled. */
export async function waitForMemoryQueueIdle(): Promise<void> {
  while (true) {
    const pending = pendingMutationQueue;
    const extraction = extractionQueue;
    await Promise.all([pending, extraction]);
    if (pending === pendingMutationQueue && extraction === extractionQueue) return;
  }
}

// ============================================================================
// processExtraction
// ============================================================================

async function processExtraction(taskId: string, generation: string): Promise<ExtractionOutcome> {
  const journal = await readExtractionJournal(taskId, generation);
  if (journal.state === 'committed') return 'completed';

  const snapshot = await withTaskDataLock(taskId, async () => {
    const metadata = await loadMetadata(taskId);
    const transcript = metadata?.visibility === 'public' ? await readKnowledgeLog(taskId) : '';
    return { metadata, transcript };
  });
  const metadata = snapshot.metadata;
  if (!metadata) {
    logger.warn('memory', `processExtraction: metadata not found for ${taskId}`);
    return 'terminal-skip';
  }

  // The task boundary is the confidentiality boundary. Private tasks do not
  // contribute collaboration profiles, summaries, activity, or entities. Missing
  // visibility belongs to legacy metadata and therefore fails closed.
  if (metadata.visibility !== 'public') {
    logger.system(`[memory] Extraction skipped for private task ${taskId}`);
    return 'terminal-skip';
  }

  const transcript = snapshot.transcript;
  if (!transcript.trim()) {
    logger.warn('memory', `processExtraction: empty transcript for ${taskId}`);
    return 'terminal-skip';
  }

  // Profile writability comes only from actual Slack message authors. A
  // deterministic fallback still labels CLI/self-launched task artifacts, but
  // fallback identities never load or write collaboration profiles.
  const parsedTranscript = parseTranscript(transcript, getBotUserId() ?? undefined);
  const writableUsers = parsedTranscript.authors;
  const users = writableUsers.length > 0 ? writableUsers : [resolveFallbackId(metadata)];
  const housekeepingTargets = new Set<string>();
  const touchedEntities = new Set<string>();

  // Journal entries are sanitized write intents recorded immediately before a
  // store mutation. Reapplying them closes both crash windows: journal-before-
  // write and write-before-summary.
  for (const [userId, entry] of Object.entries(journal.users)) {
    const replayed = await applyUserUpdatesWithIdentity(userId, entry.displayName, entry.updates);
    if (replayed.capExceeded) housekeepingTargets.add(userId);
  }
  if (journal.entities.length > 0) {
    const replayRecords = await listEntities();
    for (const update of journal.entities) {
      const replayed = await applyEntityUpdate(update, taskId, { records: replayRecords });
      if (!replayed) continue;
      touchedEntities.add(replayed.slug);
      if (replayed.capExceeded) housekeepingTargets.add('entities');
    }
    await rebuildIndex();
  }

  // Load existing profiles only for writable Slack authors.
  const entityIndex = await readIndexMarkdown();
  const collaborationProfileBlocks = await Promise.all(
    writableUsers.map(async (u) => {
      const mem = await readUser(u.userId);
      return { user: u, memory: mem };
    })
  );
  const collaborationProfiles = collaborationProfileBlocks
    .filter((b) => b.memory.trim())
    .map((b) => `## ${b.user.userId} (${b.user.displayName})\n${b.memory.trim()}`)
    .join('\n\n');

  // Run extraction; constrain user_updates to actual Slack authors. Passing an
  // empty set is intentional for tasks without a Slack author.
  const allowedUserIds = new Set(writableUsers.map((u) => u.userId));
  const result = await runExtraction(
    {
      collaborationProfiles,
      entityIndex,
      taskId,
      participants: metadata.participants.join(', '),
      taskOwner: metadata.task_owner ?? '',
      status: metadata.status,
      createdAt: metadata.created_at,
      transcript,
    },
    allowedUserIds
  );

  if (!result) {
    logger.warn('memory', `processExtraction: extraction returned null for ${taskId}`);
    return 'retry';
  }

  // Apply profile updates. Use the identity-aware writer so first-touch files
  // get YAML frontmatter (slack_user_id + display_name + aliases).
  // Own-statements enforcement is code-side: an update is applied only when
  // every cited `msg:<ts>` evidence id resolves to a transcript source line
  // authored by that Slack user (at least one citation is required). Fallback
  // and other non-Slack identities fail closed.
  const appliedUserUpdates: Record<string, MemoryUpdate[]> = Object.fromEntries(
    Object.entries(journal.users).map(([userId, entry]) => [userId, [...entry.updates]]),
  );
  const displayNameById = new Map(writableUsers.map((u) => [u.userId, u.displayName]));
  const msgAuthors = parsedTranscript.msgAuthors;
  for (const [userId, updates] of Object.entries(result.user_updates)) {
    if (updates.length === 0) continue;
    const valid: MemoryUpdate[] = [];
    for (const update of updates) {
      if (isEvidenceValid(userId, update, msgAuthors)) {
        valid.push(update);
      } else {
        logger.warn('memory', `dropped user update for ${userId} (evidence validation): ${JSON.stringify(update.evidence ?? [])}`);
        await recordUserUpdateDropped(taskId, userId, update.evidence ?? []);
      }
    }
    if (valid.length > 0) {
      const displayName = displayNameById.get(userId) ?? userId;
      const applied = await applyUserUpdatesWithIdentity(userId, displayName, valid, {
        beforeWrite: async (updates) => {
          const entry = journal.users[userId] ?? { displayName, updates: [] };
          entry.displayName = displayName;
          appendUnique(entry.updates, updates);
          journal.users[userId] = entry;
          await writeExtractionJournal(taskId, journal);
        },
      });
      if (applied.appliedUpdates.length > 0) {
        appliedUserUpdates[userId] = [...journal.users[userId].updates];
      }
      if (applied.capExceeded) housekeepingTargets.add(userId);
    }
  }

  // Apply entity updates (resolve-or-create; sanitizer runs inside entities.ts).
  // Each applied update auto-adds a `touched_by [[taskId]]` edge.
  const appliedEntityUpdates: EntityUpdate[] = [...journal.entities];
  // Read the entity store once for the whole batch; applyEntityUpdate keeps this
  // array coherent as it creates/updates entities (avoids an O(updates×files)
  // re-read + re-parse on every update).
  const entityRecords = await listEntities();
  for (const update of result.entity_updates) {
    const applied = await applyEntityUpdate(update, taskId, {
      records: entityRecords,
      beforeWrite: async ({ delta }) => {
        appendUnique(journal.entities, [delta]);
        await writeExtractionJournal(taskId, journal);
      },
    });
    if (!applied) continue;
    touchedEntities.add(applied.slug);
    appendUnique(appliedEntityUpdates, [applied.delta]);
    if (applied.capExceeded) housekeepingTargets.add('entities');
  }
  // Rebuild the derived index whenever entities changed.
  if (touchedEntities.size > 0) {
    await rebuildIndex();
  }

  // Write task summary (rich format) to the public memory store.
  const activityIndex = await readActivity();
  // Related tasks: prefer tasks that share an entity with this one; fall back
  // to lexical similarity over the activity index when there's no entity overlap.
  let related = await selectRelatedTasksByEntity([...touchedEntities], taskId, activityIndex);
  if (related.length === 0) {
    related = selectRelatedTasks(result.activity_summary, result.domain, activityIndex, taskId);
  }
  // Summaries expose only profile changes the store confirmed it wrote. Raw
  // extractor candidates, sanitizer drops, and unmatched replacements never
  // enter the public task-summary corpus.
  const summaryResult: ExtractionResult = {
    ...result,
    user_updates: appliedUserUpdates,
    entity_updates: appliedEntityUpdates,
  };
  await writeSummary(taskId, metadata, summaryResult, users, activityIndex, related);

  // Append to the bounded recent-activity index.
  const requestingUser = users[0]?.userId ?? 'cli';
  await appendActivity({
    date: metadata.created_at.split('T')[0],
    taskId,
    summary: result.activity_summary,
    domain: result.domain,
    user: requestingUser,
  }, 50);

  await runHousekeepingPasses(housekeepingTargets);

  journal.state = 'committed';
  await writeExtractionJournal(taskId, journal);

  logger.system(`[memory] Extraction complete for ${taskId}`);
  return 'completed';
}

/**
 * Run housekeeping before the current serialized extraction job completes.
 */
async function runHousekeepingPasses(targets: ReadonlySet<string>): Promise<void> {
  if (targets.size === 0) return;
  for (const target of targets) {
    try {
      const { runHousekeeping: housekeep } = await import('./housekeeping.js');
      await housekeep(target);
    } catch (err) {
      logger.warn('memory', `housekeeping for ${target} failed: ${err}`);
    }
  }
}

/**
 * Own-statements check for one profile update: the target must be a Slack user,
 * at least one `msg:<ts>` id is required, and every id must resolve to a line
 * that target authored. Missing, malformed, unknown, mixed-author, and fallback
 * evidence all fail closed.
 */
export function isEvidenceValid(
  userId: string,
  update: MemoryUpdate,
  msgAuthors: ReadonlyMap<string, string>,
): boolean {
  if (!isSlackUserId(userId)) return false;
  if (!Array.isArray(update.evidence) || update.evidence.length === 0) return false;
  return update.evidence.every((e) => {
    if (typeof e !== 'string') return false;
    const match = /^msg:([^\s]+)$/.exec(e.trim());
    return match !== null && msgAuthors.get(match[1]) === userId;
  });
}

/**
 * Resolve a non-Slack fallback identifier for a task whose transcript has
 * no Slack mentions. Examples: `cli:<sessionId>`, `cli:<taskId>`. The
 * fallback uses a prefix the Slack namespace cannot produce.
 */
export function resolveFallbackId(metadata: TaskMetadata): UserRef {
  const taskId = metadata.task_id;
  // Future: pull a richer sessionId from CLI channel metadata when one is available.
  const fallbackId = `cli:${taskId}`;
  return { userId: fallbackId, displayName: `cli session (${taskId})` };
}

// ============================================================================
// writeSummary
// ============================================================================

async function writeSummary(
  taskId: string,
  metadata: TaskMetadata,
  result: ExtractionResult,
  users: UserRef[],
  activityIndex: ActivityEntry[],
  related?: ActivityEntry[]
): Promise<void> {
  const path = getSummaryPath(taskId);
  await mkdir(dirname(path), { recursive: true });
  const content = buildSummaryMarkdown(taskId, metadata, result, users, activityIndex, related);
  await writeFile(path, content, 'utf-8');
}

/**
 * Build the content of summary.md.
 *
 * Schema:
 *   - YAML frontmatter (task_id, status, created_at, updated_at, domain,
 *     extraction_at, links, users)
 *   - `# Summary` — sanitized prose from the extractor
 *   - `## Memory Updates` — applied user + entity updates; `_no durable learnings_` when empty
 *   - `## Related Tasks` — up to 5 lexically-similar prior tasks; `_no related tasks found_` when empty
 */
export function buildSummaryMarkdown(
  taskId: string,
  metadata: TaskMetadata,
  result: ExtractionResult,
  users: UserRef[],
  activityIndex: ActivityEntry[] = [],
  related?: ActivityEntry[]
): string {
  const safeSummary = sanitizeTaskSummary(result.task_summary) ?? '_summary omitted: extractor output failed safety validation_';
  const lines: string[] = ['---'];
  lines.push(`task_id: ${taskId}`);
  lines.push(`status: ${metadata.status}`);
  lines.push(`created_at: ${metadata.created_at}`);
  lines.push(`updated_at: ${metadata.updated_at}`);
  lines.push(`domain: ${result.domain}`);
  lines.push(`extraction_at: ${new Date().toISOString()}`);

  // links block
  const links = buildLinksBlock(metadata);
  lines.push('links:');
  lines.push('  slack:');
  for (const l of links.slack) {
    lines.push(`    - channel_id: ${l.channel_id}`);
    lines.push(`      thread_id: "${l.thread_id}"`);
    if (l.url) lines.push(`      url: ${l.url}`);
  }
  lines.push('  github:');
  for (const l of links.github) {
    lines.push(`    - url: ${l.url}`);
  }
  lines.push('  cli:');
  for (const l of links.cli) {
    lines.push(`    - session_id: ${l.session_id}`);
  }

  // users block
  if (users.length > 0) {
    lines.push('users:');
    for (const u of users) {
      lines.push(`  - id: ${u.userId}`);
      lines.push(`    display_name: "${u.displayName.replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('---', '', '# Summary', '', safeSummary, '');

  // Memory Updates section
  lines.push('## Memory Updates', '');
  const memBlock = renderMemoryUpdates(result);
  lines.push(memBlock);

  // Related Tasks section. Caller may pass a precomputed list (e.g. entity-based);
  // otherwise fall back to lexical similarity over the activity index.
  lines.push('', '## Related Tasks', '');
  const relatedTasks = related ?? selectRelatedTasks(result.activity_summary, result.domain, activityIndex, taskId);
  lines.push(renderRelatedTasks(relatedTasks));

  return lines.join('\n') + '\n';
}

// ---- Links block ----

interface LinksBlock {
  slack: Array<{ channel_id: string; thread_id: string; url?: string }>;
  github: Array<{ url: string }>;
  cli: Array<{ session_id: string }>;
}

function buildLinksBlock(metadata: TaskMetadata): LinksBlock {
  const block: LinksBlock = { slack: [], github: [], cli: [] };
  for (const channel of Object.values(metadata.channels)) {
    if (channel.type === 'slack') {
      block.slack.push({
        channel_id: channel.channel_id,
        thread_id: channel.thread_id,
        ...(channel.url ? { url: channel.url } : {}),
      });
    } else if (channel.type === 'github') {
      const repo = (channel as { repo?: string }).repo;
      const prNum = (channel as { pr_number?: number }).pr_number;
      if (repo && prNum) {
        block.github.push({ url: `https://github.com/${repo}/pull/${prNum}` });
      }
    } else if (channel.type === 'cli') {
      block.cli.push({ session_id: metadata.task_id });
    }
  }
  return block;
}

// ---- Memory Updates rendering ----

function renderMemoryUpdates(result: ExtractionResult): string {
  const lines: string[] = [];
  const hasUser = Object.values(result.user_updates).some((u) => u.length > 0);
  const hasEntity = result.entity_updates.length > 0;

  if (!hasUser && !hasEntity) {
    return '_no durable learnings_';
  }

  for (const [userId, updates] of Object.entries(result.user_updates)) {
    if (updates.length === 0) continue;
    lines.push(`### users/${userId}.md`, '');
    for (const u of updates) {
      lines.push(renderUpdateBullet(u));
    }
    lines.push('');
  }

  // Entity pages are the home for organizational knowledge (org.md is retired),
  // so the diff renders each touched entity as its own group.
  for (const e of result.entity_updates) {
    lines.push(`### entities/${e.slug}.md`, '');
    if (e.summary) lines.push(`- **summary** ${e.summary}`);
    for (const o of e.observations ?? []) lines.push(`- **[${o.category}]** ${o.text}`);
    for (const r of e.relations ?? []) lines.push(`- **${r.type}** [[${r.target}]]`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderUpdateBullet(u: MemoryUpdate): string {
  const section = u.section ? `\`## ${u.section}\` › ` : '';
  if (u.action === 'add') {
    return `- **added** ${section}${u.content}`;
  }
  // update
  return `- **updated** ${section}"${u.old ?? '?'}" → "${u.content}"`;
}

// ---- Related Tasks ----

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'as', 'by', 'is', 'was', 'were', 'be', 'been', 'being', 'are', 'am',
  'this', 'that', 'these', 'those', 'it', 'its', 'from', 'into', 'about',
]);

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Filter the activity index to entries in the same domain, score by token overlap
 * with the current activity summary, return the top N (default 5) that clear
 * the minimum overlap threshold (default 2 shared tokens).
 */
export function selectRelatedTasks(
  activitySummary: string,
  domain: string,
  activityIndex: ActivityEntry[],
  excludeTaskId?: string,
  options: { limit?: number; minOverlap?: number } = {}
): ActivityEntry[] {
  const limit = options.limit ?? 5;
  const minOverlap = options.minOverlap ?? 2;
  const target = tokenise(activitySummary);

  const scored = activityIndex
    .filter((e) => e.domain === domain && e.taskId !== excludeTaskId)
    .map((e) => {
      const tokens = tokenise(e.summary);
      let overlap = 0;
      for (const t of target) if (tokens.has(t)) overlap++;
      return { entry: e, overlap };
    })
    .filter((s) => s.overlap >= minOverlap)
    .sort((a, b) => b.overlap - a.overlap);

  // Defensive dedup: even if upstream rows leaked through with the same taskId
  // (e.g., from a pre-fix activity index), only keep the first (highest-scoring)
  // occurrence per task.
  const seen = new Set<string>();
  const unique: ActivityEntry[] = [];
  for (const s of scored) {
    if (seen.has(s.entry.taskId)) continue;
    seen.add(s.entry.taskId);
    unique.push(s.entry);
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * Select related tasks by SHARED ENTITY: other tasks that this task's touched
 * entities are also `touched_by`. Scored by number of co-touched entities,
 * highest first. Returns up to `limit` (default 5). Async — reads the touched
 * entity files. Returns [] when there is no entity overlap, so the caller can
 * fall back to lexical similarity.
 *
 * Only tasks present in the provided activity index are returned — callers
 * pass the org-filtered view, so a co-touching DM/legacy task (row filtered
 * or never written) is dropped entirely: its id and title must not surface in
 * an org-readable summary.
 */
export async function selectRelatedTasksByEntity(
  touchedSlugs: string[],
  currentTaskId: string,
  activityIndex: ActivityEntry[],
  limit = 5
): Promise<ActivityEntry[]> {
  if (touchedSlugs.length === 0) return [];
  const byTask = new Map<string, number>();
  for (const slug of touchedSlugs) {
    const rec = await readEntity(slug);
    if (!rec) continue;
    for (const rel of rec.relations) {
      if (rel.type !== 'touched_by' || rel.target === currentTaskId) continue;
      byTask.set(rel.target, (byTask.get(rel.target) ?? 0) + 1);
    }
  }
  if (byTask.size === 0) return [];

  const indexByTask = new Map(activityIndex.map((e) => [e.taskId, e]));
  const out: ActivityEntry[] = [];
  for (const [taskId] of Array.from(byTask.entries()).sort((a, b) => b[1] - a[1])) {
    const entry = indexByTask.get(taskId);
    if (!entry) continue; // not in the authorized index — never reference it
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

function renderRelatedTasks(related: ActivityEntry[]): string {
  if (related.length === 0) return '_no related tasks found_';
  return related
    .map((e) => `- [${e.taskId}](../${e.taskId}/summary.md) — ${e.summary}${e.domain ? ` (${e.domain})` : ''}`)
    .join('\n');
}
