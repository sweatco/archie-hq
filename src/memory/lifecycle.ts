/**
 * Memory Lifecycle
 *
 * Orchestrates post-task memory extraction. Uses a sequential queue to
 * prevent concurrent writes from corrupting shared memory files.
 */

import { writeFile, mkdir, readdir, rename, rmdir } from 'fs/promises';
import { dirname, join } from 'path';
import {
  isMemoryEnabled,
  getMemoryDir,
  getSummaryPath,
  isSlackUserId,
} from './paths.js';
import { readUser, applyUserUpdatesWithIdentity } from './store.js';
import { runExtraction } from './extractor.js';
import { applyEntityUpdate, listEntities, readEntity } from './entities.js';
import { rebuildIndex, readIndexMarkdown } from './entity-index.js';
import { appendActivity, trimActivity, readActivity } from './activity.js';
import { sanitizeTaskSummary } from './sanitize.js';
import { enqueuePending, dequeuePending } from './pending-queue.js';
import { recordUserUpdateDropped } from './telemetry.js';
import { loadMetadata, readKnowledgeLog } from '../tasks/persistence.js';
import { logger } from '../system/logger.js';
import type { ExtractionResult, UserRef, ActivityEntry, MemoryUpdate } from './types.js';
import type { TaskMetadata } from '../types/task.js';

// ============================================================================
// Housekeeping note queue (consumed by buildSummaryMarkdown)
// ============================================================================
//
// When the housekeeping side-agent consolidates files, it emits a short
// human-readable line ("dropped 3 stale entries, merged 2 duplicates").
// That line gets appended to the *next* completed task's summary so the
// audit trail is in one place. The queue is per-target keyed.

const pendingHousekeepingNotes = new Map<string, string[]>();

/** Record a housekeeping consequence so it shows up in the next summary. */
export function recordHousekeepingNote(target: string, note: string): void {
  const existing = pendingHousekeepingNotes.get(target) ?? [];
  existing.push(note);
  pendingHousekeepingNotes.set(target, existing);
}

/** Drain and return all queued housekeeping notes. Used by buildSummaryMarkdown. */
function drainHousekeepingNotes(): string[] {
  const all: string[] = [];
  for (const notes of pendingHousekeepingNotes.values()) all.push(...notes);
  pendingHousekeepingNotes.clear();
  return all;
}

// ============================================================================
// Sequential extraction queue
// ============================================================================

let extractionQueue: Promise<void> = Promise.resolve();

/**
 * Schedule memory extraction for a completed task.
 * Fire-and-forget; errors are logged but never thrown.
 * Extractions are serialized to avoid concurrent writes to shared memory files.
 */
export function handleTaskCompleted(taskId: string): void {
  if (!isMemoryEnabled()) return;
  // Persist the intent to extract before scheduling. If the process exits
  // before processExtraction completes, the next startup will find the entry
  // and re-schedule.
  extractionQueue = extractionQueue
    .then(() => enqueuePending(taskId))
    .then(() => processExtraction(taskId))
    .then(() => dequeuePending(taskId))
    .catch((err) => logger.warn('memory', `Extraction failed for ${taskId}: ${err}`));
}

/**
 * Schedule extraction without re-enqueuing on disk. Used by startup recovery
 * — the entry is already in pending-extractions.md so we only want to drain.
 */
export function rescheduleTaskCompleted(taskId: string): void {
  if (!isMemoryEnabled()) return;
  extractionQueue = extractionQueue
    .then(() => processExtraction(taskId))
    .then(() => dequeuePending(taskId))
    .catch((err) => logger.warn('memory', `Recovery extraction failed for ${taskId}: ${err}`));
}

// ============================================================================
// processExtraction
// ============================================================================

