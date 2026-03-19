/**
 * Memory Retrieval & Context Assembly
 *
 * Reads relevant memory files and formats them for injection
 * into agent system prompts.
 */

import { join } from 'path';
import { readdirSync } from 'fs';
import type { ContextParams } from './types.js';
import { readMarkdownFile } from './file-ops.js';

/**
 * Assemble memory context for injection into an agent's system prompt.
 *
 * What each role gets:
 * - pm: org.md + users/{userId}.md + activity.md
 * - repo: org.md
 * - plugin: org.md
 */
export async function assembleContext(
  memoryDir: string,
  params: ContextParams,
): Promise<string> {
  const parts: string[] = [];

  // All roles get org knowledge
  const orgContent = await readMarkdownFile(join(memoryDir, 'org.md'));
  if (orgContent.trim()) {
    parts.push(`<organizational_memory>\n${orgContent.trim()}\n</organizational_memory>`);
  }

  if (params.role === 'pm') {
    // PM gets user preferences
    if (params.userId) {
      const userContent = await findUserFile(memoryDir, params.userId);
      if (userContent) {
        parts.push(`<user_preferences user="${params.userId}">\n${userContent.trim()}\n</user_preferences>`);
      }
    }

    // PM gets recent activity
    const activityContent = await readMarkdownFile(join(memoryDir, 'activity.md'));
    if (activityContent.trim()) {
      parts.push(`<recent_activity>\n${activityContent.trim()}\n</recent_activity>`);
    }

    // Tell PM where to find task summaries
    parts.push(
      `Past task summaries available at: ${join(memoryDir, 'tasks')}/\n` +
      `Use the activity table above to find relevant tasks, then Read specific summaries if needed.`,
    );
  }

  if (parts.length === 0) return '';
  return '\n\nMemory Context:\n' + parts.join('\n\n');
}

/**
 * Find a user file by Slack user ID prefix.
 * User files are named {userId}-{nameSlug}.md in the users/ directory.
 */
async function findUserFile(memoryDir: string, userId: string): Promise<string | null> {
  const usersDir = join(memoryDir, 'users');
  try {
    const files = readdirSync(usersDir);
    const match = files.find((f) => f.startsWith(userId) && f.endsWith('.md'));
    if (match) {
      return readMarkdownFile(join(usersDir, match));
    }
  } catch {
    // users/ directory doesn't exist yet
  }
  return null;
}
