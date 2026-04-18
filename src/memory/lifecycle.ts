/**
 * Memory Lifecycle
 *
 * Orchestrates post-task memory extraction. Uses a sequential queue to
 * prevent concurrent writes from corrupting shared memory files.
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { isMemoryEnabled, getTaskSummaryPath } from './paths.js';
import { readOrg, readUser, applyOrgUpdates, applyUserUpdates } from './store.js';
import { runExtraction } from './extractor.js';
import { appendActivity, trimActivity } from './activity.js';
import { loadMetadata, readKnowledgeLog } from '../tasks/persistence.js';
import { postSlackMessage } from '../connectors/slack/client.js';
import { logger } from '../system/logger.js';
import type { ExtractionResult } from './types.js';
import type { TaskMetadata, SlackChannel, SlackThreadRef } from '../types/task.js';

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
  extractionQueue = extractionQueue.then(() =>
    processExtraction(taskId).catch(err =>
      logger.warn('memory', `Extraction failed for ${taskId}: ${err}`)
    )
  );
}

// ============================================================================
// processExtraction
// ============================================================================

async function processExtraction(taskId: string): Promise<void> {
  // a. Load metadata
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.warn('memory', `processExtraction: metadata not found for ${taskId}`);
    return;
  }

  // b. Read knowledge.log
  const transcript = await readKnowledgeLog(taskId);
  if (!transcript.trim()) {
    logger.warn('memory', `processExtraction: empty transcript for ${taskId}`);
    return;
  }

  // c. Extract usernames from transcript
  const usernames = extractUsernames(transcript);

  // d. Load current memory for extraction input
  const orgMemory = await readOrg();
  const userMemory = usernames.length > 0
    ? await readUser(usernames[0])
    : '';

  // e. Run extraction side-agent
  const result = await runExtraction({
    orgMemory,
    userMemory,
    taskId,
    participants: metadata.participants.join(', '),
    taskOwner: metadata.task_owner ?? '',
    status: metadata.status,
    createdAt: metadata.created_at,
    transcript,
  });

  if (!result) {
    logger.warn('memory', `processExtraction: extraction returned null for ${taskId}`);
    return;
  }

  // f. Apply org updates
  if (result.org_updates.length > 0) {
    await applyOrgUpdates(result.org_updates);
  }

  // g. Apply per-user updates
  for (const [username, updates] of Object.entries(result.user_updates)) {
    if (updates.length > 0) {
      await applyUserUpdates(username, updates);
    }
  }

  // h. Write task summary
  const summaryPath = getTaskSummaryPath(taskId);
  const summaryContent = buildSummaryMarkdown(taskId, metadata, result);
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, summaryContent, 'utf-8');

  // i. Append to recent activity, then trim
  const requestingUser = extractRequestingUser(transcript) || 'cli';
  await appendActivity({
    date: metadata.created_at.split('T')[0],
    taskId,
    summary: result.activity_summary,
    domain: result.domain,
    user: requestingUser,
  });
  await trimActivity(50);

  // j. Post learnings to Slack threads
  await postLearnings(metadata, result);

  logger.system(`[memory] Extraction complete for ${taskId}`);
}

// ============================================================================
// extractUsernames
// ============================================================================

/**
 * Parse all [@<UID:First Last>] patterns from a transcript.
 * Returns unique lowercase first names.
 */
export function extractUsernames(transcript: string): string[] {
  const pattern = /\[@<[A-Z0-9]+:([^\]>]+)>\]/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(transcript)) !== null) {
    const fullName = match[1].trim();
    const firstName = fullName.split(' ')[0].toLowerCase();
    if (firstName) seen.add(firstName);
  }

  return Array.from(seen);
}

// ============================================================================
// extractRequestingUser
// ============================================================================

/**
 * Return the first Slack user mentioned in the transcript (lowercase first name).
 * Returns '' if no mention is found.
 */
export function extractRequestingUser(transcript: string): string {
  const pattern = /\[@<[A-Z0-9]+:([^\]>]+)>\]/;
  const match = pattern.exec(transcript);
  if (!match) return '';
  const fullName = match[1].trim();
  return fullName.split(' ')[0].toLowerCase();
}

// ============================================================================
// buildSummaryMarkdown
// ============================================================================

/**
 * Build the content of summary.md for a completed task.
 */
export function buildSummaryMarkdown(
  taskId: string,
  metadata: TaskMetadata,
  result: ExtractionResult
): string {
  const lines: string[] = [
    '---',
    `task_id: ${taskId}`,
    `status: ${metadata.status}`,
    `created_at: ${metadata.created_at}`,
    `updated_at: ${metadata.updated_at}`,
    `domain: ${result.domain}`,
    '---',
    '',
    result.task_summary,
  ];
  return lines.join('\n') + '\n';
}

// ============================================================================
// postLearnings
// ============================================================================

/**
 * Post a "Learned from this task:" message to all Slack threads associated
 * with the task metadata. Logs a warning on failure (never throws).
 */
export async function postLearnings(
  metadata: TaskMetadata,
  result: ExtractionResult
): Promise<void> {
  const refs: SlackThreadRef[] = Object.values(metadata.channels)
    .filter((ch): ch is SlackChannel => ch.type === 'slack')
    .map(ch => ({
      thread_id: ch.thread_id,
      channel_id: ch.channel_id,
      last_processed_ts: ch.last_processed_ts,
    }));

  if (refs.length === 0) return;

  const message = `📝 Learned from this task:\n${result.activity_summary}`;

  for (const ref of refs) {
    try {
      await postSlackMessage({
        channel: ref.channel_id,
        text: message,
        threadTs: ref.thread_id,
      });
    } catch (err) {
      logger.warn('memory', `postLearnings: failed to post to Slack thread ${ref.channel_id}:${ref.thread_id}: ${err}`);
    }
  }
}
