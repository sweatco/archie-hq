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
import { isMemoryEnabled, getRecentActivityPath } from './paths.js';
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

/** Wrap a full entity page in an `<entity ...>` block for prompt injection. */
function renderEntityBlock(rec: EntityRecord): string {
  return `<entity slug="${escapeAttr(rec.entity)}" type="${escapeAttr(rec.type)}" scope="${escapeAttr(rec.scope)}">\n${serializeEntity(rec).trimEnd()}\n</entity>`;
}

/**
 * Enrich a system prompt with organizational memory context.
 *
 * If memory is disabled or there is no memory content, returns the prompt unchanged.
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

  const memoryContext = await buildMemoryContext(users, selectors);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
