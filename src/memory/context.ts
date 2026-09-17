/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readUser } from './store.js';
import { listEntities } from './entities.js';
import { renderIndex } from './entity-index.js';
import { isMemoryReady, isInjectionEnabled, isMemoryToolsEnabled, getRecentActivityPath } from './paths.js';
import { logger } from '../system/logger.js';
import type { UserRef } from './types.js';

const ENTITY_CATALOGUE_LIMIT = 4_000;
const ENTITY_TOOL_GUIDANCE = 'The catalogue may be incomplete. Use search_memory to find relevant knowledge and read_entity for details.';

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
): Promise<string> {
  if (!isMemoryReady()) return '';

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

  const records = (await listEntities()).filter((record) => record.status !== 'archived');
  if (records.length > 0) {
    const open = '<entity_index>\n';
    const guidance = isMemoryToolsEnabled() ? `\n\n${ENTITY_TOOL_GUIDANCE}` : '';
    const close = '\n</entity_index>';
    const index = renderIndex(records, ENTITY_CATALOGUE_LIMIT - open.length - guidance.length - close.length).trimEnd();
    if (index) blocks.push(`${open}${index}${guidance}${close}`);
  }

  return blocks.join('\n\n');
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
): Promise<string> {
  if (!isMemoryReady()) {
    return systemPrompt;
  }

  // Injection is gated separately from extraction and defaults off. Bail before
  // any store read so disabled injection costs nothing.
  if (!isInjectionEnabled()) {
    logger.debug('memory', 'injection disabled (ARCHIE_MEMORY_INJECT≠true) — prompt unchanged; extraction unaffected');
    return systemPrompt;
  }

  const memoryContext = await buildMemoryContext(users);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