async function processExtraction(taskId: string): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.warn('memory', `processExtraction: metadata not found for ${taskId}`);
    return;
  }

  // The task boundary is the confidentiality boundary. Private tasks do not
  // contribute collaboration profiles, summaries, activity, or entities. Missing
  // visibility belongs to legacy metadata and therefore fails closed.
  if (metadata.visibility !== 'public') {
    logger.system(`[memory] Extraction skipped for private task ${taskId}`);
    return;
  }

  const transcript = await readKnowledgeLog(taskId);
  if (!transcript.trim()) {
    logger.warn('memory', `processExtraction: empty transcript for ${taskId}`);
    return;
  }

  // Profile writability comes only from actual Slack message authors. A
  // deterministic fallback still labels CLI/self-launched task artifacts, but
  // fallback identities never load or write collaboration profiles.
  const writableUsers = extractAuthorUsers(transcript);
  const users = writableUsers.length > 0 ? writableUsers : [resolveFallbackId(metadata)];

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
    return;
  }

  // Apply profile updates. Use the identity-aware writer so first-touch files
  // get YAML frontmatter (slack_user_id + display_name + aliases).
  // Own-statements enforcement is code-side: an update is applied only when
  // every cited `msg:<ts>` evidence id resolves to a transcript source line
  // authored by that Slack user (at least one citation is required). Fallback
  // and other non-Slack identities fail closed.
  const housekeepingTargets = new Set<string>();
  const appliedUserUpdates: Record<string, MemoryUpdate[]> = {};
  const displayNameById = new Map(writableUsers.map((u) => [u.userId, u.displayName]));
  const msgAuthors = buildMsgAuthorMap(transcript);
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
      const applied = await applyUserUpdatesWithIdentity(userId, displayName, valid);
      if (applied.appliedUpdates.length > 0) {
        appliedUserUpdates[userId] = applied.appliedUpdates;
      }
      if (applied.capExceeded) housekeepingTargets.add(userId);
    }
  }

  // Apply entity updates (resolve-or-create; sanitizer runs inside entities.ts).
  // Each applied update auto-adds a `touched_by [[taskId]]` edge.
  const touchedEntities: string[] = [];
  // Read the entity store once for the whole batch; applyEntityUpdate keeps this
  // array coherent as it creates/updates entities (avoids an O(updates×files)
  // re-read + re-parse on every update).
  const entityRecords = await listEntities();
  for (const update of result.entity_updates) {
    const applied = await applyEntityUpdate(update, taskId, { records: entityRecords });
    if (!applied) continue;
    touchedEntities.push(applied.slug);
    if (applied.capExceeded) housekeepingTargets.add('entities');
  }
  // Rebuild the derived index whenever entities changed.
  if (touchedEntities.length > 0) {
    await rebuildIndex();
  }

  scheduleHousekeeping(housekeepingTargets);

  // Write task summary (rich format) to the public memory store.
  const activityIndex = await readActivity();
  // Related tasks: prefer tasks that share an entity with this one; fall back
  // to lexical similarity over the activity index when there's no entity overlap.
  let related = await selectRelatedTasksByEntity(touchedEntities, taskId, activityIndex);
  if (related.length === 0) {
    related = selectRelatedTasks(result.activity_summary, result.domain, activityIndex, taskId);
  }
  // Summaries expose only profile changes the store confirmed it wrote. Raw
  // extractor candidates, sanitizer drops, and unmatched replacements never
  // enter the public task-summary corpus.
  const summaryResult: ExtractionResult = { ...result, user_updates: appliedUserUpdates };
  await writeSummary(taskId, metadata, summaryResult, users, activityIndex, related);

  // Append to recent activity, then trim.
  const requestingUser = users[0]?.userId ?? 'cli';
  await appendActivity({
    date: metadata.created_at.split('T')[0],
    taskId,
    summary: result.activity_summary,
    domain: result.domain,
    user: requestingUser,
  });
  await trimActivity(50);

  logger.system(`[memory] Extraction complete for ${taskId}`);
}

/**
 * Schedule housekeeping for any target that exceeded its soft cap. The pass
 * is enqueued on the same extractionQueue so it serializes with extraction.
 */
