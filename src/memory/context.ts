/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readOrg, readUser } from './store.js';
import { isMemoryEnabled, getRecentActivityPath } from './paths.js';

/**
 * Build an XML-tagged memory context string from available memory artifacts.
 *
 * - org.md → <organizational_knowledge> block
 * - per-user files → <user_preferences user="..."> blocks
 * - recent-activity.md → <recent_activity> block
 *
 * Blocks are joined with double newlines. Returns '' when nothing is available.
 */
export async function buildMemoryContext(usernames: string[]): Promise<string> {
  const blocks: string[] = [];

  // Org knowledge
  const orgContent = await readOrg();
  if (orgContent.trim()) {
    blocks.push(`<organizational_knowledge>\n${orgContent.trimEnd()}\n</organizational_knowledge>`);
  }

  // Per-user preferences
  for (const username of usernames) {
    const userContent = await readUser(username);
    if (userContent.trim()) {
      blocks.push(`<user_preferences user="${username}">\n${userContent.trimEnd()}\n</user_preferences>`);
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

  return blocks.join('\n\n');
}

/**
 * Enrich a system prompt with organizational memory context.
 *
 * If memory is disabled or there is no memory content, returns the prompt unchanged.
 * Otherwise appends the context under an "Organizational Memory" header.
 */
export async function enrichPromptWithMemory(
  systemPrompt: string,
  usernames: string[],
): Promise<string> {
  if (!isMemoryEnabled()) {
    return systemPrompt;
  }

  const memoryContext = await buildMemoryContext(usernames);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}
