/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readUser } from './store.js';
import { listEntities, serializeEntity } from './entities.js';
import { readIndexMarkdown, renderIndex, selectEntities, type SelectionResult } from './entity-index.js';
import {
  isMemoryEnabled,
  isInjectionEnabled,
  getRecentActivityPath,
  getTouchedByInjectMax,
  getSessionInjectionLogPath,
  getOrgInjectMax,
  getEntityInjectMax,
} from './paths.js';
import { logger } from '../system/logger.js';
import type { UserRef, EntityRecord } from './types.js';

/** Spawn-context selectors used to push the relevant entity pages. */
export interface MemorySelectors {
  repo?: string;
  plugin?: string;
  taskTitle?: string;
  /** Identify the spawn for the selection sensor; without `taskId` no record is written. */
  taskId?: string;
  agent?: string;
}

/**
 * Build an XML-tagged memory context string from available memory artifacts.
 *
 * - per-user files → <user_preferences user_id="..." display_name="..."> blocks
 * - recent-activity.md → <recent_activity> block
 *
 * `users` is the set of users involved in the current task; if empty, no
 * per-user blocks are emitted. The legacy string-array shape is also accepted
 * for callers that haven't been migrated yet.
 *
 * Blocks are joined with double newlines. Returns '' when nothing is available.
 */
export async function buildMemoryContext(
  users: UserRef[] | string[],
  selectors: MemorySelectors = {},
): Promise<string> {
  const blocks: string[] = [];

  // Per-user preferences
  const refs: UserRef[] = users.map((u) =>
    typeof u === 'string' ? { userId: u, displayName: u } : u
  );
  for (const ref of refs) {
    let userContent: string;
    try {
      userContent = await readUser(ref.userId);
    } catch {
      // Invalid ID shape — skip rather than crash the prompt build
      continue;
    }
    if (userContent.trim()) {
      const display = ref.displayName !== ref.userId ? ` display_name="${escapeAttr(ref.displayName)}"` : '';
      blocks.push(
        `<user_preferences user_id="${escapeAttr(ref.userId)}"${display}>\n${userContent.trimEnd()}\n</user_preferences>`
      );
    }
  }

  // Recent activity
  const activityPath = getRecentActivityPath();
  if (existsSync(activityPath)) {
    const activityContent = await readFile(activityPath, 'utf-8');
    if (activityContent.trim()) {
      blocks.push(`<recent_activity>\n${activityContent.trimEnd()}\n</recent_activity>`);
    }
  }

  // Entity layer: always inject the thin index when any entity exists, then
  // push the full pages selected for this spawn (repo/plugin + users + title).
  const records = await listEntities();
  let selection: SelectionResult | null = null;
  if (records.length > 0) {
    const indexMd = (await readIndexMarkdown()).trim() || renderIndex(records).trim();
    if (indexMd) {
      blocks.push(`<entity_index>\n${indexMd}\n</entity_index>`);
    }
    selection = selectEntities(records, { ...selectors, users: refs });
    if (selection.dropped.length > 0) {
      logger.system(`[memory] entity selection dropped ${selection.dropped.length} over inject cap: ${selection.dropped.join(', ')}`);
    }
    for (const rec of selection.selected) {
      blocks.push(renderEntityBlock(rec));
    }
  }

  const context = blocks.join('\n\n');
  await recordSelection(selectors, refs, selection, context);
  return context;
}

/**
 * Selection sensor: append one JSONL record of this spawn's injection decision
 * to the task's session dir. Fail-safe — never throws, never alters the
 * prompt; skipped without a `taskId` and when injection is off, so the
 * collect-only posture stays write-free.
 */
async function recordSelection(
  selectors: MemorySelectors,
  users: UserRef[],
  selection: SelectionResult | null,
  context: string,
): Promise<void> {
  if (!selectors.taskId || !isInjectionEnabled()) return;
  try {
    const record = {
      v: 1,
      ts: new Date().toISOString(),
      taskId: selectors.taskId,
      agent: selectors.agent ?? null,
      ctx: {
        repo: selectors.repo ?? null,
        plugin: selectors.plugin ?? null,
        taskTitle: selectors.taskTitle ?? null,
        userIds: users.map((u) => u.userId),
      },
      selected: selection?.selectedMeta ?? [],
      dropped: selection?.dropped ?? [],
      zeroSignalExcluded: selection?.zeroSignalExcluded ?? 0,
      candidates: selection?.candidates ?? 0,
      budgets: { org: getOrgInjectMax(), nonOrg: getEntityInjectMax() },
      renderedTokensEst: Math.round(context.length / 4),
    };
    await appendFile(getSessionInjectionLogPath(selectors.taskId), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err: any) {
    logger.warn('memory', `selection sensor write failed (spawn unaffected): ${err?.message ?? err}`);
  }
}

/**
 * Wrap a full entity page in an `<entity ...>` block for prompt injection.
 * Only the newest `touched_by` edges are rendered (they grow one per task);
 * the stored record keeps the full history.
 */
function renderEntityBlock(rec: EntityRecord): string {
  const max = getTouchedByInjectMax();
  const touchedBy = rec.relations.filter((r) => r.type === 'touched_by');
  let view = rec;
  if (touchedBy.length > max) {
    const keep = new Set(touchedBy.slice(touchedBy.length - max));
    view = { ...rec, relations: rec.relations.filter((r) => r.type !== 'touched_by' || keep.has(r)) };
  }
  return `<entity slug="${escapeAttr(rec.entity)}" type="${escapeAttr(rec.type)}" scope="${escapeAttr(rec.scope)}">\n${serializeEntity(view).trimEnd()}\n</entity>`;
}

/**
 * Enrich a system prompt with organizational memory context.
 *
 * Returns the prompt unchanged when:
 * - memory is disabled (`ARCHIE_MEMORY=false`), or
 * - injection is disabled (`ARCHIE_MEMORY_INJECT` ≠ `true`, the default) — the
 *   read path is gated independently of extraction so facts keep accumulating
 *   for evaluation without steering agents; no store reads are performed, or
 * - there is no memory content.
 *
 * Otherwise appends the context under an "Organizational Memory" header.
 */
export async function enrichPromptWithMemory(
  systemPrompt: string,
  users: UserRef[] | string[],
  selectors: MemorySelectors = {},
): Promise<string> {
  if (!isMemoryEnabled()) {
    return systemPrompt;
  }

  // Injection is gated separately from extraction and defaults off. Bail before
  // any store read or entity selection so disabled injection costs nothing.
  if (!isInjectionEnabled()) {
    logger.debug('memory', 'injection disabled (ARCHIE_MEMORY_INJECT≠true) — prompt unchanged; extraction unaffected');
    return systemPrompt;
  }

  const memoryContext = await buildMemoryContext(users, selectors);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