function scheduleHousekeeping(targets: ReadonlySet<string>): void {
  if (targets.size === 0) return;
  for (const target of targets) {
    extractionQueue = extractionQueue.then(async () => {
      const { runHousekeeping } = await import('./housekeeping.js');
      await runHousekeeping(target).catch((err) =>
        logger.warn('memory', `housekeeping for ${target} failed: ${err}`)
      );
    });
  }
}

// ============================================================================
// Evidence validation (own-statements enforcement)
// ============================================================================

// Source lines carry `… | msg:<ts>]` inside the bracketed source slot (see
// appendSlackMessage / appendSlackEdit). Capture the author UID and msg id.
// Both bracket orders: producers now emit `<@UID:Name>`, older logs carry
// `@<UID:Name>` (see MENTION_RE below).
const MSG_ID_LINE_RE = /^\[[^\]]*\] \[(?:@<|<@)([A-Z][A-Z0-9]{6,}):[^>]*>[^\]]*\bmsg:([^\s\]]+)\]/;

/**
 * Map `msg:<ts>` ids to their author user id, from transcript SOURCE lines
 * only. Body framing (persistence.ts formatLogEntry) guarantees body-originated
 * lines are indented and can never match a line-start-anchored source shape.
 * An edit re-logs the same msg id — same author, so last-write is equivalent.
 */
export function buildMsgAuthorMap(transcript: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of transcript.split('\n')) {
    const m = MSG_ID_LINE_RE.exec(line);
    if (m) map.set(m[2], m[1]);
  }
  return map;
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

// ============================================================================
// User identifier parsing
// ============================================================================

// Match a `<UID:Display Name>` user-mention component wherever it appears,
// accepting BOTH bracket orders: the internal `@<UID:Name>` and the Slack-native
// `<@UID:Name>` the model tends to produce (and that producers now emit — see
// restoreMentions in the Slack client). Production log lines often carry extra
// context inside the same outer brackets, e.g.:
//   `[<@U03RQQTE1EF:Riley Quinn> in slack:#<D0AUZLR6ZJQ:DM with Riley Quinn>:...]`
// so we anchor on the `@<`/`<@` prefix, not the surrounding `[...]`. The `@`
// adjacent to the UID is what distinguishes a user mention from a channel
// reference like `#<D0AUZLR6ZJQ:DM with Riley Quinn>` (same `<UID:Name>` shape,
// but `#<` prefix). Non-Slack-shaped IDs are filtered later by isSlackUserId.
const MENTION_RE = /(?:@<|<@)([A-Z][A-Z0-9]{6,}):([^>]+)>/g;

/**
 * Parse all Slack-mention markers from a transcript and return one record
 * per unique user. The raw Slack ID is the canonical filename identifier;
 * the display name is retained for prompt labels and YAML frontmatter.
 *
 * Channel references like `#<D0AUZLR6ZJQ:DM with Riley Quinn>` do NOT match
 * because they lack the `@` prefix. User IDs whose prefix is not Slack-shaped
 * (`U`/`W`/`B`/`T`) are filtered out by `isSlackUserId`.
 */
export function extractUsernames(transcript: string): UserRef[] {
  const seen = new Map<string, string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE.source, 'g');
  while ((match = re.exec(transcript)) !== null) {
    const userId = match[1];
    const displayName = match[2].trim();
    if (isSlackUserId(userId) && !seen.has(userId)) {
      seen.set(userId, displayName || userId);
    }
  }
  return Array.from(seen, ([userId, displayName]) => ({ userId, displayName }));
}

/**
 * Return the first Slack-mention user in the transcript, or null when none.
 */
export function extractRequestingUser(transcript: string): UserRef | null {
  const refs = extractUsernames(transcript);
  return refs[0] ?? null;
}

// Author lines in knowledge.log start with `[timestamp] [<@UID:Name> in …]`
// (appendSlackMessage / appendSlackEdit source format; legacy logs use the
// `[@<UID:Name> …]` bracket order, and the ` in <channel>` suffix is optional
// to tolerate older logs). Only the source position counts — a body @-mention
// never matches because it does not sit in the bracketed source slot at the
// start of an entry line.
const AUTHOR_LINE_RE = /^\[[^\]]*\] \[(?:@<|<@)([A-Z][A-Z0-9]{6,}):([^>]*)>(?: in [^\]]*)?\] /;

