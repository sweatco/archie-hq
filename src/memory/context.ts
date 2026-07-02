/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readUser } from './store.js';
import { listEntities, serializeEntity } from './entities.js';
import { readIndexMarkdown, renderIndex, selectEntities } from './entity-index.js';
import { isMemoryEnabled, isInjectionEnabled, getRecentActivityPath, getTouchedByInjectMax } from './paths.js';
import { logger } from '../system/logger.js';
import type { UserRef, EntityRecord } from './types.js';

/** Spawn-context selectors used to push the relevant entity pages. */
export interface MemorySelectors {
  repo?: string;
  plugin?: string;
  taskTitle?: string;
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
  if (records.length > 0) {
    const indexMd = (await readIndexMarkdown()).trim() || renderIndex(records).trim();
    if (indexMd) {
      blocks.push(`<entity_index>\n${indexMd}\n</entity_index>`);
    }
    const { selected, dropped } = selectEntities(records, { ...selectors, users: refs });
    if (dropped.length > 0) {
      logger.system(`[memory] entity selection dropped ${dropped.length} over inject cap: ${dropped.join(', ')}`);
    }
    for (const rec of selected) {
      blocks.push(renderEntityBlock(rec));
    }
  }

  return blocks.join('\n\n');
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