/**
 * Parse the users who actually AUTHORED messages in a transcript — the memory
 * ownership set. Unlike `extractUsernames` (any mention anywhere), this scans
 * only entry source lines, so merely being mentioned never makes a user's
 * memory writable or links them to the task's artifacts. Redacted external
 * authors (display name masked to `external` at ingest) are excluded.
 */
export function extractAuthorUsers(transcript: string): UserRef[] {
  const seen = new Map<string, string>();
  for (const line of transcript.split('\n')) {
    const match = AUTHOR_LINE_RE.exec(line);
    if (!match) continue;
    const userId = match[1];
    const displayName = match[2].trim();
    if (!isSlackUserId(userId)) continue;
    if (displayName === 'external') continue; // redacted external author
    if (!seen.has(userId)) seen.set(userId, displayName || userId);
  }
  return Array.from(seen, ([userId, displayName]) => ({ userId, displayName }));
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

/**
 * One-time layout migration: memory/summaries/<taskId>.md →
 * memory/tasks/<taskId>/summary.md. Idempotent — a missing legacy dir is a
 * no-op, non-matching files are left in place, and the legacy dir is removed
 * only once emptied.
 */
export async function migrateLegacySummaries(): Promise<void> {
  const legacyDir = join(getMemoryDir(), 'summaries');
  let entries: string[];
  try {
    entries = await readdir(legacyDir);
  } catch {
    return;
  }
  let moved = 0;
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    let dest: string;
    try {
      dest = getSummaryPath(name.slice(0, -3)); // the real path guard decides validity
    } catch {
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await rename(join(legacyDir, name), dest);
    moved++;
  }
  if (moved > 0) {
    logger.system(`[memory] migrated ${moved} task summaries to memory/tasks/<taskId>/summary.md`);
  }
  try {
    await rmdir(legacyDir);
  } catch {
    // leftover non-summary files — leave the dir for the operator
  }
}

/**
 * Write the per-task summary to workdir/memory/tasks/<taskId>/summary.md.
 * Content schema is the minimum viable shape — the richer "Memory Updates"
 * and "Related Tasks" sections are added by a later pass (§8).
 */
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
  const housekeepingNotes = drainHousekeepingNotes();
  const content = buildSummaryMarkdown(taskId, metadata, result, users, activityIndex, housekeepingNotes, related);
  await writeFile(path, content, 'utf-8');
}

/**
 * Build the content of summary.md.
 *
 * Schema:
 *   - YAML frontmatter (task_id, status, created_at, updated_at, domain,
 *     extraction_at, links, users)
 *   - `# Summary` — sanitized prose from the extractor
 *   - `## Memory Updates` — applied user + entity updates, plus any housekeeping
 *     notes; `_no durable learnings_` when all empty
 *   - `## Related Tasks` — up to 5 lexically-similar prior tasks; `_no related tasks found_` when empty
 */
export function buildSummaryMarkdown(
  taskId: string,
  metadata: TaskMetadata,
  result: ExtractionResult,
  users: UserRef[],
  activityIndex: ActivityEntry[] = [],
  housekeepingNotes: string[] = [],
  related?: ActivityEntry[]
): string {
  const safeSummary = sanitizeTaskSummary(result.task_summary) ?? result.task_summary.slice(0, 2000);
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
  const memBlock = renderMemoryUpdates(result, housekeepingNotes);
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

function renderMemoryUpdates(result: ExtractionResult, housekeepingNotes: string[]): string {
  const lines: string[] = [];
  const hasUser = Object.values(result.user_updates).some((u) => u.length > 0);
  const hasEntity = result.entity_updates.length > 0;

  if (!hasUser && !hasEntity && housekeepingNotes.length === 0) {
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

  if (housekeepingNotes.length > 0) {
    lines.push('### Housekeeping', '');
    for (const note of housekeepingNotes) {
      lines.push(`- **housekeeping** ${note}`);
    }
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
